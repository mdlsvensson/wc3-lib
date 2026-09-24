/**
 * In-game test bed for the library: a map entry point (see tools/testbed.md).
 *
 *   Build a map with this file as its entry point, start the map, type -help.
 *
 * It imports ONLY the library (through the package name, like a map) and uses only built-in object data,
 * so it works unchanged in any map, including w3ts-framework's template. Tests spawn units for Player 1 (red) against
 * Neutral Hostile around Player 1's start location. -clear removes everything a test made.
 *
 * Each test prints what it tests ("what:") and what you should see ("look for:"). Behaviour that can only be
 * verified in the engine is the point: native damage events, Preload files, sync, pathing.
 */
import { W3TS_HOOK, addScriptHook } from "w3ts/hooks";
import { Scheduler } from "@mdlsvensson/wc3-lib/core/scheduler";
import { Scope } from "@mdlsvensson/wc3-lib/core/scope";
import { startWarcraftClock } from "@mdlsvensson/wc3-lib/core/warcraft-clock";
import { BuffStore, type BuffDefinition } from "@mdlsvensson/wc3-lib/buffs/buffs";
import { Aura } from "@mdlsvensson/wc3-lib/buffs/aura";
import { trackWarcraftBuffTargets } from "@mdlsvensson/wc3-lib/buffs/warcraft-buffs";
import { createWarcraftDummies } from "@mdlsvensson/wc3-lib/dummy/warcraft-dummy";
import { createWarcraftDamage, isLethal, type WarcraftDamageSystem } from "@mdlsvensson/wc3-lib/damage";
import { DamageSystem, type DamageEvent } from "@mdlsvensson/wc3-lib/damage/system";
import { MissileSystem, type CollisionTarget, type Missile, type MissileOptions } from "@mdlsvensson/wc3-lib/physics/missile";
import { KnockbackSystem, knockbackVelocity, type KnockbackEnd } from "@mdlsvensson/wc3-lib/physics/knockback";
import { turnToward } from "@mdlsvensson/wc3-lib/physics/geometry";
import { WarcraftKnockbackPort, WarcraftMissilePort, WarcraftMissileVisual, WarcraftTerrain } from "@mdlsvensson/wc3-lib/physics/warcraft";
import { SaveCodec, type SaveData, type SaveSchema } from "@mdlsvensson/wc3-lib/persistence/codec";
import { hexEncode, integerText } from "@mdlsvensson/wc3-lib/persistence/format";
import { createWarcraftPreloadPort, PreloadLocalStore } from "@mdlsvensson/wc3-lib/persistence/local-file";
import { chunkSaveCode, SyncReceiver, WarcraftSyncTransport } from "@mdlsvensson/wc3-lib/persistence/sync";
import { readWarcraftUtc } from "@mdlsvensson/wc3-lib/time/warcraft";
import { dayOfWeek, formatDuration, formatUtc, LocalWallTime, SimulationTime, unixToUtc, utcToUnix } from "@mdlsvensson/wc3-lib/time";

const BUILD_UNIX = compiletime(() => Math.floor(Date.now() / 1000));

// ── Configuration: built-in object data only ────────────────────────────────────────────────
const FOOTMAN = FourCC("hfoo");
const KNIGHT = FourCC("hkni");
const PALADIN = FourCC("Hpal");
const GRUNT = FourCC("ogru");
/** Stand-in dummy caster: a Sorceress has mana. A real map should use an invisible dummy type. */
const DUMMY_CASTER = FourCC("hsor");
const DUMMY_SLOW = FourCC("ACsw");          // Slow (creep): order "slow"
const DUMMY_BOLT = FourCC("ACtb");          // Storm Bolt (creep): order "creepthunderbolt" (creep abilities use creep-prefixed orders)
const SPELL_IMMUNITY = FourCC("ACmi");      // Spell Immunity (creep)
/** Any ability whose tooltip this map never shows; PreloadLocalStore borrows and restores it. */
const STORAGE_ABILITY = FourCC("ANcl");
const MISSILE_HEIGHT = 60;

const RED = "|cffff4040", GREEN = "|cff40ff40", GOLD = "|cffffcc00", GREY = "|cffaaaaaa", END = "|r";

interface Tag { readonly kind: string }

function fmt(n: number): string { return string.format("%.1f", n); }
function say(text: string): void { print(text); }
function expect(text: string): void { print(`${GREY}  look for: ${text}${END}`); }
function what(text: string): void { print(`${GOLD}what:${END} ${text}`); }
function report(context: string, error: unknown): void { print(`${RED}[${context}]${END} ${tostring(error)}`); }

function osLib(): { time?: () => number; clock?: () => number } | undefined {
  return (globalThis as unknown as { os?: { time?: () => number; clock?: () => number } }).os;
}
/** CPU seconds when Warcraft's Lua exposes os.clock; used only for local profiling output. */
function cpuSeconds(): number | undefined {
  try { return osLib()?.clock?.(); } catch { return undefined; }
}

/** Avoids NaN entirely: Warcraft's Lua appears to mishandle it (see the -selftest NaN checks). */
function parseCount(arg: string | undefined, fallback: number, max: number): number {
  if (arg === undefined) return fallback;
  const value = tonumber(arg);
  if (value === undefined || value < 1 || value > max) return fallback;
  return Math.floor(value);
}

function tsMain(): void {
  try { startTestbed(); } catch (error) {
    report("testbed", error);
    // Messages printed while the map loads are not shown; repeat the failure once the game runs.
    const retry = CreateTimer();
    if (retry !== undefined) TimerStart(retry, 1, false, () => { report("testbed failed to start", error); DestroyTimer(retry); });
  }
}

