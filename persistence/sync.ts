import { ascii, failure, identifier, integer, Result, unsigned } from "./format.ts";
const chunkLength = 160;
const maximumCode = 8192;

/** ASCII wire packets stay below 200 bytes. Session identifiers must be allocated by shared policy. */
export function chunkSaveCode(session: string, code: string): string[] {
  if (!identifier(session, 16) || code.length < 1 || code.length > maximumCode || !ascii(code)) throw new Error("Invalid sync payload");
  const count = Math.ceil(code.length / chunkLength); const packets: string[] = [];
  for (let index = 0; index < count; index++) packets.push(`${session}:${index}:${count}:${code.slice(index * chunkLength, (index + 1) * chunkLength)}`);
  return packets;
}
export interface SyncLimits { maxCodeLength?: number; maxPending?: number; ttlSeconds?: number; }
interface Pending { sender: number; session: string; expires: number; count: number; received: number; length: number; chunks: Map<number, string>; }
/** Only explicitly expected sender/session pairs can allocate incoming chunks.
 * Use deterministic simulation elapsed seconds on every client; authorization is not anti-cheat.
 */
export class SyncReceiver {
  private readonly pending = new Map<string, Pending>();
  private readonly maxCodeLength: number;
  private readonly maxPending: number;
  private readonly ttlSeconds: number;
  private now = 0;
  private disposed = false;
  constructor(limits: SyncLimits = {}) {
    this.maxCodeLength = limits.maxCodeLength ?? maximumCode;
    this.maxPending = limits.maxPending ?? 8;
    this.ttlSeconds = limits.ttlSeconds ?? 15;
    if (!integer(this.maxCodeLength, 1, maximumCode) || !integer(this.maxPending, 1, 32) || !(this.ttlSeconds > 0 && this.ttlSeconds <= 300)) throw new Error("Invalid sync limits");
  }
  private validTime(now: number): boolean { return now >= this.now && now <= 1e12; }
  update(now: number): void {
    if (!this.validTime(now)) throw new Error("Sync clock must be finite and monotonic");
    this.now = now;
    for (const [key, request] of this.pending) if (request.expires <= now) this.pending.delete(key);
  }
  expect(sender: number, session: string, now: number): Result<undefined> {
    if (this.disposed) return failure("disposed");
    if (!integer(sender, 0, 23) || !identifier(session, 16) || !this.validTime(now)) return failure("input");
    this.update(now);
    const key = `${sender}:${session}`;
    if (this.pending.has(key)) return failure("already-pending");
    if (this.pending.size >= this.maxPending) return failure("pending-limit");
    this.pending.set(key, { sender, session, expires: now + this.ttlSeconds, count: 0, received: 0, length: 0, chunks: new Map() });
    return { ok: true, value: undefined };
  }
  cancel(sender: number, session: string): void { this.pending.delete(`${sender}:${session}`); }
  accept(sender: number, packet: string, now: number): Result<string | undefined> {
    if (this.disposed) return failure("disposed");
    if (!integer(sender, 0, 23) || !this.validTime(now)) return failure("input");
    this.update(now);
    if (packet.length > 200 || !ascii(packet)) return failure("packet");
    const first = packet.indexOf(":"); const second = packet.indexOf(":", first + 1); const third = packet.indexOf(":", second + 1);
    if (first < 1 || second < 0 || third < 0) return failure("packet");
    const session = packet.slice(0, first);
    if (!identifier(session, 16)) return failure("session");
    const key = `${sender}:${session}`; const request = this.pending.get(key);
    if (!request) return failure("unauthorized");
    const index = unsigned(packet.slice(first + 1, second), 51);
    const count = unsigned(packet.slice(second + 1, third), Math.ceil(this.maxCodeLength / chunkLength));
    const payload = packet.slice(third + 1);
    if (index === undefined || count === undefined || count < 1 || index >= count || payload.length < 1 || payload.length > chunkLength || (index < count - 1 && payload.length !== chunkLength) || index * chunkLength + payload.length > this.maxCodeLength) return failure("packet");
    if (request.count !== 0 && request.count !== count) { this.pending.delete(key); return failure("conflicting-count"); }
    request.count = count;
    const previous = request.chunks.get(index);
    if (previous !== undefined) {
      if (previous !== payload) { this.pending.delete(key); return failure("conflicting-duplicate"); }
      return { ok: true, value: undefined };
    }
    request.chunks.set(index, payload); request.received++; request.length += payload.length;
    if (request.length > this.maxCodeLength) { this.pending.delete(key); return failure("size"); }
    if (request.received < count) return { ok: true, value: undefined };
    let code = "";
    for (let i = 0; i < count; i++) code += request.chunks.get(i)!;
    this.pending.delete(key);
    return { ok: true, value: code };
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.pending.clear(); }
}

