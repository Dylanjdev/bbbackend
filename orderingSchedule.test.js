import test from "node:test";
import assert from "node:assert/strict";
import { getOrderingScheduleStatus } from "./orderingSchedule.js";

const timeZone = "America/New_York";

test("opens at 7:30 AM on Tuesday", () => {
  assert.equal(
    getOrderingScheduleStatus("2026-11-03T12:29:00Z", timeZone).isWithinOrderingWindow,
    false,
  );
  assert.equal(
    getOrderingScheduleStatus("2026-11-03T12:30:00Z", timeZone).isWithinOrderingWindow,
    true,
  );
});

test("closes at 2:15 PM on Tuesday", () => {
  assert.equal(
    getOrderingScheduleStatus("2026-11-03T19:14:00Z", timeZone).isWithinOrderingWindow,
    true,
  );
  assert.equal(
    getOrderingScheduleStatus("2026-11-03T19:15:00Z", timeZone).isWithinOrderingWindow,
    false,
  );
});

test("uses the same ordering window on Saturday", () => {
  assert.equal(
    getOrderingScheduleStatus("2026-11-07T12:30:00Z", timeZone).isWithinOrderingWindow,
    true,
  );
});

test("stays closed on Sunday and Monday", () => {
  assert.equal(
    getOrderingScheduleStatus("2026-11-08T15:00:00Z", timeZone).isWithinOrderingWindow,
    false,
  );
  assert.equal(
    getOrderingScheduleStatus("2026-11-09T15:00:00Z", timeZone).isWithinOrderingWindow,
    false,
  );
});
