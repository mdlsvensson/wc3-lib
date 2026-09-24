// Which library modules does each package export pull into a map? Used by tests/opt-in.test.ts.
import * as path from "node:path";
import { compile } from "./lua.ts";

const ROOT = path.resolve(import.meta.dirname!, "..");
export const PACKAGE = "@mdlsvensson/wc3-lib";

/** Export subpaths from deno.json, without the leading "./" ("core", "physics/knockback", ...). */
export function exportPaths(): string[] {
  const deno = JSON.parse(Deno.readTextFileSync(path.join(ROOT, "deno.json")));
  return Object.keys(deno.exports).map(key => key.slice(2));
}

function fixtureName(exportPath: string): string {
  return exportPath.replaceAll("/", "__");
}

/**
 * Compile one fixture per export (`import * as m from "<package>/<export>"; print(m)`) in a single
 * TSTL run that writes one Lua file per module, then follow `require` from each fixture. A TSTL
 * bundle contains exactly the modules reachable this way, plus anything listed in tsconfig
 * `include` (the framework never lists the package there). Returns export -> sorted library
 * module names (e.g. "physics.geometry"), without lualib and the fixture itself.
 */
export function reachableModules(exports: string[] = exportPaths()): Map<string, string[]> {
  const work = path.join(ROOT, "dist", "shake");
  try { Deno.removeSync(work, { recursive: true }); } catch { /* first run */ }
  const fixtures = path.join(work, "fixtures");
  Deno.mkdirSync(fixtures, { recursive: true });
  const entries = exports.map(exportPath => {
    const file = path.join(fixtures, `${fixtureName(exportPath)}.ts`);
    Deno.writeTextFileSync(file, `import * as m from "${PACKAGE}/${exportPath}";\nprint(m);\n`);
    return path.relative(ROOT, file);
  });
  const out = path.join(work, "out");
  compile(entries, { outDir: out });

  const fixtureModule = (exportPath: string) =>
    path.relative(ROOT, path.join(fixtures, fixtureName(exportPath))).split(path.sep).join(".");
  const requires = (module: string): string[] => {
    const file = path.join(out, ...module.split(".")) + ".lua";
    return [...Deno.readTextFileSync(file).matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]);
  };
  const result = new Map<string, string[]>();
  for (const exportPath of exports) {
    const seen = new Set<string>();
    const stack = [fixtureModule(exportPath)];
    while (stack.length > 0) {
      const module = stack.pop()!;
      if (seen.has(module) || module === "lualib_bundle") continue;
      seen.add(module);
      stack.push(...requires(module));
    }
    seen.delete(fixtureModule(exportPath));
    result.set(exportPath, [...seen].sort());
  }
  return result;
}

if (import.meta.main) {
  for (const [exportPath, modules] of reachableModules()) console.log(`${exportPath}: ${modules.join(", ")}`);
}