export interface WarcraftSyncPort {
  subscribe(prefix: string, players: readonly number[], receive: (sender: number, data: string) => void): () => void;
  send(prefix: string, data: string): boolean;
  isLocalSender(sender: number): boolean;
}
/** The callback receives the actual engine event sender, never a sender claimed in wire data. */
export function createWarcraftSyncPort(): WarcraftSyncPort {
  return {
    subscribe: (prefix, players, receive) => {
      const nativeTrigger = CreateTrigger();
      try {
        for (const id of players) {
          const player = Player(id);
          if (!player || !BlzTriggerRegisterPlayerSyncEvent(nativeTrigger, player, prefix, false)) throw new Error("Sync registration failed");
        }
        const action = TriggerAddAction(nativeTrigger, () => {
          const sender = GetTriggerPlayer(); const data = BlzGetTriggerSyncData();
          if (sender && data !== undefined) receive(GetPlayerId(sender), data);
        });
        let disposed = false;
        return () => { if (disposed) return; disposed = true; try { TriggerRemoveAction(nativeTrigger, action); } catch (error) { DestroyTrigger(nativeTrigger); throw error; } DestroyTrigger(nativeTrigger); };
      } catch (error) { DestroyTrigger(nativeTrigger); throw error; }
    },
    send: (prefix, data) => BlzSendSyncData(prefix, data),
    isLocalSender: sender => { const player = Player(sender); return player !== undefined && GetLocalPlayer() === player; },
  };
}
/** Start and authorize on all clients. Only send touches a local-player branch.
 * Completion yields untrusted text; call SaveCodec.decode and game policy before applying it.
 */
export class WarcraftSyncTransport {
  private stop?: () => void;
  private disposed = false;
  private readonly players: number[];
  constructor(private readonly prefix: string, players: readonly number[], private readonly receiver: SyncReceiver,
    private readonly now: () => number, private readonly onCode: (sender: number, code: string) => void,
    private readonly port: WarcraftSyncPort = createWarcraftSyncPort(), private readonly onRejected?: (sender: number, error: string) => void) {
    if (!identifier(prefix, 16) || players.length < 1 || players.length > 24) throw new Error("Invalid sync configuration");
    const seen = new Set<number>();
    for (const player of players) { if (!integer(player, 0, 23) || seen.has(player)) throw new Error("Invalid sync players"); seen.add(player); }
    this.players = [...players];
  }
  start(): void {
    if (this.disposed) throw new Error("Sync transport disposed");
    if (this.stop) return;
    this.stop = this.port.subscribe(this.prefix, this.players, (sender, packet) => {
      if (this.disposed) return;
      if (this.players.indexOf(sender) < 0) { this.onRejected?.(sender, "sender"); return; }
      const result = this.receiver.accept(sender, packet, this.now());
      if (!result.ok) this.onRejected?.(sender, result.error);
      else if (result.value !== undefined) this.onCode(sender, result.value);
    });
  }
  send(sender: number, session: string, code: string): Result<undefined> {
    if (this.disposed || !this.stop) return failure("inactive");
    if (this.players.indexOf(sender) < 0 || !this.port.isLocalSender(sender)) return failure("not-local-sender");
    try {
      const packets = chunkSaveCode(session, code);
      for (const packet of packets) if (!this.port.send(this.prefix, packet)) return failure("send-failed");
      return { ok: true, value: undefined };
    } catch { return failure("send-failed"); }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const stop = this.stop; this.stop = undefined;
    try { stop?.(); } catch (error) { this.receiver.dispose(); throw error; }
    this.receiver.dispose();
  }
}
