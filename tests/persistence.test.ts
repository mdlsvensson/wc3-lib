import { strict as assert } from "node:assert";
import { SaveCodec, type SaveSchema } from "../persistence/codec.ts";
import { integerText } from "../persistence/format.ts";
import { PreloadLocalStore, type PreloadPort } from "../persistence/local-file.ts";
import { SyncReceiver, chunkSaveCode, WarcraftSyncTransport } from "../persistence/sync.ts";

const schema: SaveSchema = { version: 1, fields: [
  { key: "level", kind: "number", min: 0, max: 100, integer: true },
  { key: "name", kind: "string", maxLength: 32 },
  { key: "unlocked", kind: "boolean" },
] };
const data = { level: 42, name: 'A:;"\\hero', unlocked: true };
function codeOf(codec: SaveCodec, value = data): string {
  const r = codec.encode(value); if (!r.ok) throw Error(r.error); return r.value;
}
Deno.test("save codes round trip without disk and reject corruption, truncation and trailing bytes", () => {
  const codec = new SaveCodec(1, [schema]); const code = codeOf(codec);
  assert.deepEqual(codec.decode(code), { ok: true, value: data });
  for (const bad of [code.slice(0, -1), code + "0", code.slice(0, 10) + "G" + code.slice(11), "", "x".repeat(9000)]) {
    assert.equal(codec.decode(bad).ok, false);
  }
  const changed = code.slice(0, 12) + (code[12] === "0" ? "1" : "0") + code.slice(13);
  assert.equal(codec.decode(changed).ok, false);
});
Deno.test("schema bounds and migration results are validated", () => {
  const codec = new SaveCodec(1, [schema]);
  for (const bad of [{ ...data, level: 101 }, { ...data, level: NaN }, { ...data, level: 0.1 },
    { ...data, name: "x".repeat(33) }, { ...data, name: "é" }, { ...data, extra: 1 }, { level: 3 }]) {
    assert.equal(codec.encode(bad).ok, false);
  }
  const next: SaveSchema = { version: 2, fields: [...schema.fields, { key: "wins", kind: "number", min: 0, max: 99, integer: true }] };
  const migrated = new SaveCodec(2, [{ ...schema, migrate: value => ({ ...value, wins: 3 }) }, next]);
  assert.deepEqual(migrated.decode(codeOf(codec)), { ok: true, value: { ...data, wins: 3 } });
  const invalid = new SaveCodec(2, [{ ...schema, migrate: value => ({ ...value, wins: -1 }) }, next]);
  assert.equal(invalid.decode(codeOf(codec)).ok, false);
  assert.equal(new SaveCodec(2, [schema, next]).decode(codeOf(codec)).ok, false);
  assert.throws(() => new SaveCodec(1, [{ ...schema, fields: [...schema.fields, schema.fields[0]] }]));
});
Deno.test("preload storage constrains paths, writes encoded content and restores tooltip after load/failure", () => {
  let tooltip = "Original tooltip"; let emitted = ""; let target = ""; let clears = 0; let fail = false;
  const port: PreloadPort = {
    begin: () => {}, emit: line => { emitted = line; }, end: path => { target = path; }, clear: () => { clears++; },
    getTooltip: () => tooltip, setTooltip: (_ability, text) => { tooltip = text; },
    load: () => { tooltip = "W3L141423a22"; if (fail) throw Error("native failed"); },
  };
  const store = new PreloadLocalStore("MyMap", 1234, port);
  assert.equal(store.write("../bad", "abc").ok, false);
  assert.equal(store.write("hero", 'AB:"').ok, true);
  assert.equal(target, "MyMap\\hero.pld");
  assert.ok(emitted.includes('call BlzSetAbilityTooltip(1234, "W3L141423a22", 0)'));
  assert.equal(clears, 2); // stale-buffer clear before begin + cleanup clear after end
  assert.deepEqual(store.read("hero"), { ok: true, value: 'AB:"' });
  assert.equal(tooltip, "Original tooltip");
  fail = true; assert.equal(store.read("hero").ok, false); assert.equal(tooltip, "Original tooltip");
  assert.equal(new PreloadLocalStore("MyMap", 1234).read("hero").ok, false);
  store.dispose(); store.dispose(); assert.equal(store.read("hero").ok, false);
});
Deno.test("preload generation cleanup survives native failure and missing or malicious output is rejected", () => {
  let tooltip = "original"; let clears = 0;
  const port: PreloadPort = {
    begin: () => {}, emit: () => { throw Error("write failed"); }, end: () => {}, clear: () => { clears++; },
    getTooltip: () => tooltip, setTooltip: (_id, text) => { tooltip = text; }, load: () => {},
  };
  const store = new PreloadLocalStore("Map", 12, port, 16);
  assert.equal(store.write("slot", "ok").ok, false); assert.equal(clears, 2);
  assert.equal(store.write("slot", "x".repeat(17)).ok, false);
  assert.equal(store.read("slot").ok, false); assert.equal(tooltip, "original");
  port.load = () => { tooltip = 'W3L1");evil()'; };
  assert.equal(store.read("slot").ok, false); assert.equal(tooltip, "original");
});
Deno.test("sync receiver requires sender/session authorization, reassembles out of order and rejects replay", () => {
  const receiver = new SyncReceiver(); const code = "A".repeat(400); const packets = chunkSaveCode("request1", code);
  assert.equal(receiver.accept(2, packets[0], 0).ok, false);
  assert.equal(receiver.expect(1, "request1", 0).ok, true);
  assert.equal(receiver.accept(2, packets[0], 0).ok, false);
  assert.deepEqual(receiver.accept(1, packets[2], 0), { ok: true, value: undefined });
  assert.deepEqual(receiver.accept(1, packets[2], 0), { ok: true, value: undefined });
  receiver.accept(1, packets[0], 0);
  assert.deepEqual(receiver.accept(1, packets[1], 0), { ok: true, value: code });
  assert.equal(receiver.accept(1, packets[0], 0).ok, false);
});
Deno.test("sync transport bounds pending state, rejects conflicts and expires incomplete chunks", () => {
  const receiver = new SyncReceiver({ maxCodeLength: 400, maxPending: 1, ttlSeconds: 5 });
  const packets = chunkSaveCode("s", "A".repeat(200));
  receiver.expect(1, "s", 0); assert.equal(receiver.expect(2, "x", 0).ok, false);
  receiver.accept(1, packets[0], 1);
  assert.equal(receiver.accept(1, packets[0].slice(0, -1) + "B", 1).ok, false);
  assert.equal(receiver.accept(1, packets[1], 1).ok, false);
  receiver.expect(1, "s", 2); receiver.update(7);
  assert.equal(receiver.accept(1, packets[0], 7).ok, false);
  receiver.expect(1, "s", 7);
  for (const bad of ["s:0:999:A", "s:0:0:A", "s:0:2:" + "A".repeat(161), "s:1:2:", "s:00:2:A"]) {
    assert.equal(receiver.accept(1, bad, 7).ok, false);
  }
  assert.throws(() => chunkSaveCode("../", "abc"));
  assert.throws(() => chunkSaveCode("s", "A".repeat(8193)));
  receiver.dispose(); receiver.dispose(); assert.equal(receiver.expect(1, "s", 8).ok, false);
});
Deno.test("Warcraft sync bridge starts explicitly, validates native sender and cleans subscription", () => {
  const received: string[] = []; const sent: string[] = []; let callback: ((sender: number, data: string) => void) | undefined;
  let stops = 0; let starts = 0; const receiver = new SyncReceiver();
  const bridge = new WarcraftSyncTransport("SAVE", [1], receiver, () => 0, (_sender, value) => received.push(value), {
    subscribe: (_prefix, _players, cb) => { starts++; callback = cb; return () => { stops++; }; },
    send: (_prefix, value) => { sent.push(value); return true; }, isLocalSender: id => id === 1,
  });
  assert.equal(starts, 0); bridge.start(); bridge.start(); assert.equal(starts, 1);
  receiver.expect(1, "s", 0);
  assert.equal(bridge.send(2, "s", "hello").ok, false);
  assert.equal(bridge.send(1, "s", "hello").ok, true);
  callback!(2, sent[0]); assert.deepEqual(received, []);
  callback!(1, sent[0]); assert.deepEqual(received, ["hello"]);
  bridge.dispose(); bridge.dispose(); assert.equal(stops, 1);
});

