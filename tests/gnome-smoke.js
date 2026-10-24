/* SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright 2026 ssfxx0923
 * Runs only inside an isolated headless compositor.
 */
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Shell from "gi://Shell";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as Scripting from "resource:///org/gnome/shell/ui/scripting.js";

export const METRICS = {};

/**
 * @param {boolean} condition - Required runtime condition.
 * @param {string} message - Behavior being checked.
 */
function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`SIDEBAR PASS: ${message}`);
}

/**
 * @param {Function} predicate - Asynchronous condition.
 * @param {string} description - Failure description.
 * @returns {Promise<void>} Completion of the condition.
 */
async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await Scripting.sleep(25);
  }
  throw new Error(`Timeout: ${description}`);
}

/** Run the integration checks on real GNOME window actors. */
export async function run() {
  const uuid = "quake-terminal-sidebar@ssfxx0923.github.io";
  Main.overview.hide();
  await Scripting.sleep(400);
  check(Main.extensionManager.enableExtension(uuid), "fork registered in GNOME");
  const record = Main.extensionManager.lookup(uuid);
  await Scripting.sleep(600);
  await waitFor(() => record.stateObj?._settings, "extension enabled");
  const extension = record.stateObj;
  const settings = extension._settings;
  settings.set_int("hover-delay", 80);
  settings.set_int("animation-time", 180);
  settings.set_string("terminal-id", "org.gnome.Ptyxis.desktop");
  settings.set_value("launch-args-map", new GLib.Variant("a{ss}", {
    "org.gnome.Ptyxis.desktop": "--new-window -- /usr/bin/sleep 120",
  }));
  const pointer = global.stage.context.get_backend().get_default_seat()
    .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
  const move = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
  move(300, 300);
  await Scripting.sleep(100);
  Main.overview.hide();
  await waitFor(() => !Main.overview.visible && Main.modalCount === 0, "leave the startup overview");
  const monitor = Main.layoutManager.primaryMonitor;
  move(monitor.x + monitor.width - 1, monitor.y + monitor.height / 2);
  await waitFor(() => extension._quakeMode?._internalState === "RUNNING", "hover launches Ptyxis");
  const mode = extension._quakeMode;
  await waitFor(() => mode._animationState === null && mode.actor.opacity === 255 && !mode.terminalWindow.is_hidden(), "sidebar revealed");
  const area = mode.terminalWindow.get_work_area_for_monitor(monitor.index);
  const frame = mode.terminalWindow.get_frame_rect();
  check(Math.abs(frame.x + frame.width - area.x - area.width) <= 2,
    "real Ptyxis window is anchored to the right");
  check(mode.actor.translation_x === 0 && mode.actor.translation_y === 0,
    "show animation finishes without translation residue");
  const artifactDir = GLib.getenv("SIDEBAR_ARTIFACT_DIR");
  if (artifactDir) {
    const stream = Gio.File.new_for_path(`${artifactDir}/right-sidebar.png`)
      .replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
  }
  await Scripting.sleep(250);
  check(extension._quakeMode === mode && !mode.terminalWindow.is_hidden(),
    "staying at the edge does not repeatedly toggle the sidebar");
  await mode.toggle();
  await Scripting.sleep(50);
  check(mode.actor.translation_x > 0 && mode.actor.translation_y === 0,
    "hide animation travels horizontally to the right");
  await mode.show(monitor.index);
  await Scripting.sleep(300);
  check(!mode.terminalWindow.is_hidden() && mode.actor.translation_x === 0,
    "show reverses an unfinished hide without a late minimize");
  check(!mode.actor.has_clip, "animation restores the original clip");
  move(300, 300);
  await Scripting.sleep(100);
  await Scripting.createTestWindow({ width: 300, height: 200 });
  await Scripting.waitTestWindows();
  await waitFor(() => mode.terminalWindow.is_hidden(), "focus loss hides the sidebar");
  check(true, "focusing another application hides the sidebar");
  move(monitor.x + monitor.width - 1, monitor.y + monitor.height / 2);
  await waitFor(() => !mode.terminalWindow.is_hidden() && mode._animationState === null,
    "hover reopens the same window");
  check(extension._quakeMode === mode, "repeated hover reuses the same terminal session");
  const other = Main.layoutManager.monitors.find(item => item.index !== monitor.index);
  move(other.x + other.width / 2, other.y + other.height / 2);
  await Scripting.sleep(100);
  move(other.x + other.width - 1, other.y + other.height / 2);
  await waitFor(() => mode.monitorDisplayScreenIndex === other.index &&
    mode._animationState === null, "sidebar moves to the hovered monitor");
  const otherFrame = mode.terminalWindow.get_frame_rect();
  const otherArea = mode.terminalWindow.get_work_area_for_monitor(other.index);
  check(mode.terminalWindow.get_monitor() === other.index &&
    Math.abs(otherFrame.x + otherFrame.width - otherArea.x - otherArea.width) <= 2,
  "hover on a different-sized display repositions the same window correctly");
  move(300, 300);
  await mode.show(monitor.index);
  await Scripting.sleep(700);
  settings.set_string("slide-edge", "top");
  await Scripting.sleep(100);
  await mode.toggle();
  await Scripting.sleep(50);
  check(mode.actor.translation_y < 0 && mode.actor.translation_x === 0,
    "top mode uses its matching vertical animation");
  await Scripting.sleep(250);
  await mode.show(monitor.index);
  await Scripting.sleep(300);
  Main.extensionManager.disableExtension(uuid);
  await waitFor(() => extension._settings === null, "extension disabled cleanly");
  check(!mode._clearAnimationClip, "disabling cleans up animation hooks");
  console.log("SIDEBAR SMOKE COMPLETE");
}
