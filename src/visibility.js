/* SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright 2026 ssfxx0923
 */

/**
 * Match the sidebar and its transient dialogs without affecting other windows.
 *
 * @param {object} window - Window to inspect.
 * @param {object} sidebar - Managed sidebar window.
 * @returns {boolean} Whether the window belongs to the sidebar.
 */
export function isSidebarWindow(window, sidebar) {
  for (let parent = window; parent; parent = parent.get_transient_for?.()) {
    if (parent === sidebar)
      return true;
  }
  return false;
}

/** Hide one window from GNOME's JS consumers and the running-app list. */
export class SidebarVisibility {
  /**
   * @param {object} window - Managed Meta.Window.
   * @param {object} app - Shell.App containing the window.
   * @param {object} appSystem - Shell.AppSystem singleton.
   */
  constructor(window, app, appSystem) {
    this._window = window;
    this._app = app;
    this._appSystem = appSystem;
    this._overrides = [];
    this._hidden = false;
    this._windowsChangedId = null;
  }

  /**
   * @param {boolean} hidden - Whether only the sidebar should be hidden.
   * @param {boolean} refresh - Whether to notify consumers of a live window.
   */
  setHidden(hidden, refresh = true) {
    if (hidden === this._hidden)
      return;
    this._hidden = hidden;
    if (hidden) {
      const sidebar = this._window;
      const app = this._app;
      // GNOME uses snake_case; Ubuntu Dock also uses camelCase aliases.
      for (const key of ["skip_taskbar", "skipTaskbar"])
        this._override(sidebar, key, { get: () => true });
      this._override(sidebar, "is_skip_taskbar", { value: () => true });

      const getWindows = app.get_windows;
      this._override(app, "get_windows", {
        value() {
          return getWindows.call(this).filter(window => !isSidebarWindow(window, sidebar));
        },
      });
      this._override(app, "get_n_windows", { value() { return this.get_windows().length; } });

      // The native app tracker still counts Wayland windows despite a JS
      // skip_taskbar override. Both the Dock and Alt+Tab read this app list.
      const getRunning = this._appSystem.get_running;
      this._override(this._appSystem, "get_running", {
        value() {
          return getRunning.call(this).filter(candidate =>
            candidate !== app || app.get_windows().length > 0);
        },
      });
      // The native app remains RUNNING while its hidden sidebar exists.
      // Notify the Dock when normal windows open or the last one closes.
      this._windowsChangedId = app.connect("windows-changed", () => {
        this._appSystem.emit("app-state-changed", app);
      });
    } else {
      if (this._windowsChangedId !== null)
        this._app.disconnect(this._windowsChangedId);
      this._windowsChangedId = null;
      this._restore();
    }
    if (!refresh) return;
    // These are JS-only filters. A synthetic notify::skip-taskbar would make
    // the native WindowTracker untrack/retrack an unchanged Wayland window.
    // During close that corrupts the running-app list (shell_app_compare).
    // Refresh JS consumers without pretending the native property changed.
    this._app.emit("windows-changed");
    if (this._windowsChangedId === null)
      this._appSystem.emit("app-state-changed", this._app);
  }

  /**
   * Restore original properties without publishing a window being unmanaged.
   *
   * @param {boolean} windowUnmanaged - Native removal is still in progress.
   */
  destroy(windowUnmanaged = false) {
    this.setHidden(false, !windowUnmanaged);
  }

  /**
   * @param {object} target - Object whose JS-facing property is overridden.
   * @param {string} key - Property or method to replace.
   * @param {object} descriptor - Replacement property descriptor.
   */
  _override(target, key, descriptor) {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    const writable = "value" in descriptor ? { writable: true } : {};
    Object.defineProperty(target, key, { ...descriptor, ...writable, configurable: true });
    this._overrides.push({ target, key, previous, descriptor });
  }

  /** Restore only our own overrides, leaving later consumers' changes intact. */
  _restore() {
    for (const { target, key, previous, descriptor } of this._overrides.reverse()) {
      const current = Object.getOwnPropertyDescriptor(target, key);
      if (current?.value !== descriptor.value || current?.get !== descriptor.get)
        continue;
      if (previous)
        Object.defineProperty(target, key, previous);
      else
        delete target[key];
    }
    this._overrides = [];
  }
}
