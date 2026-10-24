/*
 * Quake Terminal for GNOME Shell 45+
 * Copyright 2025 Diego Dario
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * If this extension breaks your desktop you get to keep all of the pieces...
 */

import Meta from "gi://Meta";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PointerWatcher from "resource:///org/gnome/shell/ui/pointerWatcher.js";
import { QuakeMode } from "./quake-mode.js";
import { EdgeDwell, monitorAtEdge } from "./sidebar.js";

export default class QuakeTerminalExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._appSystem = Shell.AppSystem.get_default();
    this._quakeMode = null;
    this._edgeDwell = new EdgeDwell(
      (delay, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        callback();
        return GLib.SOURCE_REMOVE;
      }),
      id => GLib.Source.remove(id),
      monitor => {
        // Check the actual pointer again after the dwell, even if polling paused.
        if (this._edgeMonitor() === monitor)
          this._handleQuakeModeTerminal(true, monitor).catch(console.error);
      }
    );
    this._pointerWatch = PointerWatcher.getPointerWatcher().addWatch(
      40, () => this._updateEdge()
    );
    this._edgeSettingIds = ["slide-edge", "hover-enabled", "hover-delay", "hover-width"]
      .map(key => this._settings.connect(`changed::${key}`, () => this._edgeDwell.reset()));
    this._monitorsChangedId = Main.layoutManager.connect("monitors-changed", () => {
      this._edgeDwell.reset();
      this._quakeMode?.resetMonitor();
    });

    Main.wm.addKeybinding(
      "terminal-shortcut",
      this._settings,
      Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
      Shell.ActionMode.NORMAL |
        Shell.ActionMode.OVERVIEW |
        Shell.ActionMode.POPUP,
      () =>
        this._handleQuakeModeTerminal().catch((reason) => console.log(reason))
    );
  }

  disable() {
    Main.wm.removeKeybinding("terminal-shortcut");
    this._pointerWatch?.remove();
    this._pointerWatch = null;
    this._edgeDwell?.reset();
    this._edgeDwell = null;
    this._edgeSettingIds.forEach(id => this._settings.disconnect(id));
    Main.layoutManager.disconnect(this._monitorsChangedId);

    if (this._quakeMode) {
      this._quakeMode.destroy();
    }

    this._settings = null;
    this._appSystem = null;
    this._quakeMode = null;
  }

  /**
   * @returns {number|null} Monitor under the pointer, or null outside an edge.
   */
  _edgeMonitor() {
    if (!this._settings.get_boolean("hover-enabled") ||
        Main.overview.visible || Main.sessionMode.isLocked ||
        Main.modalCount > 0 || !Main.sessionMode.hasWindows)
      return null;
    const [x, y, modifiers] = global.get_pointer();
    // Dragging a window or selecting text must not summon the sidebar.
    if (modifiers & (Clutter.ModifierType.BUTTON1_MASK |
        Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK))
      return null;
    const index = monitorAtEdge(Main.layoutManager.monitors, x, y,
      this._settings.get_string("slide-edge"), this._settings.get_int("hover-width"));
    if (index !== null && Main.layoutManager.monitors[index]?.inFullscreen)
      return null;
    return index;
  }

  /** Update the pending edge trigger after pointer movement. */
  _updateEdge() {
    this._edgeDwell.update(this._edgeMonitor(), this._settings.get_int("hover-delay"));
  }

  /**
   * @param {boolean} showOnly - Hovering shows the window without toggling it off.
   * @param {number|null} monitorIndex - Monitor containing the hovered edge.
   * @returns {Promise<void>} Completion of window activation.
   */
  _handleQuakeModeTerminal(showOnly = false, monitorIndex = null) {
    if (this._quakeMode) {
      if (
        this._quakeMode._internalState === QuakeMode.LIFECYCLE.STARTING ||
        this._quakeMode._internalState === QuakeMode.LIFECYCLE.CREATED_ACTOR
      ) {
        return Promise.resolve();
      }
    }

    if (
      !this._quakeMode ||
      this._quakeMode._internalState === QuakeMode.LIFECYCLE.DEAD
    ) {
      const terminalId = this._settings.get_string("terminal-id");

      if (!terminalId) {
        Main.notify(_(`Select an application in Quake Terminal preferences.`));
        return Promise.resolve();
      }

      const terminal = this._appSystem.lookup_app(terminalId);

      if (!terminal) {
        Main.notify(_(`No terminal found with id ${terminalId}. Skipping ...`));
        return Promise.resolve();
      }

      this._quakeMode = new QuakeMode(terminal, this._settings);
    }

    return showOnly ? this._quakeMode.show(monitorIndex) : this._quakeMode.toggle();
  }
}
