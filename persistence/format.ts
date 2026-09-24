/** Shared result and ASCII framing utilities, deliberately independent of JS-only APIs. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export function failure<T>(error: string): Result<T> { return { ok: false, error }; }
export function integer(value: number, min: number, max: number): boolean {
  return value >= min && value <= max && Math.floor(value) === value;
}
export function ascii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 32 || c > 126) return false;
  }
  return true;
}
export function identifier(value: string, max = 32): boolean {
  if (value.length < 1 || value.length > max) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (!(c >= 48 && c <= 57) && !(c >= 65 && c <= 90) && !(c >= 97 && c <= 122) && c !== 95 && c !== 45) return false;
  }
  return true;
}
/**
 * Warcraft's Lua is built with 32-bit numbers: integers wrap past 2^31-1 and floats have a
 * 24-bit mantissa (exact integers only up to 16,777,216). Verified in game by -selftest.
 */
export const MAX_INT = 2147483647;
export function unsigned(value: string, max: number): number | undefined {
  if (value.length === 0 || value.length > 10 || (value.length > 1 && value.charAt(0) === "0")) return undefined;
  let result = 0;
  for (let i = 0; i < value.length; i++) {
    const digit = value.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return undefined;
    // Stop before result * 10 + digit could pass 2^31-1: Warcraft's 32-bit integers would wrap.
    if (result > 214748364 || (result === 214748364 && digit > 7)) return undefined;
    result = result * 10 + digit;
    if (result > max) return undefined;
  }
  return result;
}
const hexDigits = "0123456789abcdef";
/** True for "0".."9" at index i. Uses byte codes: Lua compares strings with the C locale's strcoll. */
export function isDigitAt(value: string, i: number): boolean {
  const c = value.charCodeAt(i);
  return c >= 48 && c <= 57;
}
const luaString = (globalThis as unknown as { string?: { format: (this: void, pattern: string, value: number) => string } }).string;
/**
 * Exact decimal text for an integer in Warcraft's 32-bit range. TSTL's String(x) is Lua tostring,
 * which prints integer-valued floats as "3.0". In Lua this uses string.format("%d"), because digit
 * arithmetic on 32-bit floats loses precision above 2^24.
 */
export function integerText(value: number): string {
  if (Math.floor(value) !== value || value < -MAX_INT || value > MAX_INT) throw new Error("integerText needs a 32-bit integer");
  if (luaString !== undefined) return luaString.format("%d", value);
  if (value === 0) return "0";
  let rest = value < 0 ? -value : value;
  let text = "";
  while (rest > 0) {
    const digit = rest % 10;
    text = hexDigits.charAt(digit) + text;
    rest = (rest - digit) / 10;
  }
  return value < 0 ? `-${text}` : text;
}
export function hexEncode(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    result += hexDigits.charAt(Math.floor(code / 16)) + hexDigits.charAt(code % 16);
  }
  return result;
}
export function hexDecode(value: string): string | undefined {
  if (value.length % 2 !== 0) return undefined;
  let result = "";
  for (let i = 0; i < value.length; i += 2) {
    const high = hexDigits.indexOf(value.charAt(i)); const low = hexDigits.indexOf(value.charAt(i + 1));
    if (high < 0 || low < 0) return undefined;
    const code = high * 16 + low;
    if (code < 32 || code > 126) return undefined;
    result += String.fromCharCode(code);
  }
  return result;
}
/** Adler-style corruption check, folded to 31 bits for Warcraft's 32-bit integers. Not authentication. */
export function checksum(value: string): number {
  let a = 1; let b = 0;
  for (let i = 0; i < value.length; i++) { a = (a + value.charCodeAt(i)) % 65521; b = (b + a) % 65521; }
  return (b % 32768) * 65536 + a;
}
