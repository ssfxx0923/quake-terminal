/* SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright 2026 ssfxx0923
 */
import assert from "node:assert/strict";
import test from "node:test";
import { animationClip, EdgeDwell, monitorAtEdge, slideOffset } from "../src/sidebar.js";

const monitors = [
  { index: 0, x: 357, y: 0, width: 1920, height: 1080 },
  { index: 1, x: 0, y: 1080, width: 2560, height: 1440 },
];

test("right edge follows each monitor in a stacked, offset layout", () => {
  assert.equal(monitorAtEdge(monitors, 2276, 500, "right", 2), 0);
  assert.equal(monitorAtEdge(monitors, 2559, 1800, "right", 2), 1);
  assert.equal(monitorAtEdge(monitors, 2273, 500, "right", 2), null);
  assert.equal(monitorAtEdge(monitors, 2559, 500, "right", 2), null);
  assert.equal(monitorAtEdge(monitors, 2560, 1800, "right", 2), null);
  assert.equal(monitorAtEdge(monitors, 0, 0, "right", 2), null);
});

test("top edge respects monitor coordinates and the trigger width", () => {
  assert.equal(monitorAtEdge(monitors, 500, 0, "top", 2), 0);
  assert.equal(monitorAtEdge(monitors, 500, 1081, "top", 2), 1);
  assert.equal(monitorAtEdge(monitors, 500, 1082, "top", 2), null);
});

test("right and top slides fully leave the work area on the matching axis", () => {
  const area = { x: 357, y: 32, width: 1920, height: 1048 };
  const frame = { x: 1509, y: 32, width: 768, height: 1048 };
  const right = slideOffset("right", frame, area);
  assert.equal(right.translation_y, 0);
  assert.equal(frame.x + right.translation_x, area.x + area.width);
  const top = slideOffset("top", frame, area);
  assert.equal(top.translation_x, 0);
  assert.equal(frame.y + top.translation_y + frame.height, area.y);
});

test("clipping prevents right-side animation from bleeding onto another screen", () => {
  const area = { x: 0, y: 32, width: 1920, height: 1048 };
  const actor = { x: 1152, y: 32, width: 768, height: 1048,
    translation_x: 384, translation_y: 0 };
  assert.deepEqual(animationClip(actor, area), [0, 0, 384, 1048]);
  actor.translation_x = 768;
  assert.equal(animationClip(actor, area)[2], 0);
  actor.translation_x = 0;
  assert.deepEqual(animationClip(actor, area), [0, 0, 768, 1048]);
});

test("top clipping works on a lower monitor and preserves an existing clip", () => {
  const actor = { x: 0, y: 1112, width: 1000, height: 1000,
    translation_x: 0, translation_y: -500 };
  const area = { x: 0, y: 1112, width: 2560, height: 1408 };
  assert.deepEqual(animationClip(actor, area), [0, 500, 1000, 500]);
  assert.deepEqual(animationClip(actor, area, [10, 10, 900, 700]), [10, 500, 900, 210]);
});

/**
 * @returns {object} Deterministic timer and activation recorder.
 */
function dwellFixture() {
  let nextId = 0;
  const pending = new Map();
  const activated = [];
  const dwell = new EdgeDwell((delay, callback) => {
    const id = ++nextId;
    pending.set(id, { delay, callback });
    return id;
  }, id => pending.delete(id), monitor => activated.push(monitor));
  return {
    dwell, pending, activated,
    fire() {
      for (const [id, timer] of [...pending]) {
        pending.delete(id);
        timer.callback();
      }
    },
  };
}

test("dwell fires once while staying at the edge, including monitor zero", () => {
  const fixture = dwellFixture();
  fixture.dwell.update(0, 180);
  fixture.dwell.update(0, 180);
  assert.equal(fixture.pending.size, 1);
  assert.equal([...fixture.pending.values()][0].delay, 180);
  fixture.fire();
  fixture.dwell.update(0, 180);
  fixture.fire();
  assert.deepEqual(fixture.activated, [0]);
});

test("leaving before the dwell finishes cancels activation", () => {
  const fixture = dwellFixture();
  fixture.dwell.update(0, 180);
  fixture.dwell.update(null, 180);
  fixture.fire();
  assert.deepEqual(fixture.activated, []);
});

test("moving to another display restarts the dwell on that display", () => {
  const fixture = dwellFixture();
  fixture.dwell.update(0, 180);
  fixture.dwell.update(1, 180);
  assert.equal(fixture.pending.size, 1);
  fixture.fire();
  assert.deepEqual(fixture.activated, [1]);
  fixture.dwell.update(null, 180);
  fixture.dwell.update(1, 180);
  fixture.fire();
  assert.deepEqual(fixture.activated, [1, 1]);
});

test("disabling the extension cancels pending work and allows a fresh start", () => {
  const fixture = dwellFixture();
  fixture.dwell.update(1, 180);
  fixture.dwell.reset();
  fixture.fire();
  assert.deepEqual(fixture.activated, []);
  fixture.dwell.update(1, 180);
  fixture.fire();
  assert.deepEqual(fixture.activated, [1]);
});
