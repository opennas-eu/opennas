import test from "node:test";
import assert from "node:assert/strict";
import { nextRun, type Schedule } from "../../apps/api/src/db/system-tasks.js";

/**
 * When a scheduled task next comes round.
 *
 * All of this is in *local* time on purpose - "3am" means 3am where the NAS is -
 * so the tests build local Dates rather than parsing ISO strings, which would
 * quietly become UTC and pass or fail depending on the machine's timezone.
 */

const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s);

const daily = (hour: number, minute = 0): Schedule => ({
  frequency: "daily", hour, minute, weekday: 0, dayOfMonth: 1,
});
const weekly = (weekday: number, hour = 3): Schedule => ({
  frequency: "weekly", hour, minute: 0, weekday, dayOfMonth: 1,
});
const monthly = (dayOfMonth: number, hour = 3): Schedule => ({
  frequency: "monthly", hour, minute: 0, weekday: 0, dayOfMonth,
});

test("daily: later today when the time is still ahead", () => {
  assert.deepEqual(nextRun(daily(3, 30), at(2026, 3, 10, 1, 0)), at(2026, 3, 10, 3, 30));
});

test("daily: tomorrow when the time has gone by", () => {
  assert.deepEqual(nextRun(daily(3), at(2026, 3, 10, 4, 0)), at(2026, 3, 11, 3, 0));
});

test("daily: exactly on the minute counts as gone by", () => {
  // Strictly after `from`, so a task that just ran is not immediately due again -
  // otherwise the runner would loop on it.
  assert.deepEqual(nextRun(daily(3), at(2026, 3, 10, 3, 0)), at(2026, 3, 11, 3, 0));
});

test("daily: seconds are dropped", () => {
  const r = nextRun(daily(3), at(2026, 3, 10, 1, 0, 47));
  assert.equal(r.getSeconds(), 0);
  assert.equal(r.getMilliseconds(), 0);
});

test("daily: rolls over a month and a year boundary", () => {
  assert.deepEqual(nextRun(daily(3), at(2026, 1, 31, 5, 0)), at(2026, 2, 1, 3, 0));
  assert.deepEqual(nextRun(daily(3), at(2026, 12, 31, 5, 0)), at(2027, 1, 1, 3, 0));
});

test("weekly: later this week", () => {
  // 2026-03-10 is a Tuesday (getDay 2). Friday is 5.
  assert.equal(at(2026, 3, 10).getDay(), 2);
  assert.deepEqual(nextRun(weekly(5), at(2026, 3, 10, 12, 0)), at(2026, 3, 13, 3, 0));
});

test("weekly: same weekday, time already gone by, means next week", () => {
  assert.deepEqual(nextRun(weekly(2), at(2026, 3, 10, 12, 0)), at(2026, 3, 17, 3, 0));
});

test("weekly: same weekday, time still ahead, means today", () => {
  assert.deepEqual(nextRun(weekly(2), at(2026, 3, 10, 1, 0)), at(2026, 3, 10, 3, 0));
});

test("weekly: Sunday is 0 and wraps backwards correctly", () => {
  // From Tuesday, the next Sunday is five days on, not minus two.
  assert.deepEqual(nextRun(weekly(0), at(2026, 3, 10, 12, 0)), at(2026, 3, 15, 3, 0));
});

test("weekly: an out-of-range weekday is folded rather than throwing", () => {
  assert.deepEqual(nextRun(weekly(7), at(2026, 3, 10, 12, 0)), nextRun(weekly(0), at(2026, 3, 10, 12, 0)));
  assert.deepEqual(nextRun(weekly(-1), at(2026, 3, 10, 12, 0)), nextRun(weekly(6), at(2026, 3, 10, 12, 0)));
});

test("monthly: later this month", () => {
  assert.deepEqual(nextRun(monthly(20), at(2026, 3, 10, 12, 0)), at(2026, 3, 20, 3, 0));
});

test("monthly: next month once the day has passed", () => {
  assert.deepEqual(nextRun(monthly(5), at(2026, 3, 10, 12, 0)), at(2026, 4, 5, 3, 0));
});

test("monthly: the 31st lands on the last day of a short month", () => {
  // The bug this guards against is "the 31st" silently rolling into the 1st or
  // 3rd of the following month, which is what setDate(31) does in February.
  assert.deepEqual(nextRun(monthly(31), at(2026, 2, 1, 0, 0)), at(2026, 2, 28, 3, 0));
  assert.deepEqual(nextRun(monthly(31), at(2026, 4, 15, 0, 0)), at(2026, 4, 30, 3, 0));
  assert.deepEqual(nextRun(monthly(31), at(2026, 3, 15, 0, 0)), at(2026, 3, 31, 3, 0));
});

test("monthly: February in a leap year", () => {
  assert.deepEqual(nextRun(monthly(31), at(2028, 2, 1, 0, 0)), at(2028, 2, 29, 3, 0));
  assert.deepEqual(nextRun(monthly(29), at(2028, 2, 1, 0, 0)), at(2028, 2, 29, 3, 0));
  // 2026 is not a leap year, so the 29th clamps to the 28th.
  assert.deepEqual(nextRun(monthly(29), at(2026, 2, 1, 0, 0)), at(2026, 2, 28, 3, 0));
});

test("monthly: an out-of-range day is clamped, not wrapped", () => {
  assert.deepEqual(nextRun(monthly(99), at(2026, 3, 1, 0, 0)), at(2026, 3, 31, 3, 0));
  assert.deepEqual(nextRun(monthly(0), at(2026, 3, 15, 0, 0)), at(2026, 4, 1, 3, 0));
  assert.deepEqual(nextRun(monthly(-5), at(2026, 3, 15, 0, 0)), at(2026, 4, 1, 3, 0));
});

test("monthly: December rolls into the next year", () => {
  assert.deepEqual(nextRun(monthly(5), at(2026, 12, 10, 0, 0)), at(2027, 1, 5, 3, 0));
});

test("the answer is always strictly in the future, for a year of starts", () => {
  // A fuzz sweep, because the failure that matters is a schedule that returns a
  // time in the past - the runner would fire it immediately, every tick, forever.
  const schedules: Schedule[] = [];
  for (let h = 0; h < 24; h += 5) schedules.push(daily(h, 30));
  for (let w = 0; w < 7; w++) schedules.push(weekly(w));
  for (const d of [1, 5, 15, 28, 29, 30, 31]) schedules.push(monthly(d));

  let checked = 0;
  for (const s of schedules) {
    for (let day = 0; day < 366; day++) {
      const from = new Date(2026, 0, 1 + day, (day * 7) % 24, (day * 13) % 60, 30);
      const next = nextRun(s, from);
      assert.ok(next > from, `${JSON.stringify(s)} from ${from.toISOString()} gave ${next.toISOString()}`);
      assert.equal(next.getHours(), s.hour);
      assert.equal(next.getMinutes(), s.minute);
      checked++;
    }
  }
  assert.ok(checked > 4000, `only ${checked} combinations checked`);
});
