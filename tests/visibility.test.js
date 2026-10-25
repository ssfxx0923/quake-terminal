/* SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright 2026 ssfxx0923
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SidebarVisibility } from "../src/visibility.js";

/**
 * @returns {object} Window and app tracker with mutable native window lists.
 */
function fixture() {
  const sidebar = { notify() {}, is_skip_taskbar() { return false; } };
  const normal = { id: "normal" };
  const dialog = { get_transient_for() { return sidebar; } };
  const windows = [sidebar];
  const signals = new Map();
  let nextId = 0;
  const app = {
    get_windows() { return windows; },
    get_n_windows() { return windows.length; },
    connect(name, callback) { const id = ++nextId; signals.set(id, { name, callback }); return id; },
    disconnect(id) { signals.delete(id); },
    emit(name) {
      for (const signal of signals.values()) {
        if (signal.name === name) signal.callback();
      }
    },
  };
  const other = { id: "unrelated-app" };
  const refreshed = [];
  const appSystem = { get_running() { return [app, other]; }, emit() { refreshed.push(app.get_windows().length); } };
  const visibility = new SidebarVisibility(sidebar, app, appSystem);
  return { sidebar, normal, dialog, windows, app, other, appSystem, visibility, refreshed };
}

test("sidebar alone has no running app icon or switcher window", () => {
  const data = fixture();
  data.visibility.setHidden(true);
  assert.equal(data.sidebar.skip_taskbar, true);
  assert.equal(data.sidebar.skipTaskbar, true);
  assert.equal(data.sidebar.is_skip_taskbar(), true);
  assert.deepEqual(data.app.get_windows(), []);
  assert.equal(data.app.get_n_windows(), 0);
  assert.deepEqual(data.appSystem.get_running(), [data.other]);
});

test("normal windows of the same terminal still appear with accurate counts", () => {
  const data = fixture();
  data.visibility.setHidden(true);
  data.windows.push(data.normal);
  assert.deepEqual(data.app.get_windows(), [data.normal]);
  assert.equal(data.app.get_n_windows(), 1);
  assert.deepEqual(data.appSystem.get_running(), [data.app, data.other]);
  data.windows.pop();
  assert.deepEqual(data.appSystem.get_running(), [data.other]);
});

test("transient sidebar dialogs do not resurrect its Dock icon", () => {
  const data = fixture();
  data.visibility.setHidden(true);
  data.windows.push(data.dialog);
  assert.deepEqual(data.app.get_windows(), []);
  assert.deepEqual(data.appSystem.get_running(), [data.other]);
});

test("disabling visibility filtering restores the exact original methods", () => {
  const data = fixture();
  const getRunning = data.appSystem.get_running;
  const getWindows = data.app.get_windows;
  const getCount = data.app.get_n_windows;
  const skip = data.sidebar.is_skip_taskbar;
  data.visibility.setHidden(true);
  data.visibility.destroy();
  assert.equal(data.appSystem.get_running, getRunning);
  assert.equal(data.app.get_windows, getWindows);
  assert.equal(data.app.get_n_windows, getCount);
  assert.equal(data.sidebar.is_skip_taskbar, skip);
  assert.equal(Object.hasOwn(data.sidebar, "skip_taskbar"), false);
  assert.equal(Object.hasOwn(data.sidebar, "skipTaskbar"), false);
  assert.deepEqual(data.app.get_windows(), [data.sidebar]);
  data.visibility.destroy();
});

test("changing the setting can reveal and hide the same window repeatedly", () => {
  const data = fixture();
  data.visibility.setHidden(true);
  data.visibility.setHidden(false);
  assert.deepEqual(data.appSystem.get_running(), [data.app, data.other]);
  data.visibility.setHidden(true);
  data.visibility.setHidden(true);
  assert.deepEqual(data.appSystem.get_running(), [data.other]);
  data.visibility.destroy();
  assert.deepEqual(data.appSystem.get_running(), [data.app, data.other]);
});

test("opening and closing normal windows refreshes the Dock and disconnects on disable", () => {
  const data = fixture();
  data.visibility.setHidden(true);
  data.windows.push(data.normal);
  data.app.emit("windows-changed");
  assert.equal(data.refreshed.at(-1), 1);
  data.windows.pop();
  data.app.emit("windows-changed");
  assert.equal(data.refreshed.at(-1), 0);
  data.visibility.destroy();
  const count = data.refreshed.length;
  data.app.emit("windows-changed");
  assert.equal(data.refreshed.length, count);
});

test("JS visibility changes never notify the native skip-taskbar property", () => {
  const data = fixture();
  data.sidebar.notify = () => assert.fail("must not retrack a native Wayland window");
  data.visibility.setHidden(true);
  data.visibility.setHidden(false);
  data.visibility.setHidden(true);
  data.visibility.destroy();
});

test("unmanaged cleanup restores hooks silently and disconnects future refreshes", () => {
  const data = fixture();
  const getRunning = data.appSystem.get_running;
  const getWindows = data.app.get_windows;
  data.visibility.setHidden(true);
  const count = data.refreshed.length;
  const emit = data.app.emit;
  data.app.emit = () => assert.fail("must not publish windows during native removal");
  data.visibility.destroy(true);
  assert.equal(data.app.get_windows, getWindows);
  assert.equal(data.appSystem.get_running, getRunning);
  assert.equal(data.refreshed.length, count);
  data.visibility.destroy(true);
  emit.call(data.app, "windows-changed");
  assert.equal(data.refreshed.length, count);
});