function startTestbed(): void {
  const owner = Player(0)!;
  const hostile = Player(PLAYER_NEUTRAL_AGGRESSIVE)!;
  const clock = new Scheduler(1 / 32, error => report("clock", error));
  const root = new Scope(error => report("dispose", error));

  // ── Services (mirrors what a game bootstrap owns) ──────────────────────────────────────────
  const buffs = root.add(new BuffStore<unit>(clock));
  root.own(trackWarcraftBuffTargets(buffs, clock));
  const damage: WarcraftDamageSystem<Tag> = root.add(createWarcraftDamage<Tag>({
    // Warcraft skips DAMAGED when immunity fully blocks a hit, so a missing pair is informational here.
    onError: issue => issue.code === "missing-damaged"
      ? say(`${GREY}[damage:missing-damaged] a hit got DAMAGING but no DAMAGED (normal when immunity blocks it)${END}`)
      : report(`damage:${issue.code}`, issue.error ?? ""),
  }));
  const knockback = root.add(new KnockbackSystem<unit>(new WarcraftKnockbackPort({ pathing: "terrain-point" })));
  const dummies = root.add(createWarcraftDummies(clock));
  const terrain = new WarcraftTerrain();
  root.own(() => terrain.dispose());
  const missiles = root.add(new MissileSystem(new WarcraftMissilePort({
    maxTargetRadius: 96,
    centerHeight: u => terrain.height(GetUnitX(u), GetUnitY(u)) + MISSILE_HEIGHT,
    eligible: u => IsUnitEnemy(u, owner) && !dummies.isDummy(u),
    groundHeight: (x, y) => terrain.height(x, y),
  })));

  let profiling = false;
  let physicsCpu = 0;
  let physicsTicks = 0;
  root.own(clock.every(clock.stepSeconds, () => {
    const started = profiling ? cpuSeconds() : undefined;
    try { missiles.update(clock.stepSeconds); } catch (error) { report("missiles", error); }
    try { knockback.update(clock.stepSeconds); } catch (error) { report("knockback", error); }
    const ended = started !== undefined ? cpuSeconds() : undefined;
    if (started !== undefined && ended !== undefined) { physicsCpu += ended - started; physicsTicks++; }
  }));

  // ── Per-test ownership: -clear disposes this scope and removes spawned units ───────────────
  let test = new Scope(error => report("clear", error));
  const spawned: unit[] = [];
  const spawnedSet = new Set<unit>();
  const origin = { x: GetPlayerStartLocationX(owner) + 600, y: GetPlayerStartLocationY(owner) };

  function spawn(who: player, rawcode: number, dx: number, dy: number, facing = 0, paused = false): unit {
    const u = CreateUnit(who, rawcode, origin.x + dx, origin.y + dy, facing);
    if (u === undefined) throw new Error(`Could not create unit ${integerText(rawcode)}`);
    spawned.push(u);
    spawnedSet.add(u);
    if (paused) PauseUnit(u, true);
    return u;
  }

  function sturdy(u: unit, hp: number): unit {
    BlzSetUnitMaxHP(u, hp);
    SetWidgetLife(u, hp);
    return u;
  }

  function alive(u: unit): boolean { return GetUnitTypeId(u) !== 0 && GetWidgetLife(u) > 0.405; }

  function unitsInRange(x: number, y: number, radius: number, keep: (u: unit) => boolean): unit[] {
    const group = CreateGroup()!;
    const result: unit[] = [];
    try {
      GroupEnumUnitsInRange(group, x, y, radius, undefined);
      let u = FirstOfGroup(group);
      while (u !== undefined) {
        GroupRemoveUnit(group, u);
        if (alive(u) && keep(u)) result.push(u);
        u = FirstOfGroup(group);
      }
    } catch (error) { DestroyGroup(group); throw error; } // Never `finally` in Lua-bound code (TSTL 1.31).
    DestroyGroup(group);
    result.sort((a, b) => GetHandleId(a) - GetHandleId(b)); // Unique IDs: no tie-break needed.
    return result;
  }

  function float(u: unit, text: string, r: number, g: number, b: number): void {
    const tag = CreateTextTag();
    if (tag === undefined) return; // Warcraft caps text tags at 100.
    SetTextTagText(tag, text, 0.024);
    SetTextTagPosUnit(tag, u, 20);
    SetTextTagColor(tag, r, g, b, 255);
    SetTextTagVelocity(tag, 0, 0.03);
    SetTextTagPermanent(tag, false);
    SetTextTagLifespan(tag, 1.5);
    SetTextTagFadepoint(tag, 1);
  }

  function flash(model: string, x: number, y: number): void {
    const fx = AddSpecialEffect(model, x, y);
    if (fx !== undefined) DestroyEffect(fx);
  }

  function launch(options: MissileOptions<unit>): Missile<unit> {
    const missile = missiles.launch(options);
    test.own(() => missile.dispose());
    return missile;
  }

  function after(seconds: number, callback: () => void): void {
    test.own(clock.after(seconds, () => {
      try { callback(); } catch (error) { report("test", error); }
    }));
  }

  function clearTests(): void {
    test.dispose();
    test = new Scope(error => report("clear", error));
    for (const u of spawned) {
      buffs.clearTarget(u, "removed");
      knockback.get(u)?.dispose();
      if (GetUnitTypeId(u) !== 0) RemoveUnit(u);
    }
    spawned.length = 0;
    spawnedSet.clear();
    profiling = false;
  }
  root.own(clearTests);

  // ── Damage display: floating numbers on test units, optional chat log ──────────────────────
  const attackNames: [attacktype, string][] = [
    [ATTACK_TYPE_NORMAL, "spells"], [ATTACK_TYPE_MELEE, "normal"], [ATTACK_TYPE_PIERCE, "pierce"],
    [ATTACK_TYPE_SIEGE, "siege"], [ATTACK_TYPE_MAGIC, "magic"], [ATTACK_TYPE_CHAOS, "chaos"], [ATTACK_TYPE_HERO, "hero"],
  ];
  const damageNames: [damagetype, string][] = [
    [DAMAGE_TYPE_NORMAL, "normal"], [DAMAGE_TYPE_ENHANCED, "enhanced"], [DAMAGE_TYPE_FIRE, "fire"],
    [DAMAGE_TYPE_COLD, "cold"], [DAMAGE_TYPE_LIGHTNING, "lightning"], [DAMAGE_TYPE_MAGIC, "magic"],
    [DAMAGE_TYPE_UNIVERSAL, "universal"], [DAMAGE_TYPE_UNKNOWN, "unknown"], [DAMAGE_TYPE_POISON, "poison"],
    [DAMAGE_TYPE_DIVINE, "divine"], [DAMAGE_TYPE_SPIRIT_LINK, "spirit link"],
  ];
  function nameOf<H>(value: H | undefined, table: [H, string][]): string {
    for (const [handle, name] of table) if (handle === value) return name;
    return "?";
  }

  let chatLog = false;
  root.own(damage.observe(o => {
    const kind = o.metadata?.kind;
    if (kind === "loop" || !spawnedSet.has(o.target)) return;
    if (o.amount > 0) {
      if (o.isAttack) float(o.target, fmt(o.amount), 255, 80, 80);
      else float(o.target, fmt(o.amount), 120, 160, 255);
    }
    const caster = dummies.sourceOf(o.source);
    if (caster !== undefined && o.amount > 0) {
      say(`${GREEN}dummy attribution:${END} ${fmt(o.amount)} dealt by a dummy, credited to ${GetUnitName(caster) ?? "?"}`);
    }
    if (chatLog) {
      say(`${GetUnitName(o.source) ?? "?"} -> ${GetUnitName(o.target) ?? "?"}: ${fmt(o.initialAmount)} raw, ` +
        `${fmt(o.beforeArmorAmount)} pre-armor, ${fmt(o.amount)} final | ${o.isAttack ? "attack" : "non-attack"}, ` +
        `${nameOf(o.detail.attackType, attackNames)}/${nameOf(o.detail.damageType, damageNames)}` +
        `${kind !== undefined ? ` | ${kind}` : ""}${o.paired ? "" : " | UNPAIRED"}`);
    }
  }, 1000));

  // ── Persistence services ───────────────────────────────────────────────────────────────────
  const v1: SaveSchema = {
    version: 1,
    fields: [{ key: "gold", kind: "number", min: 0, max: 2147483647, integer: true }],
    migrate: data => ({ gold: data.gold, level: 1, hero: "none" }),
  };
  const v2: SaveSchema = {
    version: 2,
    fields: [
      { key: "gold", kind: "number", min: 0, max: 2147483647, integer: true },
      { key: "level", kind: "number", min: 1, max: 100, integer: true },
      { key: "hero", kind: "string", maxLength: 12 },
    ],
  };
  const codec = new SaveCodec(2, [v1, v2]);
  const store = new PreloadLocalStore("W3LibTest", STORAGE_ABILITY, createWarcraftPreloadPort());
  root.add(store);
  const profiles = new Map<number, SaveData>();
  const profileOf = (id: number): SaveData => profiles.get(id) ?? { gold: 0, level: 1, hero: "none" };
  const bindingOf = (id: number): string => GetPlayerName(Player(id)!) ?? "";

  const humans: number[] = [];
  for (let id = 0; id < bj_MAX_PLAYERS; id++) {
    const p = Player(id)!;
    if (GetPlayerSlotState(p) === PLAYER_SLOT_STATE_PLAYING && GetPlayerController(p) === MAP_CONTROL_USER) humans.push(id);
  }
  const receiver = new SyncReceiver();
  const transport = new WarcraftSyncTransport("w3lt", humans, receiver, () => clock.elapsed,
    (sender, code) => {
      const decoded = codec.decode(code, bindingOf(sender));
      if (!decoded.ok) { say(`${RED}load for player ${sender + 1} rejected:${END} ${decoded.error}`); return; }
      profiles.set(sender, decoded.value);
      say(`${GREEN}synced load${END} for player ${sender + 1} on every client: ${describe(decoded.value)}`);
    },
    undefined,
    (sender, error) => say(`${RED}sync packet from player ${sender + 1} rejected:${END} ${error}`));
  root.add(transport);
  transport.start();
  let loadSession = 0;

  function describe(data: SaveData): string {
    return `gold=${tostring(data.gold)} level=${tostring(data.level)} hero=${tostring(data.hero)}`;
  }

  // ── Commands ───────────────────────────────────────────────────────────────────────────────
  // A property (not a method signature): TSTL passes `self` to interface methods, shifting the arguments.
  interface Command { readonly help: string; readonly run: (this: void, player: player, args: string[]) => void }
  const commands = new Map<string, Command>();
  const command = (name: string, help: string, run: (player: player, args: string[]) => void) => {
    commands.set(name, { help, run });
  };

  command("-help", "list commands, or -help <command>", (_p, args) => {
    const name = args[1];
    const topic = name !== undefined ? commands.get(name.charAt(0) === "-" ? name : `-${name}`) : undefined;
    if (name !== undefined && topic !== undefined) { say(`${GOLD}${name}${END} ${topic.help}`); return; }
    say(`${GOLD}lib test bed${END}: -help <command> explains one. The screen clears before each test.`);
    say("core: -selftest -clock -status -log -clear -cls");
    say("buffs: -buffs -aura | dummy: -dummy");
    say("damage: -damage -spell -thorns -loop -cheatdeath");
    say("physics: -missile -arc -homing -knock -stress [n]");
    say("save/time: -save [gold] -load -code <code> -migrate -time");
  });

  command("-clear", "remove everything the tests created", () => {
    clearTests();
    say("cleared");
  });

  command("-cls", "clear the text area", () => ClearTextMessages());

  command("-status", "service counters", () => {
    say(`tick ${clock.tick} (${formatDuration(clock.elapsed)}), pending tasks ${clock.pending}, missiles ${missiles.size}, ` +
      `knockbacks ${knockback.size}, dummies ${dummies.size}, test units ${spawned.length}`);
  });

  command("-log", "toggle a chat line for every damage event on test units", () => {
    chatLog = !chatLog;
    say(`damage log ${chatLog ? "on" : "off"}`);
  });

  command("-selftest", "run the pure library checks inside Warcraft's Lua", () => runSelfTest());

  // Core ------------------------------------------------------------------------------------
  command("-clock", "scheduler timing against a native timer", () => {
    const reference = CreateTimer()!;
    TimerStart(reference, 100, false, () => {});
    test.own(() => DestroyTimer(reference));
    const startTick = clock.tick;
    after(0.07, () => say(`after(0.07): ${clock.tick - startTick} ticks`));
    let repeats = 0;
    const stop = clock.every(0.25, () => {
      repeats++;
      if (repeats === 4) { stop(); say(`every(0.25): stopped itself after ${repeats} runs, at tick +${clock.tick - startTick}`); }
    });
    test.own(stop);
    after(1, () => say(`after(1): clock ${fmt(clock.elapsed - startTick * clock.stepSeconds)}s vs native timer ${string.format("%.3f", TimerGetElapsed(reference))}s`));
    expect("after(0.07) = 3 ticks, every(0.25) stops at +32, after(1) within ~0.03s of the native timer");
  });

  // Buffs -----------------------------------------------------------------------------------
  command("-buffs", "stacking DoT, refresh haste, passive vs active on death", () => {
    const caster = spawn(owner, FOOTMAN, 0, 0);
    const target = sturdy(spawn(hostile, GRUNT, 350, 0, 180, true), 2000);
    const burn: BuffDefinition<unit> = {
      id: "test.burn", kind: "active", stacking: "independent", maxStacks: 5, duration: 4, interval: 1,
      onApply: b => {
        const fx = AddSpecialEffectTarget("Environment\\LargeBuildingFire\\LargeBuildingFire1.mdl", b.target, "chest");
        if (fx !== undefined) b.own(() => DestroyEffect(fx));
      },
      onTick: b => {
        damage.deal({ source: b.source as unit, target: b.target, amount: 5 * b.stacks, metadata: { kind: "burn" },
          options: { attackType: ATTACK_TYPE_NORMAL, damageType: DAMAGE_TYPE_FIRE } });
      },
      onStacks: (b, previous) => say(`burn stacks ${previous} -> ${b.stacks}`),
    };
    const haste: BuffDefinition<unit> = {
      id: "test.haste", kind: "active", duration: 5,
      onApply: b => {
        // Undo what was actually applied: Warcraft clamps move speed (max 400), so "+150 then -150"
        // would leave the unit slower than it started (seen in game: 270 -> 400 -> 250).
        const before = GetUnitMoveSpeed(b.target);
        SetUnitMoveSpeed(b.target, before + 150);
        const applied = GetUnitMoveSpeed(b.target) - before;
        b.own(() => SetUnitMoveSpeed(b.target, GetUnitMoveSpeed(b.target) - applied));
      },
    };
    const talent: BuffDefinition<unit> = { id: "test.talent", kind: "passive" };
    const mark: BuffDefinition<unit> = { id: "test.mark", kind: "active" };

    buffs.apply(target, burn, caster);
    buffs.apply(target, talent);
    buffs.apply(target, mark);
    buffs.apply(caster, haste);
    after(1, () => buffs.apply(target, burn, caster));
    after(2, () => { buffs.apply(target, burn, caster); buffs.apply(caster, haste); });
    let second = 0;
    const status = clock.every(1, () => {
      second++;
      const parts = buffs.list(target).map(b => `${b.definition.id} x${b.stacks}` +
        (b.remaining !== undefined ? ` ${fmt(b.remaining)}s` : ""));
      say(`t=${second}s target: ${parts.join(", ")} | caster haste ${fmt(buffs.get(caster, "test.haste")?.remaining ?? 0)}s, speed ${fmt(GetUnitMoveSpeed(caster))}`);
      if (second === 7) KillUnit(target);
      if (second === 8) { status(); say(`after death: ${buffs.list(target).map(b => b.definition.id).join(", ")}`); }
    });
    test.own(status);
    expect("burn ticks 5, 10, 15... (3 stacks at most), each stack drops on its own; haste refreshed at t=2 lasts to t=7 and speed returns to normal");
    expect("after death only test.talent remains (passives survive death, test.mark does not)");
  });

  command("-aura", "two emitters with independent contributions", () => {
    const aura: BuffDefinition<unit> = {
      id: "test.aura", kind: "aura",
      onApply: b => {
        const fx = AddSpecialEffectTarget("Abilities\\Spells\\Orc\\CommandAura\\CommandAura.mdl", b.target, "origin");
        if (fx !== undefined) b.own(() => DestroyEffect(fx));
      },
    };
    const emitters = [spawn(owner, PALADIN, 0, 0), spawn(owner, PALADIN, 500, 0)];
    for (let i = 0; i < 5; i++) spawn(owner, FOOTMAN, -300 + i * 275, -250, 90);
    for (const emitter of emitters) {
      const a = new Aura(buffs, aura, emitter, () => alive(emitter)
        ? unitsInRange(GetUnitX(emitter), GetUnitY(emitter), 600, u => IsUnitAlly(u, owner) && spawnedSet.has(u))
        : []).start(clock, 0.5);
      test.own(() => a.dispose());
    }
    test.own(clock.every(1, () => {
      for (const u of spawned) if (alive(u) && buffs.has(u, "test.aura")) float(u, `${buffs.stacks(u, "test.aura")}`, 255, 220, 0);
    }));
    expect("numbers above units show how many paladins cover them (1 or 2); move units or kill a paladin and they update within 0.5s");
  });

  // Damage ----------------------------------------------------------------------------------
  command("-damage", "a small melee fight; use -log for details", () => {
    for (let i = 0; i < 3; i++) {
      const f = spawn(owner, FOOTMAN, 0, -150 + i * 150);
      const g = spawn(hostile, GRUNT, 700, -150 + i * 150, 180);
      IssuePointOrder(f, "attack", origin.x + 700, origin.y);
      IssuePointOrder(g, "attack", origin.x, origin.y);
    }
    expect("red numbers (attacks) over every hit; with -log: attack/normal types for footmen, hero-less grunts show normal/normal");
  });

  command("-spell", "damage type detail: magic vs spell immunity, rewritten to universal", () => {
    const caster = spawn(owner, FOOTMAN, 0, 0, 0, true); // Paused so it doesn't auto-attack.
    const target = sturdy(spawn(hostile, GRUNT, 300, 0, 180, true), 2000);
    UnitAddAbility(target, SPELL_IMMUNITY);
    what("a spell-immune grunt takes 3 scripted 50-damage hits. Each hit carries its damage type (ctx.detail), which a listener may rewrite before armor.");
    test.own(damage.beforeArmor(ctx => {
      if (ctx.metadata?.kind === "pierce-immunity") ctx.detail.damageType = DAMAGE_TYPE_UNIVERSAL;
    }));
    test.own(damage.observe(o => {
      if (o.target !== target || o.metadata === undefined) return;
      say(`${o.metadata.kind}: final ${fmt(o.amount)} (${nameOf(o.detail.attackType, attackNames)}/${nameOf(o.detail.damageType, damageNames)})`);
    }));
    const hit = (kind: string, attackType: attacktype, damageType: damagetype) =>
      damage.deal({ source: caster, target, amount: 50, metadata: { kind }, options: { attackType, damageType } });
    hit("plain-magic", ATTACK_TYPE_NORMAL, DAMAGE_TYPE_MAGIC);
    after(0.5, () => hit("pierce-immunity", ATTACK_TYPE_NORMAL, DAMAGE_TYPE_MAGIC));
    after(1, () => hit("chaos-physical", ATTACK_TYPE_CHAOS, DAMAGE_TYPE_NORMAL));
    expect("1) plain-magic: no damage, immunity blocks it (only a grey missing-damaged note). 2) pierce-immunity: 50 lands as 'universal' because the listener rewrote magic to universal. 3) chaos-physical: damage lands.");
  });

  command("-thorns", "damage dealt from inside a listener (queued, nested)", () => {
    const knight = sturdy(spawn(owner, KNIGHT, 0, 0), 3000);
    buffs.apply(knight, { id: "test.thorns", kind: "passive" });
    for (let i = 0; i < 3; i++) IssueTargetOrder(spawn(hostile, GRUNT, 400, -200 + i * 200, 180), "attack", knight);
    test.own(damage.afterArmor(ctx => {
      if (!ctx.isAttack || !buffs.has(ctx.target, "test.thorns")) return;
      damage.deal({ source: ctx.target, target: ctx.source, amount: ctx.amount * 0.5, metadata: { kind: "thorns" } });
    }));
    expect("each grunt hit on the knight is followed by a blue number (half) on that grunt; no errors");
  });

  command("-loop", "a listener that re-deals forever must hit the chain limit", () => {
    const source = spawn(owner, FOOTMAN, 0, 0);
    const target = sturdy(spawn(hostile, GRUNT, 300, 0, 180, true), 10000);
    what("a buggy listener deals damage every time it sees damage: infinite recursion. The damage system must cut the chain at 64 instead of freezing the game.");
    let hits = 0;
    test.own(damage.observe(o => {
      if (o.metadata?.kind !== "loop") return;
      hits++;
      damage.deal({ source: o.source, target: o.target, amount: 1, metadata: { kind: "loop" } });
    }));
    damage.deal({ source, target, amount: 1, metadata: { kind: "loop" } });
    after(1, () => say(`loop: ${hits} hits before the chain was cut`));
    expect("one red [damage:chain-limit] line (the safety net firing), then 'loop: 64 hits'. The game keeps running.");
  });

  command("-cheatdeath", "isLethal: survive the first lethal hit", () => {
    const source = spawn(owner, FOOTMAN, 0, 0);
    const target = spawn(hostile, FOOTMAN, 300, 0, 180, true);
    buffs.apply(target, { id: "test.cheat", kind: "active" });
    what("a 'cheat death' buff: the first lethal hit leaves the unit at 1 HP and uses up the buff (isLethal in a late afterArmor listener).");
    test.own(damage.afterArmor(ctx => {
      if (!isLethal(ctx) || !buffs.has(ctx.target, "test.cheat")) return;
      ctx.amount = Math.max(0, GetWidgetLife(ctx.target) - 1);
      buffs.get(ctx.target, "test.cheat")?.remove("removed");
      flash("Abilities\\Spells\\Human\\HolyBolt\\HolyBoltSpecialArt.mdl", GetUnitX(ctx.target), GetUnitY(ctx.target));
      say("cheated death");
    }, 100));
    const nuke = () => damage.deal({ source, target, amount: 1000, metadata: { kind: "nuke" },
      options: { attackType: ATTACK_TYPE_CHAOS, damageType: DAMAGE_TYPE_UNIVERSAL } });
    nuke();
    after(0.5, () => say(`after hit 1: alive=${tostring(alive(target))}, life ${fmt(GetWidgetLife(target))}`));
    after(1, nuke);
    after(1.5, () => say(`after hit 2: alive=${tostring(alive(target))}`));
    expect("a 1000 hit gives 'cheated death' and alive=true at about 1 life (regeneration adds a little). A second 1000 hit 1 s later kills it: alive=false.");
  });

  // Dummy -----------------------------------------------------------------------------------
  command("-dummy", "dummy casts slow and storm bolt, damage credited to the caster", () => {
    const caster = spawn(owner, PALADIN, 0, 0);
    const target = sturdy(spawn(hostile, GRUNT, 500, 0, 180, true), 2000);
    what("invisible helper units ('dummies') cast real abilities for scripts. A Sorceress stands in for the dummy: it appears, casts and is removed when its 2.5 s lease ends.");
    const cast = (ability: number, order: string) => {
      const lease = dummies.cast({ owner, rawcode: DUMMY_CASTER, x: GetUnitX(target) - 250, y: GetUnitY(target),
        ability, order, target, duration: 2.5, source: caster });
      say(`${order}: order accepted=${tostring(lease.orderAccepted)}, live dummies ${dummies.size}`);
    };
    cast(DUMMY_SLOW, "slow");
    after(0.3, () => cast(DUMMY_BOLT, "creepthunderbolt"));
    after(3.5, () => say(`dummies after their leases: ${dummies.size}`));
    expect("both orders accepted, the grunt is slowed then stunned by a storm bolt, a green line credits the bolt damage to the Paladin (not the dummy), then 0 dummies.");
  });

  // Physics ---------------------------------------------------------------------------------
  command("-missile", "swept, piercing missile through a row (max 3 hits)", () => {
    const shooter = spawn(owner, FOOTMAN, 0, 0);
    for (let i = 1; i <= 5; i++) sturdy(spawn(hostile, GRUNT, 150 * i + 100, 0, 180, true), 500);
    let hits = 0;
    const z = terrain.height(origin.x, origin.y) + MISSILE_HEIGHT;
    const start = { x: origin.x + 40, y: origin.y, z };
    launch({
      position: start, velocity: { x: 2400, y: 0, z: 0 }, radius: 16, lifetime: 2, maxHits: 3,
      visual: new WarcraftMissileVisual("Abilities\\Weapons\\GryphonRiderMissile\\GryphonRiderMissile.mdl", start),
      onHit: (_m, u) => {
        hits++;
        damage.deal({ source: shooter, target: u, amount: 30, metadata: { kind: "missile" } });
        float(u, `hit ${hits}`, 255, 255, 255);
      },
      onEnd: (_m, reason) => say(`missile ended: ${reason} after ${hits} hits`),
    });
    expect("very fast (75 units/tick) yet hits exactly the first 3 grunts in order; 'missile ended: hit-limit after 3 hits'");
  });

  command("-arc", "gravity shells that end on the ground", () => {
    const shooter = spawn(owner, FOOTMAN, 0, 0);
    const gravity = 1400;
    const flight = 1.2;
    for (let i = 0; i < 5; i++) {
      const shell = i + 1; // Closures must not capture `i`: TSTL shares one loop variable (lint: lua-loop-closure).
      const tx = origin.x + 500 + i * 120, ty = origin.y - 300 + i * 150;
      // Grunt 100 past the impact: outside the shell's path, inside its 150 splash.
      if (i % 2 === 0) sturdy(spawn(hostile, GRUNT, tx - origin.x + 100, ty - origin.y, 180, true), 400);
      const start = { x: origin.x, y: origin.y, z: terrain.height(origin.x, origin.y) + MISSILE_HEIGHT };
      const dz = terrain.height(tx, ty) - start.z;
      launch({
        position: start,
        velocity: { x: (tx - start.x) / flight, y: (ty - start.y) / flight, z: (dz + 0.5 * gravity * flight * flight) / flight },
        acceleration: { x: 0, y: 0, z: -gravity }, radius: 20, lifetime: 4,
        visual: new WarcraftMissileVisual("Abilities\\Weapons\\Mortar\\MortarMissile.mdl", start),
        onEnd: (m, reason) => {
          const at = m.position;
          flash("Abilities\\Weapons\\Mortar\\MortarMissile.mdl", at.x, at.y);
          const splashed = unitsInRange(at.x, at.y, 150, v => IsUnitEnemy(v, owner));
          for (const u of splashed) damage.deal({ source: shooter, target: u, amount: 60, metadata: { kind: "shell" } });
          say(`shell ${shell}: ${reason} at z ${fmt(at.z)} (ground ${fmt(terrain.height(at.x, at.y))}), splashed ${splashed.length}`);
        },
      });
    }
    expect("5 arcs ending with 'ground' at z = ground height ('hit-limit' if a shell clips a grunt on the way down); grunts near impacts take splash");
  });

  command("-homing", "a turn-rate limited missile chasing a moving unit", () => {
    const shooter = spawn(owner, FOOTMAN, 0, 0);
    const runner = sturdy(spawn(hostile, KNIGHT, 800, 400, 180), 1500);
    IssuePointOrder(runner, "patrol", origin.x + 800, origin.y - 600);
    const start = { x: origin.x, y: origin.y, z: terrain.height(origin.x, origin.y) + MISSILE_HEIGHT };
    launch({
      position: start, velocity: { x: 0, y: -450, z: 0 }, radius: 20, lifetime: 8,
      visual: new WarcraftMissileVisual("Abilities\\Weapons\\FrostWyrmMissile\\FrostWyrmMissile.mdl", start),
      steer: (m, dt) => {
        if (!alive(runner)) { m.dispose(); return; }
        const at = m.position;
        const aim = { x: GetUnitX(runner) - at.x, y: GetUnitY(runner) - at.y,
          z: terrain.height(GetUnitX(runner), GetUnitY(runner)) + MISSILE_HEIGHT - at.z };
        m.velocity = turnToward(m.velocity, aim, 2.5 * dt);
      },
      onHit: (_m, u) => damage.deal({ source: shooter, target: u, amount: 100, metadata: { kind: "homing" } }),
      onEnd: (m, reason) => say(`homing missile: ${reason} after ${fmt(m.age)}s`),
    });
    expect("launched away from the knight, it curves round and catches it: 'homing missile: hit-limit'");
  });

  command("-knock", "radial knockback with falloff, one replaced", () => {
    const center = { x: origin.x + 400, y: origin.y };
    const ends = new Map<KnockbackEnd, number>();
    const record = (reason: KnockbackEnd) => ends.set(reason, (ends.get(reason) ?? 0) + 1);
    const victims: unit[] = [];
    for (let i = 0; i < 6; i++) {
      const angle = i * Math.PI / 3;
      victims.push(sturdy(spawn(hostile, GRUNT, 400 + Math.cos(angle) * 120, Math.sin(angle) * 120, 0, true), 800));
    }
    flash("Abilities\\Spells\\Human\\Thunderclap\\ThunderClapCaster.mdl", center.x, center.y);
    victims.forEach((u, i) => {
      const angle = Atan2(GetUnitY(u) - center.y, GetUnitX(u) - center.x);
      knockback.apply(u, { velocity: knockbackVelocity(angle, 400, 0.6, "linear"), duration: 0.6, falloff: "linear", onEnd: record });
      if (i === 0) knockback.apply(u, { velocity: knockbackVelocity(angle + Math.PI / 2, 400, 0.6), duration: 0.6, onEnd: record });
    });
    after(1, () => {
      const parts: string[] = [];
      for (const [reason, count] of ends) parts.push(`${reason} ${count}`);
      say(`knockback ends: ${parts.join(", ")}`);
    });
    expect("6 grunts slide outward and slow to a stop. The east one is deliberately re-pushed NORTH to test replacement, so the ring ends lopsided. 'replaced 1, completed 6' ('blocked' if pushed into cliffs or water).");
  });

  command("-stress", "[n] missiles + 200 buffs; prints physics CPU cost per tick", (_p, args) => {
    const count = parseCount(args[1], 150, 1000);
    const z = terrain.height(origin.x, origin.y) + MISSILE_HEIGHT;
    for (let i = 0; i < count; i++) {
      const angle = i * 2 * Math.PI / count;
      launch({ position: { x: origin.x, y: origin.y, z }, velocity: { x: Math.cos(angle) * 300, y: Math.sin(angle) * 300, z: 0 },
        radius: 10, lifetime: 3 });
    }
    const holders: unit[] = [];
    for (let i = 0; i < 20; i++) holders.push(spawn(hostile, GRUNT, -1500 + (i % 5) * 100, 1500 + Math.floor(i / 5) * 100, 0, true));
    for (let d = 0; d < 10; d++) {
      const def: BuffDefinition<unit> = { id: `stress.${d}`, kind: "active", duration: 2 + d * 0.1, interval: 0.5, onTick: () => {} };
      for (const u of holders) buffs.apply(u, def);
    }
    what("a CPU benchmark, not a fight: invisible harmless missiles fly outward while 20 grunts each hold 10 ticking buffs. Nothing takes damage.");
    physicsCpu = 0; physicsTicks = 0; profiling = true;
    say(`launched ${missiles.size} missiles, pending tasks ${clock.pending}`);
    after(2, () => {
      profiling = false;
      if (physicsTicks === 0) say("os.clock is unavailable in this Lua; no CPU figure");
      else say(`physics: ${string.format("%.3f", physicsCpu / physicsTicks * 1000)} ms/tick over ${physicsTicks} ticks with ~${count} missiles`);
    });
    expect(`'launched ${count} missiles', then ms/tick. Under about 1 ms per tick is healthy; also try -stress 500.`);
  });

  // Persistence -----------------------------------------------------------------------------
  command("-save", "[gold] encode a player-bound code and write it to a local file", (p, args) => {
    const id = GetPlayerId(p);
    const profile = { ...profileOf(id), gold: parseCount(args[1], 1234, 2147483647) };
    profiles.set(id, profile);
    const encoded = codec.encode(profile, bindingOf(id));
    if (!encoded.ok) { say(`${RED}encode failed:${END} ${encoded.error}`); return; }
    say(`code (${encoded.value.length} chars): ${encoded.value}`);
    if (GetLocalPlayer() === p) {
      const written = store.write("profile", encoded.value); // Local disk only; shared state untouched.
      say(written.ok ? "written to CustomMapData\\W3LibTest\\profile.pld (unverified by the engine)" : `${RED}write failed:${END} ${written.error}`);
    }
    expect("then restart the map and type -load");
  });

  command("-load", "read the local file and sync it to every player", p => {
    const id = GetPlayerId(p);
    const session = `L${loadSession++}`;
    const expected = receiver.expect(id, session, clock.elapsed); // Every client authorises the transfer.
    if (!expected.ok) { say(`${RED}cannot expect load:${END} ${expected.error}`); return; }
    if (GetLocalPlayer() === p) {
      const read = store.read("profile");
      if (!read.ok) say(`${RED}local read failed:${END} ${read.error} (nothing saved yet, or Preload is blocked)`);
      else {
        const sent = transport.send(id, session, read.value);
        if (!sent.ok) say(`${RED}sync send failed:${END} ${sent.error}`);
      }
    }
    expect("a green 'synced load' line on every client with the saved gold");
  });

  command("-code", "<code> decode a code typed into chat (bound to your name)", (p, args) => {
    const code = args[1];
    if (code === undefined) { say("usage: -code W3S1:..."); return; }
    const decoded = codec.decode(code, bindingOf(GetPlayerId(p)));
    say(decoded.ok ? `${GREEN}valid:${END} ${describe(decoded.value)}` : `${RED}rejected:${END} ${decoded.error}`);
  });

  command("-migrate", "encode with a v1-only codec, decode with v2", p => {
    const old = new SaveCodec(1, [v1]).encode({ gold: 777 }, bindingOf(GetPlayerId(p)));
    if (!old.ok) { say(`${RED}v1 encode failed${END}`); return; }
    const decoded = codec.decode(old.value, bindingOf(GetPlayerId(p)));
    say(decoded.ok ? `v1 code migrated: ${describe(decoded.value)}` : `${RED}migration failed:${END} ${decoded.error}`);
    expect("gold=777 level=1 hero=none");
  });

  // Time ------------------------------------------------------------------------------------
  command("-time", "simulation, build and local wall-clock time", () => {
    const sim = new SimulationTime(clock);
    const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const build = unixToUtc(BUILD_UNIX);
    say(`simulation: ${formatDuration(sim.elapsed)} (tick ${clock.tick})`);
    if (build !== undefined) say(`build: ${formatUtc(build)} UTC, a ${weekdays[dayOfWeek(BUILD_UNIX) ?? 0]}`);
    const wall = new LocalWallTime(readWarcraftUtc).read(); // os.date("!*t"); Warcraft has no os.time
    const local = wall !== undefined ? unixToUtc(wall.unixSeconds) : undefined;
    say(local !== undefined ? `local wall clock (untrusted, per client): ${formatUtc(local)} UTC` : "local wall clock: unavailable (no os.date)");
    expect("the wall-clock line tells you whether os.time exists in this Warcraft build");
  });

  // ── Chat dispatch ──────────────────────────────────────────────────────────────────────────
  const chat = CreateTrigger()!;
  for (const id of humans) TriggerRegisterPlayerChatEvent(chat, Player(id)!, "-", false);
  const action = TriggerAddAction(chat, () => {
    const text = GetEventPlayerChatString() ?? "";
    if (text.charAt(0) !== "-") return;
    const args = text.split(" ").filter(part => part.length > 0);
    const entry = commands.get(args[0].toLowerCase());
    if (entry === undefined) return;
    if (args[0] !== "-log" && args[0] !== "-status") ClearTextMessages();
    try { entry.run(GetTriggerPlayer()!, args); } catch (error) { report(args[0], error); }
  });
  root.own(() => { TriggerRemoveAction(chat, action); DestroyTrigger(chat); });

  damage.start();
  root.own(startWarcraftClock(clock));
  say(`${GOLD}lib test bed ready.${END} Type ${GOLD}-help${END}.`);
}

