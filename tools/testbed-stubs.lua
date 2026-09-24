-- Minimal fake Warcraft API: enough state to drive the test bed's commands in a plain Lua VM.
local nextId = 0
local function handle(kind, extra)
  nextId = nextId + 1
  local h = extra or {}
  h.id = nextId; h.kind = kind
  return h
end
local players = {}
function Player(i) players[i] = players[i] or handle("player", { pid = i }); return players[i] end
local triggers, timers = {}, {}
local event = {}
local chatText, chatPlayer = "", nil
local syncData, syncPlayer = nil, nil
local units = {}

setmetatable(_G, { __index = function(_, k)
  if k == "W3TS_HOOK" then return nil end
  if type(k) == "string" and k:match("^[A-Z][A-Z0-9_]+$") then return k end -- constants: their own name
  if type(k) == "string" and k:match("^[A-Z]") then return function() return 0 end end
  return nil
end })
function FourCC(s) return string.unpack(">I4", s) end

function main() end; function config() end
bj_MAX_PLAYERS = 24; bj_MAX_PLAYER_SLOTS = 28; PLAYER_NEUTRAL_AGGRESSIVE = 24
function GetPlayerSlotState(p) return p.pid == 0 and "PLAYER_SLOT_STATE_PLAYING" or "EMPTY" end
function GetPlayerController(p) return "MAP_CONTROL_USER" end
function GetPlayerId(p) return p.pid end
function GetPlayerName(p) return "Tester" end
function GetLocalPlayer() return Player(0) end
function GetPlayerStartLocationX() return 0 end
function GetPlayerStartLocationY() return 0 end

