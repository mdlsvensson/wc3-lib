import { ascii, failure, hexDecode, hexEncode, identifier, integer, integerText, Result } from "./format.ts";

/** The tooltip ability must be reserved by the caller; the generation subsystem must be idle. */
export interface PreloadPort {
  begin(): void;
  emit(line: string): void;
  end(path: string): void;
  clear(): void;
  load(path: string): void;
  getTooltip(ability: number): string | undefined;
  setTooltip(ability: number, text: string): void;
}
/** Explicit binding: merely importing this module does not access natives. */
export function createWarcraftPreloadPort(): PreloadPort {
  return {
    begin: () => PreloadGenStart(), emit: line => Preload(line), end: path => PreloadGenEnd(path),
    clear: () => PreloadGenClear(), load: path => Preloader(path),
    getTooltip: ability => BlzGetAbilityTooltip(ability, 0),
    setTooltip: (ability, text) => BlzSetAbilityTooltip(ability, text, 0),
  };
}
let preloadBusy = false;
/** Hex characters per Preload line. */
const CHUNK = 180;
export interface LocalWriteReceipt { status: "issued-unverified"; }
/** Optional client-local transport. Successful native calls do not prove disk capability.
 * Preloader executes the file through the engine. Only use this namespace for files written
 * by this adapter; a modified preload file cannot be sandboxed by the save-code validator.
 * Read results remain local until the caller sends and validates them through sync.
 */
export class PreloadLocalStore {
  private disposed = false;
  constructor(private readonly namespace: string, private readonly ability: number, private readonly port?: PreloadPort, private readonly maxPayload = 4096) {
    if (!identifier(namespace, 32) || !integer(ability, 1, 2147483647) || !integer(maxPayload, 1, 8192)) throw new Error("Invalid local storage configuration");
  }
  private path(slot: string): string | undefined {
    return identifier(slot, 32) ? `${this.namespace}\\${slot}.pld` : undefined;
  }
  write(slot: string, code: string): Result<LocalWriteReceipt> {
    const path = this.path(slot);
    if (!path || code.length === 0 || code.length > this.maxPayload || !ascii(code)) return failure("input");
    if (this.disposed) return failure("disposed");
    if (!this.port) return failure("unsupported");
    if (preloadBusy) return failure("busy");
    // No `finally` in Lua-bound code: TSTL 1.31 swallows errors thrown inside try/finally.
    preloadBusy = true;
    let failed = false;
    try {
      // PreloadGenStart does not flush lines buffered by earlier Preload calls (including the
      // engine's own preload generation); clear first so only our payload reaches disk.
      this.port.clear();
      this.port.begin();
      // JASS preload-generator framing; payload uses only hex digits, never executable input.
      // Lines are kept short because Preload truncates long strings; later lines append to
      // the tooltip. The limit is unverified in-engine, so CHUNK stays far below known values.
      const hex = hexEncode(code);
      const abilityText = integerText(this.ability); // Never "1093677104.0" inside JASS.
      this.port.emit(`\")
call BlzSetAbilityTooltip(${abilityText}, \"W3L1${hex.slice(0, CHUNK)}\", 0)
//`);
      for (let at = CHUNK; at < hex.length; at += CHUNK) {
        this.port.emit(`\")
call BlzSetAbilityTooltip(${abilityText}, BlzGetAbilityTooltip(${abilityText}, 0) + \"${hex.slice(at, at + CHUNK)}\", 0)
//`);
      }
      this.port.end(path);
    } catch { failed = true; }
    try { this.port.clear(); } catch { failed = true; }
    preloadBusy = false;
    return failed ? failure("native-failed") : { ok: true, value: { status: "issued-unverified" } };
  }
  read(slot: string): Result<string> {
    const path = this.path(slot);
    if (!path) return failure("input");
    if (this.disposed) return failure("disposed");
    if (!this.port) return failure("unsupported");
    if (preloadBusy) return failure("busy");
    preloadBusy = true;
    let result: Result<string>;
    try { result = this.readLocked(this.port, path); } catch { result = failure("native-failed"); }
    preloadBusy = false;
    return result;
  }
  private readLocked(port: PreloadPort, path: string): Result<string> {
    const original = port.getTooltip(this.ability);
    if (original === undefined) return failure("unsupported-tooltip");
    let loaded: string | undefined;
    let failed = false;
    try {
      port.setTooltip(this.ability, "W3LOCAL_PENDING");
      port.load(path);
      loaded = port.getTooltip(this.ability);
    } catch { failed = true; }
    // Always restore the borrowed tooltip, whatever happened above.
    try { port.setTooltip(this.ability, original); } catch { failed = true; }
    if (failed) return failure("native-failed");
    if (loaded === undefined || loaded === "W3LOCAL_PENDING") return failure("unavailable");
    if (loaded.slice(0, 4) !== "W3L1" || loaded.length > 4 + this.maxPayload * 2) return failure("invalid-content");
    const code = hexDecode(loaded.slice(4));
    return code === undefined || code.length === 0 ? failure("invalid-content") : { ok: true, value: code };
  }
  dispose(): void { this.disposed = true; }
}
