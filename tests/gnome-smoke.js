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
import * as AltTab from "resource:///org/gnome/shell/ui/altTab.js";

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

/**
 * @param {Clutter.VirtualInputDevice} keyboard - Isolated compositor keyboard.
 * @param {number[]} keys - Key values pressed together.
 */
function shortcut(keyboard, keys) {
  for (const key of keys)
    keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
  for (const key of [...keys].reverse())
    keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
}

/** Run the integration checks on real GNOME window actors. */
export async function run() {
  const uuid = "quake-terminal-sidebar@ssfxx0923.github.io";
  await Main.extensionManager._initializationPromise;
  new Gio.Settings({ schema_id: "org.gnome.Ptyxis" }).set_boolean("prompt-on-close", false);
  new Gio.Settings({ schema_id: "org.gnome.desktop.search-providers" })
    .set_boolean("disable-external", true);
  global.settings.set_strv("favorite-apps", []);
  const dockPath = GLib.getenv("SIDEBAR_TEST_DOCK_PATH");
  let dockModule = null;
  if (dockPath) {
    const dockSettings = new Gio.Settings({ schema_id: "org.gnome.shell.extensions.dash-to-dock" });
    dockSettings.set_boolean("show-trash", false);
    dockSettings.set_boolean("show-mounts", false);
    check(Main.extensionManager.enableExtension("ubuntu-dock@ubuntu.com"), "Ubuntu Dock registered in test session");
    const dockRecord = Main.extensionManager.lookup("ubuntu-dock@ubuntu.com");
    await waitFor(() => dockRecord.state === 1, "Ubuntu Dock enabled");
    dockModule = await import(`${Gio.File.new_for_path(dockPath).get_uri()}/docking.js`);
  }
  const dockApps = () => dockModule
    ? dockModule.DockManager.allDocks.flatMap(dock => dock.dash._box.get_children()
      .map(actor => actor.child?._delegate?.app).filter(Boolean)) : [];
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
  move(monitor.x + monitor.width - 1, monitor.y + monitor.height * 0.25);
  await Scripting.sleep(250);
  check(!extension._quakeMode, "primary top-right status area does not trigger the sidebar");
  const secondary = Main.layoutManager.monitors.find(item => item.index !== monitor.index);
  move(secondary.x + secondary.width - 1, secondary.y + secondary.height * 0.25);
  await Scripting.sleep(250);
  check(!extension._quakeMode, "secondary top-right status area also cannot trigger the sidebar");

  move(monitor.x + monitor.width - 1, monitor.y + monitor.height * 0.75);
  await waitFor(() => extension._quakeMode?._internalState === "RUNNING", "hover launches Ptyxis");
  let mode = extension._quakeMode;
  let sidebar = mode.terminalWindow;
  await waitFor(() => mode._animationState === null && mode.actor.opacity === 255 && !mode.terminalWindow.is_hidden(), "sidebar revealed");
  const area = mode.terminalWindow.get_work_area_for_monitor(monitor.index);
  const frame = mode.terminalWindow.get_frame_rect();
  const app = Shell.AppSystem.get_default().lookup_app("org.gnome.Ptyxis.desktop");
  await Scripting.sleep(300);
  check(!Shell.AppSystem.get_default().get_running().includes(app),
    "sidebar-only app is absent from the running-app list");
  const switcher = new AltTab.WindowSwitcherPopup();
  check(!switcher._getWindowList().includes(mode.terminalWindow),
    "sidebar is absent from the Alt+Tab window list");
  switcher.destroy();
  if (dockModule)
    check(!dockApps().includes(app), "Ubuntu Dock has no icon for the sidebar alone");
  check(Math.abs(frame.x + frame.width - area.x - area.width) <= 2,
    "real Ptyxis window is anchored to the right");
  check(mode.actor.translation_x === 0 && mode.actor.translation_y === 0,
    "show animation finishes without translation residue");
  settings.set_boolean("hover-enabled", false);
  settings.set_boolean("auto-hide-window", false);
  const tabFrame = sidebar.get_frame_rect();
  const tabSizes = [];
  const tabSizeId = sidebar.connect("size-changed", () => {
    const rect = sidebar.get_frame_rect();
    tabSizes.push([rect.width, rect.height]);
  });
  new Gio.Subprocess({ argv: ["ptyxis", "--tab", "--title=sidebar-tab-two", "--", "/usr/bin/sleep", "120"] }).init(null);
  await waitFor(() => sidebar.title.includes("sidebar-tab-two"), "second sidebar tab selected");
  new Gio.Subprocess({ argv: ["ptyxis", "--tab", "--title=sidebar-tab-three", "--", "/usr/bin/sleep", "120"] }).init(null);
  await waitFor(() => sidebar.title.includes("sidebar-tab-three"), "third sidebar tab selected");
  const keyboard = global.stage.context.get_backend().get_default_seat()
    .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
  Main.activateWindow(sidebar);
  await Scripting.sleep(100);
  shortcut(keyboard, [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_w]);
  await waitFor(() => sidebar.title.includes("sidebar-tab-two"), "closing the third tab selects the second");
  await Scripting.sleep(500);
  check(sidebar.get_frame_rect().width === tabFrame.width && sidebar.get_frame_rect().height === tabFrame.height,
    "closing one of three tabs retains the sidebar size");
  tabSizes.length = 0;
  shortcut(keyboard, [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_w]);
  await waitFor(() => !sidebar.title.includes("sidebar-tab-two"), "closing the second tab selects the original session");
  await Scripting.sleep(700);
  sidebar.disconnect(tabSizeId);
  console.log(`SIDEBAR TAB GEOMETRY: ${JSON.stringify({ before: [tabFrame.width, tabFrame.height], sizes: tabSizes })}`);
  const afterTabClose = sidebar.get_frame_rect();
  check(afterTabClose.width === tabFrame.width && afterTabClose.height === tabFrame.height &&
    afterTabClose.x === tabFrame.x && afterTabClose.y === tabFrame.y,
    "closing a sidebar tab preserves the configured outer size and position");
  check(tabSizes.length <= 2 && mode._animationState === null && !mode._restoringGeometry,
    "tab geometry correction settles without resize loops or another reveal animation");
  settings.set_int("horizontal-size", 30);
  await waitFor(() => sidebar.get_frame_rect().width === Math.round(area.width * 0.3) &&
    mode._animationState === null, "new sidebar width acknowledged");
  check(mode._sidebarFrame.width === sidebar.get_frame_rect().width,
    "changing sidebar settings replaces the preserved geometry");
  settings.set_int("horizontal-size", 40);
  await waitFor(() => sidebar.get_frame_rect().width === tabFrame.width && mode._animationState === null,
    "original sidebar width restored");
  settings.set_boolean("hover-enabled", true);
  settings.set_boolean("auto-hide-window", true);
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
  await Scripting.destroyTestWindows();
  move(monitor.x + monitor.width - 1, monitor.y + monitor.height * 0.75);
  await waitFor(() => !mode.terminalWindow.is_hidden() && mode._animationState === null,
    "hover reopens the same window");
  check(extension._quakeMode === mode, "repeated hover reuses the same terminal session");
  const other = Main.layoutManager.monitors.find(item => item.index !== monitor.index);
  const before = mode.terminalWindow.get_frame_rect();
  move(other.x + other.width - 1, other.y + other.height * 0.75);
  await Scripting.sleep(300);
  check(mode.terminalWindow.get_monitor() === monitor.index &&
    mode.terminalWindow.get_frame_rect().x === before.x,
  "hovering the secondary display cannot move or reveal the sidebar there");
  await mode.show(other.index);
  check(mode.terminalWindow.get_monitor() === monitor.index,
    "cross-monitor show requests are ignored while the sidebar is expanded");
  mode._hideTerminalWithAnimation();
  move(other.x + other.width / 2, other.y + other.height * 0.75);
  await Scripting.sleep(40);
  move(other.x + other.width - 1, other.y + other.height * 0.75);
  check(mode.isPresenting && extension._edgeMonitor() === null,
    "the other display stays blocked during the closing animation");
  await waitFor(() => !mode.isPresenting && sidebar.minimized, "sidebar fully retracted");
  move(other.x + other.width / 2, other.y + other.height * 0.75);
  await Scripting.sleep(100);
  move(other.x + other.width - 1, other.y + other.height * 0.75);
  await waitFor(() => mode.terminalWindow.get_monitor() === other.index &&
    !sidebar.minimized && mode._animationState === null, "secondary lower edge reveals the sidebar after closing");
  check(mode.terminalWindow === sidebar && mode.activeMonitorIndex === other.index,
    "the same terminal can reveal on the second display only after fully closing");
  move(monitor.x + monitor.width - 1, monitor.y + monitor.height * 0.75);
  await Scripting.sleep(300);
  check(mode.activeMonitorIndex === other.index,
    "returning to the first display cannot steal an expanded sidebar back");
  mode.hideImmediately();
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
  settings.set_string("slide-edge", "right");
  settings.set_int("animation-time", 300);
  mode.hideImmediately();
  await mode.show(monitor.index);
  await Scripting.sleep(200);
  check(mode._animationState === "showing" && mode.actor.translation_x > 0,
    "300ms reveal is still animating after 200ms");
  await waitFor(() => mode._animationState === null, "slower reveal completed");
  move(monitor.x + monitor.width - 1, monitor.y + monitor.height * 0.75);
  Main.overview.show();
  await waitFor(() => Main.overview.visible, "Super overview opened");
  await waitFor(() => sidebar.minimized && !mode._desiredVisible,
    "sidebar minimized during Super overview");
  check(sidebar.minimized && !mode._desiredVisible,
    "entering Super overview minimizes the underlying sidebar");
  Main.overview.hide();
  await waitFor(() => !Main.overview.visible, "Super overview closed");
  await Scripting.sleep(600);
  check(sidebar.is_hidden() && mode.actor.opacity === 0,
    "returning from Super keeps the sidebar hidden even with the pointer at the edge");
  move(monitor.x + monitor.width / 2, monitor.y + monitor.height * 0.75);
  await Scripting.sleep(100);
  move(monitor.x + monitor.width - 1, monitor.y + monitor.height * 0.75);
  await waitFor(() => !sidebar.is_hidden() && mode._animationState === null,
    "fresh edge visit reveals the sidebar after leaving overview");
  check(true, "fresh hover after Super reopens the same sidebar normally");
  Main.overview.showApps();
  await waitFor(() => Main.overview.visible, "application grid opened");
  await waitFor(() => sidebar.minimized, "sidebar minimized during application grid");
  check(sidebar.minimized, "opening the application grid hides the sidebar");
  Main.overview.hide();
  await waitFor(() => !Main.overview.visible, "application grid closed");
  await Scripting.sleep(600);
  check(sidebar.is_hidden() && !mode._desiredVisible,
    "returning from the application grid does not flash the sidebar");
  /* eslint-disable no-await-in-loop */
  for (const phase of ["visible", "showing", "hiding", "minimized", "no-auto-hide", "no-animation", "maximized", "maximized-no-animation"]) {
    const closingMode = mode;
    const closingSidebar = sidebar;
    const revealMonitor = phase === "maximized-no-animation" ? secondary : monitor;
    const revealArea = sidebar.get_work_area_for_monitor(revealMonitor.index);
    move(300, 300);
    await Scripting.sleep(100);
    settings.set_boolean("auto-hide-window", phase !== "no-auto-hide");
    const maximized = phase.startsWith("maximized");
    settings.set_int("animation-time", phase.endsWith("no-animation") ? 0 : 300);
    mode.hideImmediately();
    await mode.show(monitor.index);
    if (phase === "showing") {
      await waitFor(() => closingMode._animationState === "showing", "close during reveal animation");
    } else {
      await waitFor(() => closingMode._animationState === null && !closingSidebar.minimized, "sidebar ready to close");
    }
    if (phase === "hiding") {
      mode._hideTerminalWithAnimation();
      await Scripting.sleep(40);
    } else if (phase === "minimized") {
      mode.hideImmediately();
    }
    if (maximized) {
      sidebar.maximize();
      await waitFor(() => closingSidebar.is_maximized() &&
        closingSidebar.get_frame_rect().width === area.width, "sidebar maximized before closing");
      settings.set_value("launch-args-map", new GLib.Variant("a{ss}", {
        "org.gnome.Ptyxis.desktop": "--new-window --maximize -- /usr/bin/sleep 120",
      }));
    }
    const closedActor = mode.actor;
    sidebar.delete(global.get_current_time());
    await waitFor(() => closingMode._internalState === "DEAD", "closing sidebar releases its controller");
    mode.destroy(true);
    check(!mode._visibility && !mode._terminalWindow && mode._settingsWatchingListIds.length === 0,
      `close cleanup is complete and idempotent (${phase})`);
    check(!mode._geometrySignalId && !mode._geometryLaterId && !mode._sidebarFrame,
      `closing releases the geometry constraint (${phase})`);
    const invalidFrames = [];
    let revealedFrames = 0;
    const paintId = global.stage.connect("after-paint", () => {
      const candidate = extension._quakeMode;
      if (!candidate || candidate === closingMode || !candidate.actor || candidate.actor.opacity === 0)
        return;
      revealedFrames++;
      const rect = candidate.terminalWindow.get_frame_rect();
      if (rect.width > Math.round(revealArea.width * 0.4) + 2 || candidate.actor.__animationInfo)
        invalidFrames.push([rect.width, rect.height, candidate._animationState]);
    });
    move(revealMonitor.x + revealMonitor.width - 1, revealMonitor.y + revealMonitor.height * 0.75);
    await waitFor(() => extension._quakeMode !== closingMode && extension._quakeMode?._internalState === "RUNNING",
      "hover creates a new terminal after closing the old one");
    mode = extension._quakeMode;
    sidebar = mode.terminalWindow;
    const replacementMode = mode;
    await waitFor(() => replacementMode._animationState === null && !replacementMode.terminalWindow.minimized,
      "replacement sidebar revealed");
    await Scripting.sleep(50);
    global.stage.disconnect(paintId);
    check(revealedFrames > 0 && invalidFrames.length === 0,
      `reopened sidebar never paints a full-width window or native resize clone (${phase}): ${JSON.stringify(invalidFrames)}`);
    check(sidebar.get_monitor() === revealMonitor.index,
      `replacement sidebar reveals on the requested display (${phase})`);
    await waitFor(() => !global.get_window_actors().includes(closedActor) && !Main.wm._destroying.has(closedActor),
      "closed actor and native destroy effect are released");
    check(!Shell.AppSystem.get_default().get_running().includes(app) &&
      !app.get_windows().includes(sidebar), `close and reopen safely preserves Dock filtering (${phase})`);
  }
  /* eslint-enable no-await-in-loop */
  settings.set_boolean("auto-hide-window", true);
  settings.set_value("launch-args-map", new GLib.Variant("a{ss}", {
    "org.gnome.Ptyxis.desktop": "--new-window -- /usr/bin/sleep 120",
  }));
  settings.set_int("animation-time", 300);
  settings.set_boolean("hover-enabled", false);
  new Gio.Subprocess({ argv: ["ptyxis", "--new-window", "--", "/usr/bin/true"] }).init(null);
  await waitFor(() => app.get_windows().length > 0, "normal terminal window opened");
  const normal = app.get_windows()[0];
  check(normal !== mode.terminalWindow && app.get_n_windows() === 1,
    "regular terminal window remains listed with the sidebar excluded from its count");
  check(Shell.AppSystem.get_default().get_running().includes(app),
    "normal terminal window restores the running app");
  if (dockModule) {
    await waitFor(() => dockApps().includes(app), "normal terminal icon appears in Ubuntu Dock");
    check(true, "Ubuntu Dock shows a normally opened terminal");
  }
  normal.delete(global.get_current_time());
  await waitFor(() => app.get_windows().length === 0, "normal terminal closed");
  if (dockModule) {
    await waitFor(() => !dockApps().includes(app), "Dock icon removed with the last normal terminal");
    check(true, "closing the normal terminal leaves no sidebar icon in Ubuntu Dock");
  }
  Main.extensionManager.disableExtension(uuid);
  await waitFor(() => extension._settings === null, "extension disabled cleanly");
  check(!mode._clearAnimationClip, "disabling cleans up animation hooks");
  check(!mode._geometrySignalId && !mode._geometryLaterId && !mode._sidebarFrame,
    "disabling releases the geometry constraint on the surviving terminal");
  check(app.get_windows().includes(sidebar),
    "disabling restores ordinary terminal window discovery");
  console.log("SIDEBAR SMOKE COMPLETE");
}
