// Lua tooling for the library (runs in Deno as JavaScript, not Lua).
//
//   deno run -A tools/lua.ts build-testbed   compile testbed/main.ts to dist/testbed.lua
//   deno run -A tools/lua.ts test            compile the Lua harness and the testbed, then run both in
//                                            fengari (a 64-bit Lua 5.3 VM) with luaLibImport "require"
//                                            and "require-minimal"
//
// fengari has 64-bit numbers and a working NaN, so this cannot catch Warcraft's 32-bit number issues.
// Only `-selftest` in game can. See tools/lua-harness.md and tools/testbed.md.
import { createRequire } from "node:module";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname!, "..");
const DIST = path.join(ROOT, "dist");
const LUALIB_MODES = ["require", "require-minimal"] as const;
type LualibMode = typeof LUALIB_MODES[number];

interface TsConfig {
  include: string[];
  compilerOptions: Record<string, unknown>;
  tstl: Record<string, unknown>;
}

/** Compile one entry point to a single Lua bundle with the repo's tsconfig.json and the given lualib mode. */
export function compile(entry: string, bundle: string, mode: LualibMode = "require"): void {
  const config: TsConfig = JSON.parse(Deno.readTextFileSync(path.join(ROOT, "tsconfig.json")));
  config.compilerOptions.outDir = path.join(DIST, "out");
  config.include = [entry]; // Only what the entry imports is bundled (anything listed in include is bundled too).
  config.tstl.luaBundleEntry = "./" + entry;
  config.tstl.luaBundle = bundle;
  config.tstl.luaLibImport = mode;
  const file = path.join(ROOT, `tsconfig.lua.${Deno.pid}.json`);
  Deno.writeTextFileSync(file, JSON.stringify(config, null, 2));
  let result: Deno.CommandOutput;
  try {
    const tstl = path.join(ROOT, "node_modules/typescript-to-lua/dist/tstl.js");
    result = new Deno.Command(Deno.execPath(), { args: ["run", "-A", tstl, "-p", file], cwd: ROOT }).outputSync();
  } catch (error) {
    Deno.removeSync(file);
    throw error;
  }
  Deno.removeSync(file);
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  if (!result.success) throw new Error(`TypeScriptToLua failed for ${entry}:\n${output}`);
}

/** Run Lua files in order in one fengari state. Returns everything printed and the first error, if any. */
export function runLua(files: string[]): { lines: string[]; error?: string } {
  const require = createRequire(path.join(ROOT, "package.json"));
  const { lua, lauxlib, lualib, to_luastring } = require("fengari");
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const lines: string[] = [];
  lua.lua_register(L, to_luastring("print"), (state: unknown) => {
    const parts: string[] = [];
    for (let i = 1; i <= lua.lua_gettop(state); i++) {
      lauxlib.luaL_tolstring(state, i);
      parts.push(lua.lua_tojsstring(state, -1));
      lua.lua_pop(state, 1);
    }
    lines.push(...parts.join("\t").split("\n"));
    return 0;
  });
  for (const file of files) {
    if (lauxlib.luaL_dofile(L, to_luastring(file)) !== 0) return { lines, error: `${path.basename(file)}: ${lua.lua_tojsstring(L, -1)}` };
  }
  return { lines };
}

/** Markers of a healthy testbed dry run (tools/testbed.md). */
const TESTBED_EXPECTED = [
  "selftest: 17/17 passed",
  "loop: 64 hits",
  "cheated death",
  "knockback ends: replaced 1, completed 6",
  "synced load for player 1 on every client",
];

function testMode(mode: LualibMode): string[] {
  const failures: string[] = [];
  const dir = path.join(DIST, `lua-${mode}`);
  Deno.mkdirSync(dir, { recursive: true });

  const harness = path.join(dir, "harness.lua");
  compile("tools/lua-harness.ts", harness, mode);
  const harnessRun = runLua([harness]);
  const summary = harnessRun.lines.find(line => /^\d+\/\d+ Lua checks passed$/.test(line));
  if (harnessRun.error) failures.push(`harness: ${harnessRun.error}`);
  const counts = summary?.match(/^(\d+)\/(\d+)/);
  if (!counts || counts[1] !== counts[2]) failures.push(`harness: ${summary ?? "no summary line"}`);
  for (const line of harnessRun.lines.filter(l => l.startsWith("FAIL "))) failures.push(`harness: ${line}`);

  const testbed = path.join(dir, "testbed.lua");
  compile("testbed/main.ts", testbed, mode);
  const run = runLua([path.join(ROOT, "tools/testbed-stubs.lua"), testbed, path.join(ROOT, "tools/run-testbed.lua")]);
  Deno.writeTextFileSync(path.join(dir, "testbed-run.txt"), run.lines.join("\n") + "\n");
  if (run.error) failures.push(`testbed: ${run.error}`);
  for (const line of run.lines.filter(l => l.includes("LUA ERROR"))) failures.push(`testbed: ${line}`);
  for (const marker of TESTBED_EXPECTED) {
    if (!run.lines.some(line => line.includes(marker))) failures.push(`testbed: missing "${marker}"`);
  }
  console.log(`${mode}: harness ${summary ?? "(no summary)"}; testbed ${run.lines.length} lines, transcript in ${path.relative(ROOT, dir)}/testbed-run.txt`);
  return failures;
}

if (import.meta.main) {
  const command = Deno.args[0];
  if (command === "build-testbed") {
    compile("testbed/main.ts", path.join(DIST, "testbed.lua"));
    console.log("dist/testbed.lua");
  } else if (command === "test") {
    const failures = LUALIB_MODES.flatMap(testMode);
    for (const failure of failures) console.error(`FAIL ${failure}`);
    if (failures.length > 0) Deno.exit(1);
    console.log("Lua checks passed in both lualib modes (fengari, 64-bit: not a substitute for -selftest in game).");
  } else {
    console.error("usage: deno run -A tools/lua.ts <build-testbed|test>");
    Deno.exit(2);
  }
}
