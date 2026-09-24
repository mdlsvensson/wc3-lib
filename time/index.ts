/**
 * Pure calendar and clock helpers: UTC date ↔ Unix seconds conversion, date and countdown
 * formatting, and wrappers that keep simulation time apart from untrusted local wall time.
 * Everything stays inside Warcraft's 32-bit integers until 2038.
 *
 * @example
 * ```ts
 * import { formatDuration, formatUtc, unixToUtc } from "@mdlsvensson/wc3-lib/time";
 *
 * formatDuration(125); // "2:05"
 * formatUtc(unixToUtc(0)!); // "1970-01-01 00:00:00"
 * ```
 *
 * @module
 */

/** Calendar dates are Gregorian UTC, years 1..9999; timestamps use whole Unix seconds. */
export interface UtcDate {
  /** 1..9999. */
  year: number;
  /** 1..12. */
  month: number;
  /** 1..31, valid for the month. */
  day: number;
  /** 0..23. Default 0. */
  hour?: number;
  /** 0..59. Default 0. */
  minute?: number;
  /** 0..59. Default 0. */
  second?: number;
}
/** A `UtcDate` with every time field present. */
export interface UtcDateTime extends UtcDate {
  /** 0..23. */
  hour: number;
  /** 0..59. */
  minute: number;
  /** 0..59. */
  second: number;
}
function integer(n: number, low: number, high: number): boolean { return n >= low && n <= high && Math.floor(n) === n; }
/** Whether `year` (1..9999) is a Gregorian leap year. */
export function isLeapYear(year: number): boolean {
  return integer(year, 1, 9999) && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
function daysBeforeYear(year: number): number {
  const prior = year - 1;
  return prior * 365 + Math.floor(prior / 4) - Math.floor(prior / 100) + Math.floor(prior / 400);
}
function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}
/**
 * Converts a UTC calendar date to whole Unix seconds.
 * Missing time fields default to 0.
 * @returns undefined when any field is out of range or not an integer.
 */
export function utcToUnix(date: UtcDate): number | undefined {
  const hour = date.hour ?? 0; const minute = date.minute ?? 0; const second = date.second ?? 0;
  if (!integer(date.year, 1, 9999) || !integer(date.month, 1, 12) || !integer(date.day, 1, daysInMonth(date.year, date.month)) || !integer(hour, 0, 23) || !integer(minute, 0, 59) || !integer(second, 0, 59)) return undefined;
  let days = daysBeforeYear(date.year) - 719162 + date.day - 1;
  for (let month = 1; month < date.month; month++) days += daysInMonth(date.year, month);
  return days * 86400 + hour * 3600 + minute * 60 + second;
}
/**
 * Converts whole Unix seconds to a UTC date and time (years 1..9999).
 * @returns undefined for non-integers or timestamps outside that range.
 */
export function unixToUtc(seconds: number): UtcDateTime | undefined {
  if (!integer(seconds, -62135596800, 253402300799)) return undefined;
  const day = Math.floor(seconds / 86400);
  let rest = seconds - day * 86400;
  const absoluteDay = day + 719162;
  let low = 1; let high = 10000;
  while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (daysBeforeYear(mid) <= absoluteDay) low = mid; else high = mid; }
  const year = low; let month = 1; let dayOfYear = absoluteDay - daysBeforeYear(year);
  while (dayOfYear >= daysInMonth(year, month)) { dayOfYear -= daysInMonth(year, month); month++; }
  const hour = Math.floor(rest / 3600); rest -= hour * 3600;
  const minute = Math.floor(rest / 60);
  return { year, month, day: dayOfYear + 1, hour, minute, second: rest - minute * 60 };
}
function pad2(n: number): string { return n < 10 ? `0${Math.floor(n)}` : `${Math.floor(n)}`; }

/** 0 = Sunday ... 6 = Saturday, for a valid Unix timestamp; undefined otherwise. */
export function dayOfWeek(seconds: number): number | undefined {
  if (unixToUtc(seconds) === undefined) return undefined;
  // 1970-01-01 was a Thursday (4). Floored modulo keeps negative days in range in JS and Lua.
  const day = Math.floor(seconds / 86400);
  return ((day + 4) % 7 + 7) % 7;
}

/** "YYYY-MM-DD HH:MM:SS" (UTC). */
export function formatUtc(date: UtcDateTime): string {
  const year = `${Math.floor(date.year)}`;
  const padded = year.length >= 4 ? year : `${"000".slice(0, 4 - year.length)}${year}`;
  return `${padded}-${pad2(date.month)}-${pad2(date.day)} ${pad2(date.hour)}:${pad2(date.minute)}:${pad2(date.second)}`;
}

/** Whole-second countdown/stopwatch text: "M:SS", or "H:MM:SS" from one hour. Negative clamps to 0. */
export function formatDuration(seconds: number): string {
  const total = seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total - hours * 3600) / 60);
  const rest = total - hours * 3600 - minutes * 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(rest)}` : `${minutes}:${pad2(rest)}`;
}

/** Consumes a scheduler structurally, without allocating another runtime timer. */
export class SimulationTime {
  /**
   * Wraps a scheduler without owning it.
   * @param scheduler Any object with an `elapsed` seconds property, usually a `Scheduler`.
   */
  constructor(private readonly scheduler: { readonly elapsed: number }) {}
  /** Simulated seconds reported by the scheduler. */
  get elapsed(): number { return this.scheduler.elapsed; }
}
/** A wall-clock reading from this client only. Sync it before it affects shared state. */
export interface LocalTimestamp {
  /** Whole Unix seconds. */
  unixSeconds: number;
  /** Always `"local-untrusted"`: the value came from one client and was not synced. */
  authority: "local-untrusted";
}
/** Optional local source. Never use this directly as authority for shared rewards or expiry. */
export class LocalWallTime {
  /**
   * Wraps an optional clock source.
   * @param source Returns the local wall-clock time in Unix seconds, e.g. `readWarcraftUtc`.
   */
  constructor(private readonly source?: () => number | undefined) {}
  /** Reads the source once. Returns undefined when it is missing, throws, or gives an invalid timestamp. */
  read(): LocalTimestamp | undefined {
    try {
      const seconds = this.source?.();
      return seconds !== undefined && unixToUtc(seconds) !== undefined ? { unixSeconds: seconds, authority: "local-untrusted" } : undefined;
    } catch { return undefined; }
  }
}
