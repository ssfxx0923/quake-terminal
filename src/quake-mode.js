import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Shell from "gi://Shell";
import Meta from "gi://Meta";
import { PACKAGE_VERSION } from "resource:///org/gnome/shell/misc/config.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { animationClip, slideOffset } from "./sidebar.js";
import { SidebarVisibility } from "./visibility.js";

const SHELL_VERSION = Number.parseInt(PACKAGE_VERSION.split(".")[0]);

const STARTUP_TIMER_IN_SECONDS = 5;

/**
 * How long (seconds) to wait for `stage-views-changed` after the actor is
 * created before giving up and positioning the terminal anyway (CREATED_ACTOR
 * → RUNNING fallback).
 */
const CREATED_ACTOR_TIMEOUT_IN_SECONDS = 5;

/**
 * How long (ms) to wait for the terminal to redraw at its new size on first
 * launch before showing it anyway.
 */
const RESIZE_TIMEOUT_IN_MS = 500;

const _DEBUG = false;

/**
 * Helper function for debug logging.
 *
 * @param {string} message - The message to log.
 */
function _log(message) {
  if (_DEBUG) {
    console.log(message);
  }
}

/**
 * Checks if the given window is a wl-clipboard window (wl-copy or wl-paste) running under Wayland.
 *
 * This function verifies the window's client type, title, and command line to determine
 * if it is a wl-clipboard instance. Used to avoid interfering with clipboard popups.
 *
 * @param {Meta.Window} win - The window to check.
 * @returns {boolean} True if the window is a wl-clipboard window, false otherwise.
 */
export async function is_wlclipboard(win) {
  if (!win) return false;
  if (win.get_client_type() !== Meta.WindowClientType.WAYLAND) return false;
  if (win.title !== "wl-clipboard") return false;
  const pid = win.get_pid();
  try {
    const file = Gio.File.new_for_path(`/proc/${pid}/cmdline`);
    const [contents] = await file.load_contents_async(null);
    const argv0_bytes = contents.slice(0, contents.indexOf(0));
    const argv0 = new TextDecoder().decode(argv0_bytes);
    return ["wl-copy", "wl-paste"].includes(GLib.path_get_basename(argv0));
  } catch {
    return false;
  }
}

/**
 * Quake Mode Module
 *
 * This module provides a Quake mode for managing a terminal window with animations and specific behavior.
 * It allows showing and hiding a terminal window with animation effects.
 *
 * @module QuakeMode
 */
