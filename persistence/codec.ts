import { ascii, checksum, failure, hexDecode, hexEncode, identifier, integer, integerText, isDigitAt, MAX_INT, Result, unsigned } from "./format.ts";
export type SaveValue = number | string | boolean;
export type SaveData = Record<string, SaveValue>;
export type SaveField =
  | { key: string; kind: "number"; min: number; max: number; integer?: boolean }
  | { key: string; kind: "string"; maxLength: number }
  | { key: string; kind: "boolean" };
export interface SaveSchema {
  version: number;
  fields: readonly SaveField[];
  /** Converts this version to version + 1; both schemas are validated. */
  migrate?: (this: void, data: SaveData) => SaveData;
}
export { type Result } from "./format.ts";

/**
 * Portable, deterministic save codes. Strings are printable ASCII for byte parity in Lua and JS.
 * Integers are written exactly; non-integers go through Lua tostring (14 significant digits),
 * so store fractional values as scaled integers when precision matters.
 *
 * binding: optional text mixed into the checksum, typically the player name, so a code only
 * loads for the player it was made for. The same binding must be passed to decode. This stops
 * casual code sharing; it is not cryptography.
 */
export class SaveCodec {
  private readonly schemas = new Map<number, SaveSchema>();
  constructor(readonly version: number, schemas: readonly SaveSchema[], readonly maxCodeLength = 8192) {
    if (!integer(version, 1, 9999) || !integer(maxCodeLength, 32, 65536) || schemas.length > 32) throw new Error("Invalid codec limits");
    for (const schema of schemas) {
      if (!integer(schema.version, 1, version) || this.schemas.has(schema.version) || schema.fields.length > 32) throw new Error("Invalid schema version/fields");
      const keys = new Set<string>();
      for (const field of schema.fields) {
        if (!identifier(field.key) || field.key === "__proto__" || field.key === "constructor" || field.key === "prototype" || keys.has(field.key)) throw new Error("Invalid schema key");
        keys.add(field.key);
        if (field.kind === "number") {
          // Warcraft's Lua has 32-bit numbers: integers must fit in 2^31-1; floats keep only ~7 digits.
          if (!(field.min >= -MAX_INT && field.max <= MAX_INT && field.min <= field.max)) throw new Error("Invalid numeric bounds");
        } else if (field.kind === "string") {
          if (!integer(field.maxLength, 0, 8192)) throw new Error("Invalid string bound");
        } else if (field.kind !== "boolean") throw new Error("Invalid field kind");
      }
      this.schemas.set(schema.version, { version: schema.version, fields: schema.fields.map(field => ({ ...field })), migrate: schema.migrate });
    }
    if (!this.schemas.has(version)) throw new Error("Missing current schema");
  }
  private validate(data: SaveData, schema: SaveSchema): boolean {
    if (typeof data !== "object" || data === null) return false;
    const ownKeys = Object.keys(data);
    if (ownKeys.length !== schema.fields.length) return false;
    for (const field of schema.fields) {
      if (ownKeys.indexOf(field.key) < 0) return false;
      const value = data[field.key];
      if (field.kind === "number") {
        if (typeof value !== "number" || !(value >= field.min && value <= field.max) || (field.integer && Math.floor(value) !== value)) return false;
      } else if (field.kind === "string") {
        if (typeof value !== "string" || value.length > field.maxLength || !ascii(value)) return false;
      } else if (typeof value !== "boolean") return false;
    }
    return true;
  }
  encode(data: SaveData, binding = ""): Result<string> {
    const schema = this.schemas.get(this.version)!;
    if (!this.validate(data, schema)) return failure("schema");
    let body = `${this.version};`;
    for (const field of schema.fields) {
      const value = data[field.key];
      const text = typeof value === "boolean" ? (value ? "1" : "0")
        : typeof value === "number" ? numberText(value) : value;
      body += `${text.length}:${text}`;
    }
    const code = `W3S1:${hexEncode(body)}:${integerText(checksum(bound(binding, body)))}`;
    return code.length <= this.maxCodeLength ? { ok: true, value: code } : failure("size");
  }
  decode(code: string, binding = ""): Result<SaveData> {
    if (code.length > this.maxCodeLength || code.slice(0, 5) !== "W3S1:") return failure("format");
    const boundary = code.indexOf(":", 5);
    if (boundary < 0) return failure("format");
    const body = hexDecode(code.slice(5, boundary));
    const expected = unsigned(code.slice(boundary + 1), MAX_INT);
    if (body === undefined || expected === undefined || checksum(bound(binding, body)) !== expected) return failure("checksum");
    const endVersion = body.indexOf(";");
    if (endVersion < 0) return failure("format");
    const version = unsigned(body.slice(0, endVersion), 9999);
    const schema = version === undefined ? undefined : this.schemas.get(version);
    if (!schema) return failure("version");
    let cursor = endVersion + 1;
    let data: SaveData = {};
    for (const field of schema.fields) {
      const endLength = body.indexOf(":", cursor);
      if (endLength < 0) return failure("truncated");
      const length = unsigned(body.slice(cursor, endLength), this.maxCodeLength);
      if (length === undefined || endLength + 1 + length > body.length) return failure("truncated");
      const value = body.slice(endLength + 1, endLength + 1 + length);
      cursor = endLength + 1 + length;
      if (field.kind === "number") {
        const number = parseNumber(value);
        if (number === undefined) return failure("number");
        data[field.key] = number;
      } else if (field.kind === "boolean") {
        if (value !== "0" && value !== "1") return failure("boolean");
        data[field.key] = value === "1";
      } else data[field.key] = value;
    }
    if (cursor !== body.length || !this.validate(data, schema)) return failure("schema");
    let active = schema;
    try {
      while (active.version < this.version) {
        const next = this.schemas.get(active.version + 1);
        if (!next || !active.migrate) return failure("migration-missing");
        data = active.migrate(data);
        if (!this.validate(data, next)) return failure("migration-schema");
        active = next;
      }
    } catch { return failure("migration-failed"); }
    return { ok: true, value: data };
  }
}
/** "
" never occurs in a body (printable ASCII only), so binding and body cannot run together. */
function bound(binding: string, body: string): string {
  return binding.length === 0 ? body : `${binding}
${body}`;
}

function numberText(value: number): string {
  return Math.floor(value) === value && value >= -MAX_INT && value <= MAX_INT ? integerText(value) : String(value);
}

/** Strict finite decimal parser; excludes JS/Lua differences such as hex and whitespace. */
function parseNumber(text: string): number | undefined {
  if (text.length === 0 || text.length > 64) return undefined;
  let i = text.charAt(0) === "-" ? 1 : 0;
  let digits = 0;
  while (i < text.length && isDigitAt(text, i)) { i++; digits++; }
  if (digits === 0) return undefined;
  if (text.charAt(i) === ".") {
    i++; let decimalDigits = 0;
    while (i < text.length && isDigitAt(text, i)) { i++; decimalDigits++; }
    if (decimalDigits === 0) return undefined;
  }
  if (text.charAt(i) === "e" || text.charAt(i) === "E") {
    i++; if (text.charAt(i) === "+" || text.charAt(i) === "-") i++;
    let exponentDigits = 0;
    while (i < text.length && isDigitAt(text, i)) { i++; exponentDigits++; }
    if (exponentDigits === 0) return undefined;
  }
  if (i !== text.length) return undefined;
  const result = Number(text);
  return result > -Infinity && result < Infinity ? result : undefined;
}
