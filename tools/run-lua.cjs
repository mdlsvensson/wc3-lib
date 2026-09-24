const { lua, lauxlib, lualib, to_luastring } = require("fengari");
const src = require("fs").readFileSync(process.argv[2]);
const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
if (lauxlib.luaL_loadbuffer(L, src, null, to_luastring("harness")) !== lua.LUA_OK || lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
  console.error("LUA ERROR:", lua.lua_tojsstring(L, -1)); process.exit(1);
}