function CreateTrigger() local t = handle("trigger", { events = {} }); triggers[#triggers + 1] = t; return t end
function DestroyTrigger(t) t.dead = true end
function TriggerAddAction(t, f) t.action = f; return handle("action") end
function TriggerRemoveAction(t) t.action = nil end
function TriggerRegisterPlayerUnitEvent(t, p, e) t.events[e] = true; return handle("event") end
function TriggerRegisterPlayerChatEvent(t, p) t.events.chat = true; return handle("event") end
function BlzTriggerRegisterPlayerSyncEvent(t, p, prefix) t.events.sync = true; return handle("event") end
local function fire(kind) for _, t in ipairs(triggers) do if t.events[kind] and t.action and not t.dead then t.action() end end end

function CreateTimer() return handle("timer") end
function TimerStart(t, timeout, periodic, f) t.timeout = timeout; t.periodic = periodic; t.cb = f; timers[t] = true end
function PauseTimer(t) timers[t] = nil end
function DestroyTimer(t) timers[t] = nil end
function TimerGetElapsed() return 1.0 end

function CreateUnit(p, code, x, y) local u = handle("unit", { owner = p, code = code, x = x, y = y, life = 100, maxLife = 100 }); units[#units + 1] = u; return u end
function RemoveUnit(u) u.code = 0 end
function GetUnitTypeId(u) return u.code or 0 end
function GetWidgetLife(u) return u.life or 0 end
function SetWidgetLife(u, v) u.life = v end
function BlzSetUnitMaxHP(u, v) u.maxLife = v end
function KillUnit(u) u.life = 0; u.dead = true end
function IsUnitType(u, t) return t == "UNIT_TYPE_DEAD" and u.dead == true end
function GetUnitX(u) return u.x end
function GetUnitY(u) return u.y end
function SetUnitX(u, v) u.x = v end
function SetUnitY(u, v) u.y = v end
function GetOwningPlayer(u) return u.owner end
function IsUnitEnemy(u, p) return u.owner ~= p end
function IsUnitAlly(u, p) return u.owner == p end
function GetHandleId(h) return h.id end
function GetUnitName(u) return "Unit" .. u.id end
function UnitAddAbility() return true end
function GetUnitAbilityLevel() return 1 end
function IssueTargetOrder() return true end
function IssuePointOrder() return true end
function IssueImmediateOrder() return true end
function GetUnitMoveSpeed(u) return u.speed or 270 end
function SetUnitMoveSpeed(u, v) u.speed = v end
function BlzGetUnitCollisionSize() return 32 end
function IsTerrainPathable() return false end

function CreateGroup() return handle("group", { list = {} }) end
function GroupEnumUnitsInRange(g, x, y, r)
  g.list = {}
  for _, u in ipairs(units) do
    if u.code ~= 0 and (u.x - x) ^ 2 + (u.y - y) ^ 2 <= r * r then g.list[#g.list + 1] = u end
  end
end
function FirstOfGroup(g) return g.list[1] end
function GroupRemoveUnit(g, u) for i, v in ipairs(g.list) do if v == u then table.remove(g.list, i) return end end end
function GroupClear(g) g.list = {} end

function Location() return handle("location") end
function GetLocationZ() return 0 end
function AddSpecialEffect() return handle("effect") end
function AddSpecialEffectTarget() return handle("effect") end
function CreateTextTag() return handle("texttag") end

-- Damage: UnitDamageTarget fires DAMAGING then DAMAGED synchronously, like the engine.
function GetEventDamageSource() return event.source end
function BlzGetEventDamageTarget() return event.target end
function GetEventDamage() return event.amount end
function BlzGetEventIsAttack() return event.attack end
function BlzSetEventDamage(v) event.amount = v end
function BlzGetEventAttackType() return event.attackType end
function BlzGetEventDamageType() return event.damageType end
function BlzGetEventWeaponType() return event.weaponType end
function BlzSetEventAttackType(v) event.attackType = v end
function BlzSetEventDamageType(v) event.damageType = v end
function BlzSetEventWeaponType(v) event.weaponType = v end
function UnitDamageTarget(src, tgt, amount, attack, ranged, at, dt, wt)
  local saved = event
  event = { source = src, target = tgt, amount = amount, attack = attack, attackType = at, damageType = dt, weaponType = wt }
  fire("EVENT_PLAYER_UNIT_DAMAGING")
  fire("EVENT_PLAYER_UNIT_DAMAGED")
  tgt.life = tgt.life - event.amount
  if tgt.life <= 0.405 then tgt.dead = true end
  event = saved
  return true
end

-- Preload files: remember the lines; Preloader replays the tooltip statements.
local files, buffer, tooltips = {}, {}, {}
function PreloadGenClear() buffer = {} end
function PreloadGenStart() end
function Preload(line) buffer[#buffer + 1] = line end
function PreloadGenEnd(path) files[path] = buffer; buffer = {} end
function Preloader(path)
  for _, line in ipairs(files[path] or {}) do
    local id, first = line:match('BlzSetAbilityTooltip%((%d+), "(W3L1[0-9a-f]*)", 0%)')
    local id2, more = line:match('BlzGetAbilityTooltip%((%d+), 0%) %+ "([0-9a-f]*)"')
    if first then tooltips[tonumber(id)] = first elseif more then tooltips[tonumber(id2)] = tooltips[tonumber(id2)] .. more end
  end
end
function BlzGetAbilityTooltip(a) return tooltips[a] or "Original" end
function BlzSetAbilityTooltip(a, text) tooltips[a] = text end

-- Sync: delivered to every "client" at once.
function BlzSendSyncData(prefix, data) syncData, syncPlayer = data, Player(0); fire("sync"); return true end
function BlzGetTriggerSyncData() return syncData end
function GetTriggerPlayer() return syncPlayer or chatPlayer end
function GetEventPlayerChatString() return chatText end

-- Test driver API used by run-testbed.lua.
TEST = {}
function TEST.chat(text) chatText, chatPlayer, syncPlayer = text, Player(0), nil; fire("chat") end
function TEST.advance(seconds)
  local steps = math.floor(seconds * 32 + 0.5)
  for _ = 1, steps do
    for t in pairs(timers) do if t.periodic and t.cb then t.cb() end end
    for t in pairs(timers) do if not t.periodic and t.timeout == 0 and t.cb then timers[t] = nil; t.cb() end end
  end
end
