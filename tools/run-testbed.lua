local lines = {}
local rawprint = print
print = function(...) local s = table.concat({...}, " "); lines[#lines + 1] = s; rawprint((s:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""))) end
local function run(cmd, seconds)
  rawprint("\n>>> " .. cmd)
  local ok, err = pcall(TEST.chat, cmd)
  if not ok then rawprint("!!! LUA ERROR in " .. cmd .. ": " .. tostring(err)) end
  if seconds then local ok2, err2 = pcall(TEST.advance, seconds); if not ok2 then rawprint("!!! LUA ERROR advancing after " .. cmd .. ": " .. tostring(err2)) end end
end
main()
TEST.advance(0.1)
for _, step in ipairs({
  {"-help"}, {"-selftest"}, {"-clock", 1.5}, {"-buffs", 9}, {"-clear"}, {"-aura", 2}, {"-clear"},
  {"-damage", 0.5}, {"-log"}, {"-spell", 1.5}, {"-log"}, {"-thorns", 0.5}, {"-loop", 1.5}, {"-cheatdeath", 2}, {"-clear"},
  {"-dummy", 4}, {"-clear"}, {"-missile", 1}, {"-arc", 3}, {"-clear"}, {"-homing", 8}, {"-knock", 1.5}, {"-clear"},
  {"-stress 60", 2.5}, {"-clear"}, {"-save 500", 0.1}, {"-load", 0.5}, {"-migrate"}, {"-time"}, {"-status"},
}) do run(step[1], step[2]) end
local code
for _, l in ipairs(lines) do code = l:match("code %(%d+ chars%): (W3S1:%S+)") or code end
run("-code " .. tostring(code)); run("-code W3S1:deadbeef:1")
run("-clear"); run("-status")
