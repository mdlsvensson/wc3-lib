/**
 * Warcraft adapter for the time helpers: `readWarcraftUtc` reads the local clock through
 * `os.date`, since Warcraft's Lua has no `os.time`. The value is local and untrusted.
 *
 * @example
 * ```ts
 * import { LocalWallTime } from "@mdlsvensson/wc3-lib/time";
 * import { readWarcraftUtc } from "@mdlsvensson/wc3-lib/time/warcraft";
 *
 * const wall = new LocalWallTime(readWarcraftUtc);
 * const now = wall.read(); // { unixSeconds, authority: "local-untrusted" } or undefined
 * ```
 *
 * @module
 */

import { utcToUnix } from "./index.ts";

interface DateTable { year: number; month: number; day: number; hour: number; min: number; sec: number }
type OsDate = (this: void, format: string) => DateTable | string | undefined;

/**
 * The local player's UTC clock as Unix seconds, or undefined when unavailable.
 * Warcraft's Lua has os.date but NOT os.time (verified in game), so this reads os.date("!*t")
 * and converts the fields itself, as WCSharp.DateTime does. The value is LOCAL and UNTRUSTED:
 * sync it (WarcraftSyncTransport) before it affects shared state. Fits 32-bit integers until 2038.
 */
export function readWarcraftUtc(): number | undefined {
  try {
    const osDate = (globalThis as unknown as { os?: { date?: OsDate } }).os?.date;
    if (osDate === undefined) return undefined;
    const t = osDate("!*t");
    if (t === undefined || typeof t === "string") return undefined;
    return utcToUnix({ year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.min, second: t.sec });
  } catch { return undefined; }
}
