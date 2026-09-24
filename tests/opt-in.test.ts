// Guards for "a map pays only for what it imports" (AGENTS.md §5). Both compile the package with
// TypeScriptToLua, so they need `deno install` (the dev npm toolchain) like `deno task test:lua`.
import assert from "node:assert/strict";
import * as path from "node:path";
import { bundleModules, compile, runLua } from "../tools/lua.ts";
import { exportPaths, PACKAGE, reachableModules } from "../tools/shake.ts";

const ROOT = path.resolve(import.meta.dirname!, "..");

/**
 * Exactly the library modules each export may put into a map's script. Adding an export or an
 * import between modules changes this table on purpose: check the new cost is intended, then update it.
 */
const EXPECTED: Record<string, string[]> = {
  "core": ["core.index", "core.scheduler", "core.warcraft-clock"],
  "core/scheduler": ["core.scheduler"],
  "core/warcraft-clock": ["core.warcraft-clock"],
  "core/scope": ["core.scope"],
  "core/signal": ["core.signal"],
  "buffs": ["buffs.buffs", "buffs.index", "buffs.warcraft-buffs"],
  "buffs/buffs": ["buffs.buffs"],
  "buffs/warcraft-buffs": ["buffs.warcraft-buffs"],
  "buffs/aura": ["buffs.aura"],
  "dummy": ["dummy.dummy", "dummy.index", "dummy.warcraft-dummy"],
  "dummy/dummy": ["dummy.dummy"],
  "dummy/warcraft-dummy": ["dummy.dummy", "dummy.warcraft-dummy"],
  "damage": ["damage.index", "damage.system", "damage.warcraft"],
  "damage/system": ["damage.system"],
  "damage/warcraft": ["damage.system", "damage.warcraft"],
  "physics/geometry": ["physics.geometry"],
  "physics/knockback": ["physics.geometry", "physics.knockback.index", "physics.knockback.system", "physics.knockback.warcraft", "physics.warcraft-living"],
  "physics/knockback/system": ["physics.geometry", "physics.knockback.system"],
  "physics/knockback/warcraft": ["physics.geometry", "physics.knockback.warcraft", "physics.warcraft-living"],
  "physics/missile": ["physics.geometry", "physics.missile.index", "physics.missile.system", "physics.missile.warcraft", "physics.warcraft-living"],
  "physics/missile/system": ["physics.geometry", "physics.missile.system"],
  "physics/missile/warcraft": ["physics.geometry", "physics.missile.warcraft", "physics.warcraft-living"],
  "physics/warcraft-terrain": ["physics.warcraft-terrain"],
  "persistence/codec": ["persistence.codec", "persistence.format"],
  "persistence/format": ["persistence.format"],
  "persistence/local-file": ["persistence.format", "persistence.local-file"],
  "persistence/sync": ["persistence.format", "persistence.sync"],
  "time": ["time.index"],
  "time/warcraft": ["time.index", "time.warcraft"],
};

Deno.test("tree shaking: each export bundles only its own modules", () => {
  const exports = exportPaths();
  assert.deepEqual([...exports].sort(), Object.keys(EXPECTED).sort(), "every export needs an entry in EXPECTED");
  const reachable = reachableModules(exports);
  for (const exportPath of exports) assert.deepEqual(reachable.get(exportPath), EXPECTED[exportPath], exportPath);
});

Deno.test("tree shaking: a real TSTL bundle matches the require walk", () => {
  // Cross-check the cheap walk above against an actual bundle, for the brief's example entry.
  const dir = path.join(ROOT, "dist", "shake-bundle");
  Deno.mkdirSync(dir, { recursive: true });
  const entry = path.join(dir, "knockback.ts");
  Deno.writeTextFileSync(entry, `import { KnockbackSystem } from "${PACKAGE}/physics/knockback";\nprint(KnockbackSystem);\n`);
  const bundle = path.join(dir, "knockback.lua");
  compile([path.relative(ROOT, entry)], { bundle });
  const modules = bundleModules(bundle).filter(m => m !== "lualib_bundle" && !m.startsWith("dist.")).sort();
  assert.deepEqual(modules, EXPECTED["physics/knockback"]);
  for (const other of ["damage", "missile", "persistence", "buffs", "dummy", "time", "core"]) {
    assert.ok(!modules.some(m => m.includes(other)), `knockback bundle must not contain ${other}`);
  }
});

/** Every Warcraft native and BJ function war3-types-strict declares for 1.33.0. */
function nativeNames(): string[] {
  const dir = path.join(ROOT, "node_modules/war3-types-strict");
  const files = ["compat.d.ts", "polyfill.d.ts", "1.33.0/common.j.d.ts", "1.33.0/common.ai.d.ts", "1.33.0/blizzard.j.d.ts"];
  const names = new Set<string>();
  for (const file of files) {
    for (const m of Deno.readTextFileSync(path.join(dir, file)).matchAll(/declare function (\w+)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

Deno.test("importing any module calls no Warcraft native (Lua VM)", () => {
  const natives = nativeNames();
  assert.ok(natives.length > 2000, `expected the full native list, got ${natives.length}`);
  assert.ok(natives.includes("CreateTimer") && natives.includes("FourCC") && natives.includes("TriggerRegisterPlayerUnitEvent"));

  const dir = path.join(ROOT, "dist", "side-effects");
  Deno.mkdirSync(dir, { recursive: true });
  const exports = exportPaths();
  const entry = path.join(dir, "import-all.ts");
  Deno.writeTextFileSync(entry, [
    ...exports.map((e, i) => `import * as m${i} from "${PACKAGE}/${e}";`),
    `const modules: unknown[] = [${exports.map((_, i) => `m${i}`).join(", ")}];`,
    `print(\`imported \${modules.length} modules\`);`,
  ].join("\n") + "\n");
  const bundle = path.join(dir, "import-all.lua");
  compile([path.relative(ROOT, entry)], { bundle });

  // Every native throws when called. Reading Warcraft globals (constants) stays allowed.
  const stubs = path.join(dir, "throwing-natives.lua");
  Deno.writeTextFileSync(stubs, natives.map(name =>
    `${name} = function() error("native ${name} called while importing", 2) end`).join("\n") + "\n");
  const run = runLua([stubs, bundle]);
  assert.equal(run.error, undefined, run.error);
  assert.deepEqual(run.lines, [`imported ${exports.length} modules`]);
});
