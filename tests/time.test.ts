import { strict as assert } from "node:assert";
import { isLeapYear, utcToUnix, unixToUtc, SimulationTime, LocalWallTime, dayOfWeek, formatDuration, formatUtc } from "../time/index.ts";
Deno.test("UTC calendar conversion handles Unix epoch, negative timestamps, leap days and century rules", () => {
  assert.equal(isLeapYear(2000), true); assert.equal(isLeapYear(1900), false); assert.equal(isLeapYear(2024), true);
  assert.equal(utcToUnix({ year: 1970, month: 1, day: 1 }), 0);
  assert.deepEqual(unixToUtc(-1), { year: 1969, month: 12, day: 31, hour: 23, minute: 59, second: 59 });
  assert.equal(utcToUnix({ year: 2000, month: 2, day: 29, hour: 12 }), 951825600);
  assert.equal(utcToUnix({ year: 1900, month: 2, day: 29 }), undefined);
  assert.equal(utcToUnix({ year: 2024, month: 13, day: 1 }), undefined);
  assert.equal(utcToUnix({ year: 2024, month: 2, day: 30 }), undefined);
  assert.equal(unixToUtc(NaN), undefined); assert.equal(unixToUtc(0.5), undefined);
  for (const year of [1, 1600, 1900, 2000, 2024, 9999]) {
    const date = { year, month: 12, day: 31, hour: 23, minute: 59, second: 59 };
    assert.deepEqual(unixToUtc(utcToUnix(date)!), date);
  }
});
Deno.test("simulation clock reads elapsed scheduler time and wall time is explicit local untrusted data", () => {
  const scheduler = { elapsed: 3 }; const simulation = new SimulationTime(scheduler);
  assert.equal(simulation.elapsed, 3); scheduler.elapsed = 5; assert.equal(simulation.elapsed, 5);
  assert.equal(new LocalWallTime().read(), undefined);
  assert.deepEqual(new LocalWallTime(() => 0).read(), { unixSeconds: 0, authority: "local-untrusted" });
  assert.equal(new LocalWallTime(() => Infinity).read(), undefined);
  assert.equal(new LocalWallTime(() => { throw Error("unavailable"); }).read(), undefined);
});

Deno.test("display helpers format durations, UTC dates and weekdays", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(65.9), "1:05");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(-3), "0:00");
  assert.equal(formatUtc(unixToUtc(951782400)!), "2000-02-29 00:00:00");
  assert.equal(formatUtc({ year: 12, month: 3, day: 4, hour: 5, minute: 6, second: 7 }), "0012-03-04 05:06:07");
  assert.equal(dayOfWeek(0), 4);          // 1970-01-01 was a Thursday.
  assert.equal(dayOfWeek(-86400), 3);     // Negative days stay in range.
  assert.equal(dayOfWeek(951782400), 2);  // 2000-02-29 was a Tuesday.
  assert.equal(dayOfWeek(0.5), undefined);
});