export const QuakeMode = class {
  static LIFECYCLE = {
    READY: "READY",
    STARTING: "STARTING",
    CREATED_ACTOR: "CREATED_ACTOR",
    RUNNING: "RUNNING",
    DEAD: "DEAD",
  };

  /**
   * The default timeout (in seconds) for force-moving from CREATED_ACTOR to
   * RUNNING. This guards against the window/actor appearing but a subsequent
   * GNOME signal never firing, leaving _internalState stuck and all further
   * shortcut presses silently dropped.
  /**
   * Creates a new QuakeMode instance.
   *
   * @param {Shell.App} terminal - The terminal application instance.
   * @param {Gio.Settings} settings - The Gio.Settings object for configuration.
   */
  constructor(terminal, settings) {
    _log(
      `*** QuakeTerminal@constructor - IsWayland = ${SHELL_VERSION >= 50 || Meta.is_wayland_compositor()} ***`
    );
    _log(
      `*** QuakeTerminal@constructor - Terminal App = ${terminal.get_name()} ***`
    );

    /**
     *@type {Shell.App}
     */
    this._terminal = terminal;
    this._settings = settings;
    this._internalState = QuakeMode.LIFECYCLE.READY;

    this._sourceTimeoutLoopId = null;
    this._stageViewFallbackTimeoutId = null;
    this._resizeSignalId = null;
    this._resizeTimeoutId = null;
    this._terminalWindowUnmanagedId = null;
    this._terminalWindowFocusId = null;
    this._wmMapSignalId = null;
    this._terminalChangedId = null;
    this._actorStageViewChangedId = null;
    this._clearAnimationClip = null;
    this._requestedMonitorIndex = null;
    this._desiredVisible = false;
    this._animationState = null;
    this._visibility = null;

    /**
     *@type {Meta.Window}
     */
    this._terminalWindow = null;
    this._isTaskbarConfigured = null;

    /** We will monkey-patch this method. Let's store the original one. */
    // @ts-ignore
    this._original_shouldAnimateActor = Main.wm._shouldAnimateActor;

    // Enhance the close animation behavior when exiting
    this._configureActorCloseAnimation();

    /**
     * Stores the IDs of settings signal handlers.
     *
     * @type {number[]}
     */
    this._settingsWatchingListIds = [];

    ["vertical-size", "horizontal-size", "horizontal-alignment", "slide-edge", "primary-monitor-only"].forEach(
      (prefAdjustment) => {
        const settingsId = settings.connect(
          `changed::${prefAdjustment}`,
          () => {
            if (prefAdjustment === "primary-monitor-only")
              this.resetMonitor();
            else
              this._fitTerminalToMainMonitor();
          }
        );

        this._settingsWatchingListIds.push(settingsId);
      }
    );

    const alwaysOnTopSettingsId = settings.connect(
      "changed::always-on-top",
      () => {
        this._handleAlwaysOnTop();
      }
    );

    this._settingsWatchingListIds.push(alwaysOnTopSettingsId);

    const skipTaskbarSettingsId = settings.connect(
      "changed::skip-taskbar",
      () => {
        this._configureSkipTaskbarProperty();
      }
    );

    this._settingsWatchingListIds.push(skipTaskbarSettingsId);
  }

  get terminalWindow() {
    if (!this._terminal) {
      _log(
        `*** QuakeTerminal@terminalWindow - There's no terminal application ***`
      );
      _log(
        `*** QuakeTerminal@terminalWindow - Current state ${this._internalState}  ***`
      );
      return null;
    }

    if (!this._terminalWindow) {
      _log(
        `*** QuakeTerminal@terminalWindow - There's no WindowActor, finding one ... ***`
      );
      let ourWindow = this._terminal.get_windows().find((w) => {
        /**
         * The window actor for this terminal window.
         *
         * @type {Meta.WindowActor & { ease: Function }}
         */
        const actor = w.get_compositor_private();
        return actor?.get_name() === "quake-terminal-sidebar";
      });

      if (!ourWindow) {
        return null;
      }

      this._terminalWindow = ourWindow;
      if (!this._terminalWindowUnmanagedId) {
        this._terminalWindowUnmanagedId = this._terminalWindow.connect(
          "unmanaged",
          () => {
            _log(
              `*** QuakeTerminal@Unmanaged Called unmanaged after suspend or lockscreen ***`
            );
            this.destroy();
          }
        );
      }
    }

    return this._terminalWindow;
  }

  get actor() {
    if (!this.terminalWindow) {
      _log(`*** QuakeTerminal@actor - There's no terminalWindow ***`);
      return null;
    }

    /**
     * The window actor for this terminal window.
     *
     * @type {Meta.WindowActor & { ease: Function }}
     */
    const actor = this.terminalWindow.get_compositor_private();

    if (!actor) {
      _log(`*** QuakeTerminal@actor - There's no actor ***`);
      return null;
    }

    if ("clip_y" in actor) {
      return actor;
    }

    Object.defineProperty(actor, "clip_y", {
      get() {
        return this.clip_rect.origin.y;
      },
      set(y) {
        const rect = this.clip_rect;
        this.set_clip(rect.origin.x, y, rect.size.width, rect.size.height);
      },
    });

    return actor;
  }

  get monitorDisplayScreenIndex() {
    if (this._settings.get_boolean("primary-monitor-only"))
      return Shell.Global.get().display.get_primary_monitor();
    if (this._requestedMonitorIndex !== null &&
        this._requestedMonitorIndex < Main.layoutManager.monitors.length)
      return this._requestedMonitorIndex;
    if (this._settings.get_boolean("render-on-leftmost-monitor")) {
      return this._getMonitorIndexByPosition("leftmost");
    }

    if (this._settings.get_boolean("render-on-center-monitor")) {
      return this._getMonitorIndexByPosition("center");
    }

    if (this._settings.get_boolean("render-on-rightmost-monitor")) {
      return this._getMonitorIndexByPosition("rightmost");
    }

    if (this._settings.get_boolean("render-on-current-monitor")) {
      return Shell.Global.get().display.get_current_monitor();
    }

    if (this._settings.get_boolean("render-on-primary-monitor")) {
      return Shell.Global.get().display.get_primary_monitor();
    }

    const userSelectionDisplayIndex = this._settings.get_int("monitor-screen");
    const availableDisplaysIndexes =
      Shell.Global.get().display.get_n_monitors() - 1;

    if (
      userSelectionDisplayIndex >= 0 &&
      userSelectionDisplayIndex <= availableDisplaysIndexes
    ) {
      return userSelectionDisplayIndex;
    }

    return Shell.Global.get().display.get_primary_monitor();
  }

  /** Whether the sidebar is starting, visible, resizing or still sliding closed. */
  get isPresenting() {
    if (this._internalState === QuakeMode.LIFECYCLE.DEAD)
      return false;
    return this._internalState === QuakeMode.LIFECYCLE.STARTING ||
      this._internalState === QuakeMode.LIFECYCLE.CREATED_ACTOR ||
      this._desiredVisible || this._animationState !== null ||
      Boolean(this.terminalWindow && !this.terminalWindow.minimized);
  }

  /** The display occupied by the current presentation, including startup. */
  get activeMonitorIndex() {
    if (this._internalState === QuakeMode.LIFECYCLE.RUNNING && this.terminalWindow)
      return this.terminalWindow.get_monitor();
    return this.monitorDisplayScreenIndex;
  }

  /**
   * Gets the monitor index by physical position on the X axis.
   *
   * @param {"leftmost" | "center" | "rightmost"} position - Desired position
   * @returns {number} The monitor index matching that position
   */
  _getMonitorIndexByPosition(position) {
    const sorted = [...Main.layoutManager.monitors].sort((a, b) => a.x - b.x);

    if (position === "leftmost") {
      return sorted[0].index;
    }

    if (position === "rightmost") {
      return sorted[sorted.length - 1].index;
    }

    if (position === "center") {
      return sorted[Math.floor(sorted.length / 2)].index;
    }

    return Shell.Global.get().display.get_primary_monitor();
  }

  destroy() {
    _log(`*** QuakeTerminal@destroy - Starting destroy action ***`);
    this._clearAnimationClip?.();
    this._visibility?.destroy();
    this._visibility = null;
    const actor = this.actor;
    if (actor) {
      actor.remove_all_transitions();
      actor.translation_x = 0;
      actor.translation_y = 0;
      actor.opacity = 255;
    }
    if (this._sourceTimeoutLoopId) {
      GLib.Source.remove(this._sourceTimeoutLoopId);
      this._sourceTimeoutLoopId = null;
    }

    if (this._stageViewFallbackTimeoutId) {
      GLib.Source.remove(this._stageViewFallbackTimeoutId);
      this._stageViewFallbackTimeoutId = null;
    }

    this._cancelWaitForResize();

    if (this._settingsWatchingListIds.length && this._settings) {
      this._settingsWatchingListIds.forEach((id) => {
        this._settings.disconnect(id);
      });
    }

    if (this.actor && this._actorStageViewChangedId) {
      this.actor.disconnect(this._actorStageViewChangedId);
      this._actorStageViewChangedId = null;
    }

    if (this._terminalWindowUnmanagedId && this.terminalWindow) {
      this.terminalWindow.disconnect(this._terminalWindowUnmanagedId);
      this._terminalWindowUnmanagedId = null;
    }

    if (this._terminalChangedId && this._terminal) {
      this._terminal.disconnect(this._terminalChangedId);
      this._terminalChangedId = null;
    }

    if (this._terminalWindowFocusId) {
      Shell.Global.get().display.disconnect(this._terminalWindowFocusId);
      this._terminalWindowFocusId = null;
    }

    if (this._wmMapSignalId) {
      Shell.Global.get().window_manager.disconnect(this._wmMapSignalId);
      this._wmMapSignalId = null;
    }

    this._settingsWatchingListIds = [];
    this._terminal = null;
    this._terminalWindow = null;
    this._internalState = QuakeMode.LIFECYCLE.DEAD;
    this._desiredVisible = false;
    this._animationState = null;
    this._isTaskbarConfigured = null;
    // @ts-ignore
    Main.wm._shouldAnimateActor = this._original_shouldAnimateActor;
  }

  /**
   * Toggles the visibility of the terminal window with animations.
   *
   * @returns {Promise<void>} A promise that resolves when the toggle operation is complete.
   */
  async toggle() {
    if (this.terminalWindow && this._desiredVisible &&
        (this.terminalWindow.has_focus() ||
         this._settings.get_boolean("hide-on-toggle-without-focus"))) {
      this._hideTerminalWithAnimation();
      return;
    }
    await this.show();
  }

  /** Forget a monitor that may have disappeared after a display change. */
  resetMonitor() {
    this.hideImmediately();
    this._requestedMonitorIndex = null;
    this._fitTerminalToMainMonitor();
  }

  /**
   * Show the sidebar without toggling, including while a hide is in progress.
   *
   * @param {number|null} monitorIndex - Monitor selected by the hovered edge.
   * @returns {Promise<void>} Completion of terminal startup.
   */
  async show(monitorIndex = null) {
    if (Main.overview.visible) {
      this.hideImmediately();
      return;
    }
    if (this.isPresenting) {
      if (monitorIndex !== null && monitorIndex !== this.activeMonitorIndex)
        return;
      monitorIndex = this.activeMonitorIndex;
    }
    const previousMonitor = this.monitorDisplayScreenIndex;
    this._requestedMonitorIndex = monitorIndex;
    const alreadyVisible = this._desiredVisible && this.terminalWindow &&
      !this.terminalWindow.is_hidden() && this._animationState !== "hiding";
    this._desiredVisible = true;
    if (!this.terminalWindow) {
      try {
        await this._launchTerminalWindow();

        // When the `map` signal was missed, _adjustTerminalWindowPosition()
        // advances straight to RUNNING and shows the terminal synchronously.
        // Running the focus/hide/show logic below on top of that would
        // immediately undo the show, since the window is now focused.
        if (this._adjustTerminalWindowPosition()) {
          return;
        }
        // The map handler will resize and show the newly created window.
        return;
      } catch (error) {
        _log(`*** QuakeTerminal@toggle - Catch error ${error} ***`);
        this.destroy();
        return;
      }
    }

    if (!this._isTaskbarConfigured) {
      this._configureSkipTaskbarProperty();
    }

    if (alreadyVisible && previousMonitor === this.monitorDisplayScreenIndex) {
      Main.activateWindow(this.terminalWindow);
      return;
    }
    this._showTerminalAfterResize();
  }

  /**
   * Launches the terminal window and sets up event handlers.
   *
   * @returns {Promise<boolean>} A promise that resolves when the terminal window is ready.
   */
  _launchTerminalWindow() {
    this._internalState = QuakeMode.LIFECYCLE.STARTING;

    if (!this._terminal) {
      return Promise.reject(Error("Quake-Terminal - Terminal App is null"));
    }

    const info = this._terminal.get_app_info();
    _log(
      `*** QuakeTerminal@_launchTerminalWindow - launching a new window for terminal ${info.get_name()}  ***`
    );
    const launchArgsMap =
      this._settings.get_value("launch-args-map").deep_unpack() || {};

    const launchArgs = launchArgsMap[info.get_id()] || "";
    const cancellable = new Gio.Cancellable();

    const promiseTerminalWindowInLessThanFiveSeconds = new Promise(
      (resolve, reject) => {
        const shellAppWindowsChangedHandler = () => {
          if (!this._terminal) {
            return reject(
              Error(
                "Quake-Terminal - Something destroyed the internal reference of terminal app"
              )
            );
          }

          if (this._internalState !== QuakeMode.LIFECYCLE.STARTING) {
            _log(
              `*** QuakeTerminal@_launchTerminalWindow - Not in STARTING state, ignoring windows-changed signal ***`
            );

            return;
          }

          if (this._terminal.get_n_windows() < 1) {
            return reject(
              Error(
                `Quake-Terminal - App '${this._terminal.id}' is launched but no windows`
              )
            );
          }

          const ourWindow = this._terminal.get_windows()[0];
          if (this._sourceTimeoutLoopId) {
            GLib.Source.remove(this._sourceTimeoutLoopId);
            this._sourceTimeoutLoopId = null;
          }
          this._terminal.disconnect(this._terminalChangedId);
          this._terminalChangedId = null;
          /**
           * The window actor for this terminal window.
           *
           * @type {Meta.WindowActor & { ease: Function }}
           */
          const actor = ourWindow.get_compositor_private();
          actor.set_name("quake-terminal-sidebar");
          this._terminalWindow = ourWindow;
          this._internalState = QuakeMode.LIFECYCLE.CREATED_ACTOR;

          // Keeps the Terminal out of Overview mode and Alt-Tab window switching
          this._configureSkipTaskbarProperty();

          this._handleAlwaysOnTop();

          this._terminalWindowUnmanagedId = this.terminalWindow.connect(
            "unmanaged",
            () => {
              _log(`*** QuakeTerminal@Unmanaged Called unmanaged ***`);
              this.destroy();
            }
          );

          this._terminalWindowFocusId = Shell.Global.get().display.connect(
            "notify::focus-window",
            (source) => {
              this._handleHideOnFocusLoss(source).catch((e) =>
                _log(`*** QuakeTerminal@focus-window - ${e} ***`)
              );
            }
          );

          resolve(true);
        };

        this._terminalChangedId = this._terminal.connect(
          "windows-changed",
          shellAppWindowsChangedHandler
        );

        const exec = info.get_string("Exec");
        const cleanedExec = this._cleanDesktopFileExec(exec);
        let fullCommand = `${cleanedExec} ${launchArgs}`;

        try {
          const [success, argv] = GLib.shell_parse_argv(fullCommand);
          if (success) {
            this._spawn(argv, cancellable).catch((e) => reject(e));
          } else {
            reject(Error(`Failed to parse command line args: ${fullCommand}`));
          }
        } catch (e) {
          reject(e);
        }

        this._sourceTimeoutLoopId = GLib.timeout_add_seconds(
          GLib.PRIORITY_DEFAULT,
          STARTUP_TIMER_IN_SECONDS,
          () => {
            cancellable.cancel();
            reject(
              Error(
                `Quake-Terminal: Timeout reached after ${STARTUP_TIMER_IN_SECONDS} seconds while trying to open the Quake terminal`
              )
            );
            return GLib.SOURCE_REMOVE;
          }
        );
      }
    );

    return promiseTerminalWindowInLessThanFiveSeconds;
  }

  /**
   * Adjusts the terminal window's initial position and handles signal connections related
   * to window mapping and sizing.
   *
   * @returns {boolean} True when the terminal was advanced to RUNNING immediately.
   */
  _adjustTerminalWindowPosition() {
    if (!this.terminalWindow || !this.actor) {
      _log(
        `*** QuakeTerminal@_adjustTerminalWindowPosition - No terminalWindow || actor ***`
      );
      return false;
    }

    this.terminalWindow.stick();
    if (!this._desiredVisible) {
      this._internalState = QuakeMode.LIFECYCLE.RUNNING;
      this.hideImmediately();
      return true;
    }

    // Defined at this scope so the unconditional fallback timer below can also
    // call it when the `map` signal fired before our handler was connected.
    const advanceToRunning = () => {
      if (this._stageViewFallbackTimeoutId) {
        GLib.Source.remove(this._stageViewFallbackTimeoutId);
        this._stageViewFallbackTimeoutId = null;
      }
      if (this._actorStageViewChangedId && this.actor) {
        this.actor.disconnect(this._actorStageViewChangedId);
        this._actorStageViewChangedId = null;
      }
      if (this._wmMapSignalId) {
        Shell.Global.get().window_manager.disconnect(this._wmMapSignalId);
        this._wmMapSignalId = null;
      }
      if (this._internalState !== QuakeMode.LIFECYCLE.CREATED_ACTOR) return;
      _log(`*** QuakeTerminal@advanceToRunning - Advancing to RUNNING ***`);
      this._internalState = QuakeMode.LIFECYCLE.RUNNING;
      if (!this._desiredVisible) {
        this.hideImmediately();
        return;
      }
      this._showTerminalAfterResize();
    };

    if (this.actor.is_mapped()) {
      // The `map` signal already fired before we could connect to it (the
      // race behind #85). By the time the actor is mapped, its stage views
      // have already settled too, so `stage-views-changed` will never fire
      // again for it.
      _log(
        `*** QuakeTerminal@_adjustTerminalWindowPosition - actor already mapped, missed map signal, advancing immediately ***`
      );
      this.actor.opacity = 0;
      Shell.Global.get().window_manager.emit("kill-window-effects", this.actor);
      advanceToRunning();
      return true;
    }

    const mapSignalHandler = (
      /** @type {Shell.WM} */ wm,
      /** @type {Meta.WindowActor} */ metaWindowActor
    ) => {
      if (metaWindowActor !== this.actor) {
        _log(
          `*** QuakeTerminal@mapSignalHandler - ${metaWindowActor.get_name()} is not our actor, skipping. ***`
        );
        return;
      }
      this.actor.opacity = 0;
      Shell.Global.get().window_manager.disconnect(this._wmMapSignalId);
      this._wmMapSignalId = null;
      wm.emit("kill-window-effects", this.actor);
      this._actorStageViewChangedId = this.actor.connect(
        "stage-views-changed",
        () => {
          _log(
            `*** QuakeTerminal@_adjustTerminalWindowPosition - stage-views-changed received, state ${this._internalState} ***`
          );
          advanceToRunning();
        }
      );
    };

    this._wmMapSignalId = Shell.Global.get().window_manager.connect(
      "map",
      mapSignalHandler
    );

    this._stageViewFallbackTimeoutId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      CREATED_ACTOR_TIMEOUT_IN_SECONDS,
      () => {
        this._stageViewFallbackTimeoutId = null;
        _log(
          `*** QuakeTerminal@_adjustTerminalWindowPosition - stage-views-changed fallback timeout fired (state=${this._internalState}) ***`
        );
        advanceToRunning();
        return GLib.SOURCE_REMOVE;
      }
    );

    return false;
  }

  _shouldAvoidAnimation() {
    if (!this.actor) {
      return true;
    }

    return false;
  }

  /**
   * Clip every animation frame to this monitor's work area.
   *
   * @param {Meta.WindowActor} actor - Animated window actor.
   * @returns {Function} Cleanup on completion, cancellation or actor destruction.
   */
  _clipAnimation(actor) {
    this._clearAnimationClip?.();
    const originalClip = actor.has_clip ? actor.get_clip() : null;
    const area = this.terminalWindow.get_work_area_for_monitor(this.monitorDisplayScreenIndex);
    const updateClip = () => actor.set_clip(...animationClip(actor, area, originalClip));
    const ids = ["notify::translation-x", "notify::translation-y", "notify::allocation"]
      .map(signal => actor.connect(signal, updateClip));
    let cleared = false;
    const clearClip = (destroyed = false) => {
      if (cleared) return;
      cleared = true;
      if (!destroyed) {
        ids.forEach(id => actor.disconnect(id));
        actor.disconnect(destroyId);
        if (originalClip) actor.set_clip(...originalClip);
        else actor.remove_clip();
      }
      if (this._clearAnimationClip === clearClip)
        this._clearAnimationClip = null;
    };
    const destroyId = actor.connect("destroy", () => clearClip(true));
    this._clearAnimationClip = clearClip;
    updateClip();
    return clearClip;
  }

  /**
   * @returns {object} Translation that hides the sidebar beyond its own edge.
   */
  _hiddenOffset() {
    return slideOffset(this._settings.get_string("slide-edge"),
      this.terminalWindow.get_frame_rect(),
      this.terminalWindow.get_work_area_for_monitor(this.monitorDisplayScreenIndex));
  }

  /** Slide in from the configured edge, reversing an interrupted hide smoothly. */
  _showTerminalWithAnimation() {
    const actor = this.actor;
    if (!actor || !this._desiredVisible) return;
    const parent = actor.get_parent();
    if (!parent) return;
    const wasHidden = this.terminalWindow.is_hidden() || actor.opacity === 0;
    actor.remove_all_transitions();
    this._animationState = "showing";
    if (wasHidden)
      Object.assign(actor, this._hiddenOffset());
    const clearClip = this._clipAnimation(actor);
    parent.set_child_above_sibling(actor, null);
    Main.wm.skipNextEffect(actor);
    Main.activateWindow(this.terminalWindow);
    actor.ease({
      mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
      translation_x: 0,
      translation_y: 0,
      opacity: 255,
      duration: this._settings.get_int("animation-time"),
      onStopped: () => clearClip(),
      onComplete: () => { this._animationState = null; },
    });
  }

  /** Slide out toward the same edge and minimize only after the animation. */
  _hideTerminalWithAnimation() {
    const actor = this.actor;
    if (!actor || !this._desiredVisible) return;
    this._desiredVisible = false;
    this._cancelWaitForResize();
    actor.remove_all_transitions();
    this._animationState = "hiding";
    const clearClip = this._clipAnimation(actor);
    actor.ease({
      ...this._hiddenOffset(),
      mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
      duration: this._settings.get_int("animation-time"),
      onStopped: () => clearClip(),
      onComplete: () => {
        if (this._desiredVisible) return;
        Main.wm.skipNextEffect(actor);
        this.terminalWindow.minimize();
        actor.translation_x = 0;
        actor.translation_y = 0;
        this._animationState = null;
      },
    });
  }

  /** Keep the underlying window minimized across Overview and app-grid changes. */
  hideImmediately() {
    this._desiredVisible = false;
    this._cancelWaitForResize();
    const actor = this.actor;
    if (actor) {
      actor.remove_all_transitions();
      this._clearAnimationClip?.();
      actor.opacity = 0;
      Main.wm.skipNextEffect(actor);
      this.terminalWindow.minimize();
      actor.translation_x = 0;
      actor.translation_y = 0;
    }
    this._animationState = null;
  }

  /** Wait for Wayland's resize acknowledgement before starting the animation. */
  _showTerminalAfterResize() {
    this._cancelWaitForResize();
    this._animationState = "resizing";
    const show = () => {
      this._cancelWaitForResize();
      // Terminal cell sizes and minimum sizes may round the requested width.
      // Anchor the actual acknowledged frame rather than the requested size.
      if (this._settings.get_string("slide-edge") === "right") {
        const area = this.terminalWindow.get_work_area_for_monitor(this.monitorDisplayScreenIndex);
        const frame = this.terminalWindow.get_frame_rect();
        this.terminalWindow.move_frame(false, area.x + area.width - frame.width, area.y);
      }
      this._showTerminalWithAnimation();
    };
    this._resizeSignalId = this.terminalWindow.connect("size-changed", show);
    if (!this._fitTerminalToMainMonitor()) {
      show();
      return;
    }
    if (this._resizeSignalId) {
      this._resizeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
        RESIZE_TIMEOUT_IN_MS, () => {
          this._resizeTimeoutId = null;
          show();
          return GLib.SOURCE_REMOVE;
        });
    }
  }

  /**
   * Stops waiting for the resize started by _showTerminalAfterResize().
   */
  _cancelWaitForResize() {
    if (this._resizeTimeoutId) {
      GLib.Source.remove(this._resizeTimeoutId);
      this._resizeTimeoutId = null;
    }

    if (this._resizeSignalId && this.terminalWindow) {
      this.terminalWindow.disconnect(this._resizeSignalId);
    }
    this._resizeSignalId = null;
  }

  /**
   * @returns {boolean} True when the window must change size, which happens
   * asynchronously on Wayland.
   */
  _fitTerminalToMainMonitor() {
    if (!this.terminalWindow) {
      return false;
    }
    const monitorDisplayScreenIndex = this.monitorDisplayScreenIndex;
    const area = this.terminalWindow.get_work_area_for_monitor(
      monitorDisplayScreenIndex
    );

    const verticalSettingsValue = this._settings.get_int("vertical-size");
    const horizontalSettingsValue = this._settings.get_int("horizontal-size");

    const horizontalAlignmentSettingsValue = this._settings.get_int(
      "horizontal-alignment"
    );

    const terminalHeight = Math.round(
      (verticalSettingsValue * area.height) / 100
    );
    const terminalWidth = Math.round(
      (horizontalSettingsValue * area.width) / 100
    );

    const terminalX = this._settings.get_string("slide-edge") === "right"
      ? area.x + area.width - terminalWidth
      : area.x +
      Math.round(
        horizontalAlignmentSettingsValue &&
          (area.width - terminalWidth) / horizontalAlignmentSettingsValue
      );

    this.terminalWindow.move_to_monitor(monitorDisplayScreenIndex);

    // GNOME auto-maximizes new windows that are nearly as big as the screen,
    // and a maximized window ignores the size below. GNOME 49 removed the
    // flags parameter and renamed get_maximized() to is_maximized().
    if (SHELL_VERSION >= 49) {
      if (this.terminalWindow.is_maximized()) {
        this.terminalWindow.unmaximize();
      }
    } else {
      const getMaximized = this.terminalWindow.get_maximized;
      if (getMaximized.call(this.terminalWindow)) {
        const unmaximize = this.terminalWindow.unmaximize;
        const maximizeFlags = Meta.MaximizeFlags;
        unmaximize.call(this.terminalWindow, maximizeFlags.BOTH);
      }
    }

    const frame = this.terminalWindow.get_frame_rect();
    const mustResize =
      frame.width !== terminalWidth || frame.height !== terminalHeight;

    this.terminalWindow.move_resize_frame(
      false,
      terminalX,
      area.y,
      terminalWidth,
      terminalHeight
    );

    return mustResize;
  }

  _configureSkipTaskbarProperty() {
    if (!this._visibility)
      this._visibility = new SidebarVisibility(this.terminalWindow,
        this._terminal, Shell.AppSystem.get_default());
    this._visibility.setHidden(this._settings.get_boolean("skip-taskbar"));
    this._isTaskbarConfigured = true;
  }

  _configureActorCloseAnimation() {
    /** We will use `self` to refer to the extension inside the patched method. */
    const self = this;

    // @ts-ignore
    Main.wm._shouldAnimateActor = function (
      /**
       * @type {Meta.WindowActor & { ease: Function }}
       */
      actor,
      /** @type {any} */ types
    ) {
      const stack = new Error().stack;
      const forClosing = stack.includes("_destroyWindow@");

      /**
       * We specifically handle window closing events, but only when our actor is the target.
       * For all other cases, the original behavior remains in effect.
       */
      if (!forClosing || actor !== self.actor) {
        return self._original_shouldAnimateActor.apply(this, [actor, types]);
      }

      /** Store the original ease() method of the terminal actor. */
      const originalActorAnimate = actor.ease;

      /**
       * Intercept the next call to actor.animate() to perform a custom bottom-up close animation.
       * Afterward, immediately restore the original behavior.
       */
      actor.ease = function () {
        actor.ease = originalActorAnimate;
        const clearClip = self._clipAnimation(actor);

        originalActorAnimate.call(actor, {
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          ...self._hiddenOffset(),
          duration: self._settings.get_int("animation-time"),
          onStopped: () => clearClip(),
          onComplete: () => {
            // @ts-ignore
            Main.wm._destroyWindowDone(Main.wm._shellwm, actor);
          },
        });
      };

      return true;
    };
  }

  /**
   * Hides the terminal when it loses focus.
   *
   * @param {Meta.Display} source - The display object.
   */
  async _handleHideOnFocusLoss(source) {
    const shouldAutoHide = this._settings.get_boolean("auto-hide-window");

    if (!shouldAutoHide) {
      return;
    }

    if (!source) {
      return;
    }

    const focus = source.focus_window;
    if (await is_wlclipboard(focus)) {
      return;
    }

    if (source.focus_window !== focus || !this._desiredVisible) {
      return;
    }

    // Keep the sidebar visible while using one of its own dialogs.
    for (let parent = focus; parent; parent = parent.get_transient_for()) {
      if (parent === this.terminalWindow)
        return;
    }

    this._hideTerminalWithAnimation();
  }

  _handleAlwaysOnTop() {
    const shouldAlwaysOnTop = this._settings.get_boolean("always-on-top");

    if (!shouldAlwaysOnTop && !this.terminalWindow.is_above()) {
      return;
    }

    if (!shouldAlwaysOnTop && this.terminalWindow.is_above()) {
      this.terminalWindow.unmake_above();
      return;
    }

    this.terminalWindow.make_above();
  }

  /**
   * Execute a command asynchronously and check the exit status.
   *
   * If given, @cancellable can be used to stop the process before it finishes.
   *
   * @param {string[]} argv - a list of string arguments
   * @param {Gio.Cancellable} [cancellable] - optional cancellable object
   * @returns {Promise<void>} - The process success
   */
  async _spawn(argv, cancellable = null) {
    let cancelId = 0;
    const proc = new Gio.Subprocess({
      argv,
      flags: Gio.SubprocessFlags.NONE,
    });
    proc.init(cancellable);

    if (cancellable instanceof Gio.Cancellable)
      cancelId = cancellable.connect(() => proc.force_exit());

    try {
      const success = await proc.wait_check_async(null);

      if (!success) {
        const status = proc.get_exit_status();

        throw new Gio.IOErrorEnum({
          code: Gio.IOErrorEnum.FAILED,
          message: `Command '${argv}' failed with exit code ${status}`,
        });
      }
    } finally {
      if (cancelId > 0) cancellable.disconnect(cancelId);
    }
  }

  /**
   * Cleans desktop file Exec field by removing field codes that are not applicable
   * for terminal launching in quake mode.
   *
   * According to Desktop Entry Specification, field codes include:
   * %f - single file name
   * %F - multiple file names
   * %u - single URL
   * %U - multiple URLs
   * %d - deprecated (single directory name)
   * %D - deprecated (multiple directory names)
   * %n - deprecated (single filename without path)
   * %N - deprecated (multiple filenames without path)
   * %i - icon field prefixed by --icon
   * %c - translated name of the application
   * %k - location of desktop file
   * %v - deprecated (device)
   * %% - literal percent sign
   *
   * For terminal applications in quake mode, we don't pass any files or URLs,
   * so we remove these field codes except for %%.
   *
   * @param {string} exec - The Exec field from the desktop file
   * @returns {string} The cleaned Exec command
   */
  _cleanDesktopFileExec(exec) {
    if (!exec) {
      return "";
    }

    // Handle %% first (literal percent sign) by temporarily replacing it
    const tempReplacement = "___PERCENT_PLACEHOLDER___";
    let cleaned = exec.replace(/%%/g, tempReplacement);

    // Remove all standard desktop file field codes
    // Match % followed by a letter (case insensitive)
    cleaned = cleaned.replace(/%[fFuUdDnNickv]/g, "");

    // Restore literal percent signs
    cleaned = cleaned.replace(new RegExp(tempReplacement, "g"), "%");

    // Clean up any extra whitespace that might be left
    cleaned = cleaned.replace(/\s+/g, " ").trim();

    return cleaned;
  }
};