/** Pure checks compiled to Lua and run by the real engine: the in-game twin of local/tools/lua-harness.ts. */
function runSelfTest(): void {
  let checks = 0;
  let failures = 0;
  const check = (name: string, actual: unknown, expected: unknown) => {
    checks++;
    if (actual !== expected) { failures++; print(`${RED}FAIL${END} ${name}: got ${tostring(actual)}, expected ${tostring(expected)}`); }
  };

  const hits: number[] = [];
  const t = (id: number): CollisionTarget<number> => ({ id, target: id, position: { x: 50, y: 0, z: 0 }, radius: 1 });
  const ms = new MissileSystem<number>({ candidates: () => [t(9), t(4), t(7), t(2), t(8), t(1)], valid: () => true });
  ms.launch({ position: { x: 0, y: 0, z: 0 }, velocity: { x: 100, y: 0, z: 0 }, radius: 1, lifetime: 10, maxHits: 6, onHit: (_, u) => { hits.push(u); } });
  ms.update(1);
  check("missile tie-break", hits.join(","), "1,2,4,7,8,9");

  const big = new SaveCodec(1, [{ version: 1, fields: [{ key: "gold", kind: "number", min: 0, max: 2147483647, integer: true }] }]);
  const gold = 2147483647;
  const encoded = big.encode({ gold }, "Player#1");
  const decoded = encoded.ok ? big.decode(encoded.value, "Player#1") : undefined;
  check("exact save integer", decoded !== undefined && decoded.ok && decoded.value.gold === gold, true);
  check("binding rejects", encoded.ok && big.decode(encoded.value, "Other").ok, false);
  check("integerText", integerText(2147483647), "2147483647");
  // Informational: Warcraft's Lua number width (expected: 32-bit, so 2^24 + 1 is not exact).
  print(`${GREY}  info: float 2^24+1 exact = ${tostring(16777216 / 1 + 1 !== 16777216)} (false means 32-bit floats)${END}`);

  check("tick rounding", new Scheduler(0.01).ticks(0.07), 7);
  const nan = 0 / 0;
  print(`${GREY}  info: NaN == NaN is ${tostring(nan === nan)} (true means NaN cannot be detected by self-comparison)${END}`);
  const clock = new Scheduler(1);
  const order: string[] = [];
  clock.after(3, () => { order.push("c3"); });
  clock.every(1, () => { order.push("r1"); });
  clock.after(1, () => { order.push("a1"); });
  const cancel = clock.after(2, () => { order.push("x"); });
  clock.after(2, () => { order.push("b2"); });
  cancel();
  clock.advance(); clock.advance(); clock.advance();
  check("heap order", order.join(","), "r1,a1,r1,b2,c3,r1");

  let ticks = 0;
  const buffClock = new Scheduler(1);
  const store = new BuffStore<string>(buffClock);
  store.apply("u", { id: "dot", kind: "active", duration: 3, interval: 1, onTick: () => { ticks++; } });
  for (let i = 0; i < 4; i++) buffClock.advance();
  check("dot ticks", ticks, 3);
  store.apply("u", { id: "talent", kind: "passive" });
  store.clearTarget("u", "death");
  check("passive survives death", store.has("u", "talent"), true);

  const positions = new Map<number, { x: number; y: number }>([[1, { x: 0, y: 0 }]]);
  const kb = new KnockbackSystem<number>({ valid: () => true, position: u => positions.get(u)!, move: (u, p) => { positions.set(u, p); return true; } });
  kb.apply(1, { velocity: knockbackVelocity(0, 300, 1, "linear"), duration: 1, falloff: "linear" });
  kb.update(0.5); kb.update(0.5);
  check("knockback distance", Math.abs(positions.get(1)!.x - 300) < 0.01, true); // 32-bit floats in game

  check("formatDuration", formatDuration(3725), "1:02:05");
  check("weekday before 1970", dayOfWeek(-86400), 3);
  check("calendar round trip", utcToUnix(unixToUtc(-1234567890)!), -1234567890);

  const code = hexEncode("x".repeat(400));
  const receiver = new SyncReceiver();
  receiver.expect(1, "s1", 0);
  let synced: string | undefined;
  for (const packet of chunkSaveCode("s1", code)) {
    const r = receiver.accept(1, packet, 0);
    if (r.ok && r.value !== undefined) synced = r.value;
  }
  check("sync chunks", synced, code);

  let handlers: { damaging: (e: DamageEvent<string>) => void; damaged: (e: DamageEvent<string>) => void; settled: () => void } | undefined;
  const writes: number[] = [];
  const pipeline = new DamageSystem<string, string, undefined>({
    subscribe: h => { handlers = h; return () => { handlers = undefined; }; },
    setAmount: a => { writes.push(a); },
    deal: r => {
      handlers!.damaging({ source: r.source, target: r.target, amount: r.amount, isAttack: false });
      handlers!.damaged({ source: r.source, target: r.target, amount: r.amount / 2, isAttack: false });
      return true;
    },
  });
  pipeline.beforeArmor(c => { c.amount *= 2; });
  pipeline.afterArmor(c => { c.amount -= 1; });
  pipeline.start();
  pipeline.deal({ source: "s", target: "t", amount: 10 });
  check("damage phases", `${writes[0] === 20}/${writes[1] === 4}`, "true/true");
  pipeline.dispose();

  // TSTL hazards: a named function as an optional callback, and closures inside for (let ...).
  let reason: string | undefined;
  const onEnd = (why: string) => { reason = why; };
  const kb2 = new KnockbackSystem<number>({ valid: () => true, position: () => ({ x: 0, y: 0 }), move: () => true });
  kb2.apply(1, { velocity: { x: 1, y: 0 }, duration: 0.1, onEnd });
  kb2.update(1);
  check("named callback gets its argument", reason, "completed");
  const captured: (() => number)[] = [];
  for (let i = 0; i < 3; i++) { const copy = i; captured.push(() => copy); }
  check("loop copy captured per iteration", captured.map(f => f()).join(","), "0,1,2");
  let swallowed = true;
  try { (() => { try { error("boom"); } catch (e) { throw e; } })(); } catch { swallowed = false; }
  check("try/catch rethrow propagates", swallowed, false);

  print(failures === 0
    ? `${GREEN}selftest: ${checks}/${checks} passed in Warcraft's Lua${END}`
    : `${RED}selftest: ${failures} of ${checks} failed${END}`);
}

addScriptHook(W3TS_HOOK.MAIN_AFTER, tsMain);