Deno.test("codec rejects inherited fields and extra fields with the same apparent field count", () => {
  const codec = new SaveCodec(1, [schema]);
  const inherited = Object.assign(Object.create({ level: 42 }), { name: "hero", unlocked: true, extra: 1 });
  assert.equal(codec.encode(inherited).ok, false);
});
Deno.test("sync cancellation drops state and configured player filtering rejects unexpected native senders", () => {
  const receiver = new SyncReceiver();
  receiver.expect(1, "s", 0); receiver.cancel(1, "s");
  assert.equal(receiver.accept(1, "s:0:1:A", 0).ok, false);
  const received: string[] = []; let callback: ((sender: number, value: string) => void) | undefined;
  const bridge = new WarcraftSyncTransport("SAVE", [1], receiver, () => 0, (_sender, value) => received.push(value), {
    subscribe: (_prefix, _players, cb) => { callback = cb; return () => {}; }, send: () => true, isLocalSender: () => true,
  });
  bridge.start(); receiver.expect(2, "s", 0); callback!(2, "s:0:1:A");
  assert.deepEqual(received, []);
  bridge.dispose();
});

Deno.test("concrete Warcraft preload binding clears stale generation input and restores native tooltip", async () => {
  const { createWarcraftPreloadPort } = await import("../persistence/local-file.ts");
  const native = globalThis as unknown as Record<string, unknown>;
  const old = new Map<string, unknown>(); let tooltip = "native original"; const calls: string[] = [];
  const replacements: Record<string, unknown> = {
    PreloadGenClear: () => calls.push("clear"), PreloadGenStart: () => calls.push("begin"),
    Preload: (line: string) => { assert.ok(line.includes('"W3L14142"')); calls.push("emit"); },
    PreloadGenEnd: (path: string) => { assert.equal(path, "Map\\slot.pld"); calls.push("end"); },
    Preloader: () => { tooltip = "W3L14142"; },
    BlzGetAbilityTooltip: (ability: number, level: number) => { assert.equal(ability, 1234); assert.equal(level, 0); return tooltip; },
    BlzSetAbilityTooltip: (ability: number, text: string, level: number) => { assert.equal(ability, 1234); assert.equal(level, 0); tooltip = text; },
  };
  for (const key of Object.keys(replacements)) { old.set(key, native[key]); native[key] = replacements[key]; }
  try {
    const store = new PreloadLocalStore("Map", 1234, createWarcraftPreloadPort());
    assert.equal(store.write("slot", "AB").ok, true);
    assert.deepEqual(calls, ["clear", "begin", "emit", "end", "clear"]);
    assert.deepEqual(store.read("slot"), { ok: true, value: "AB" }); assert.equal(tooltip, "native original");
  } finally { for (const [key, value] of old) { if (value === undefined) delete native[key]; else native[key] = value; } }
});
Deno.test("concrete Warcraft sync binding uses event sender and releases trigger on registration failure", async () => {
  const { createWarcraftSyncPort } = await import("../persistence/sync.ts");
  const native = globalThis as unknown as Record<string, unknown>; const old = new Map<string, unknown>();
  const player = { id: 1 }; const trigger = {}; const action = {}; let callback: (() => void) | undefined;
  let destroyed = 0; let removed = 0; let fail = false;
  const replacements: Record<string, unknown> = {
    Player: (id: number) => id === 1 ? player : undefined,
    CreateTrigger: () => trigger, DestroyTrigger: (value: unknown) => { assert.equal(value, trigger); destroyed++; },
    BlzTriggerRegisterPlayerSyncEvent: (t: unknown, p: unknown, prefix: string, server: boolean) => {
      assert.equal(t, trigger); assert.equal(p, player); assert.equal(prefix, "SAVE"); assert.equal(server, false); return fail ? undefined : {};
    },
    TriggerAddAction: (_t: unknown, cb: () => void) => { callback = cb; return action; },
    TriggerRemoveAction: (t: unknown, a: unknown) => { assert.equal(t, trigger); assert.equal(a, action); removed++; },
    GetTriggerPlayer: () => player, GetPlayerId: (p: unknown) => { assert.equal(p, player); return 1; },
    BlzGetTriggerSyncData: () => "s:0:1:A", GetLocalPlayer: () => player,
    BlzSendSyncData: (prefix: string, packet: string) => prefix === "SAVE" && packet === "s:0:1:A",
  };
  for (const key of Object.keys(replacements)) { old.set(key, native[key]); native[key] = replacements[key]; }
  try {
    const port = createWarcraftSyncPort(); const received: unknown[] = [];
    const stop = port.subscribe("SAVE", [1], (sender, packet) => received.push([sender, packet]));
    callback!(); assert.deepEqual(received, [[1, "s:0:1:A"]]);
    assert.equal(port.send("SAVE", "s:0:1:A"), true); assert.equal(port.isLocalSender(1), true); assert.equal(port.isLocalSender(2), false);
    stop(); stop(); assert.equal(destroyed, 1); assert.equal(removed, 1);
    fail = true; assert.throws(() => port.subscribe("SAVE", [1], () => {})); assert.equal(destroyed, 2);
  } finally { for (const [key, value] of old) { if (value === undefined) delete native[key]; else native[key] = value; } }
});

Deno.test("integers are written exactly and codes can be bound to a player", () => {
  assert.equal(integerText(0), "0");
  assert.equal(integerText(-42), "-42");
  assert.equal(integerText(2147483647), "2147483647");
  assert.throws(() => integerText(2147483648)); // Past Warcraft's 32-bit integers.
  assert.throws(() => new SaveCodec(1, [{ version: 1, fields: [{ key: "x", kind: "number", min: 0, max: 1e15 }] }]));
  const big = new SaveCodec(1, [{ version: 1, fields: [{ key: "gold", kind: "number", min: 0, max: 2147483647, integer: true }] }]);
  const encoded = big.encode({ gold: 2147483647 }, "Arthas#1234");
  assert.ok(encoded.ok);
  if (!encoded.ok) return;
  assert.deepEqual(big.decode(encoded.value, "Arthas#1234"), { ok: true, value: { gold: 2147483647 } });
  assert.deepEqual(big.decode(encoded.value, "Jaina#5678"), { ok: false, error: "checksum" });
  assert.deepEqual(big.decode(encoded.value), { ok: false, error: "checksum" });
});

Deno.test("long local payloads are written as short appending preload lines", () => {
  const lines: string[] = [];
  let tooltip = "";
  const port: PreloadPort = {
    begin: () => {}, emit: line => { lines.push(line); }, end: () => {}, clear: () => {},
    // Simulate the engine: run every line's tooltip statement in order.
    load: () => {
      for (const line of lines) {
        const first = /BlzSetAbilityTooltip\(1234, "([0-9A-Za-z]*)", 0\)/.exec(line);
        const append = /BlzGetAbilityTooltip\(1234, 0\) \+ "([0-9a-f]*)"/.exec(line);
        if (first) tooltip = first[1]; else if (append) tooltip += append[1];
      }
    },
    getTooltip: () => tooltip, setTooltip: (_, text) => { tooltip = text; },
  };
  const store = new PreloadLocalStore("MyMap", 1234, port);
  const code = "x".repeat(500);
  assert.ok(store.write("slot", code).ok);
  assert.equal(lines.length, Math.ceil(1000 / 180));
  for (const line of lines) assert.ok(line.length < 260, "line of " + line.length + " characters");
  assert.deepEqual(store.read("slot"), { ok: true, value: code });
});
