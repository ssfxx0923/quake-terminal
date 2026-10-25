# Quake Terminal Sidebar

基于 [diegodario88/quake-terminal](https://github.com/diegodario88/quake-terminal) 的持续维护 fork，使用系统中已有的终端。

鼠标在任一显示屏右边缘的下半段停留约 180 毫秒，终端从右侧滑入；点击其他应用后，窗口向右滑出。也可以按 **Super + Enter** 显示或收回。每次进入边缘只展开一次，鼠标停留不会反复切换。首次使用可以直接碰边，无需先用快捷键启动。

## Sidebar behavior

- Right edge by default, 40% of the monitor width and the full work-area height.
- Pointer hover and keyboard shortcuts share the same terminal window and session.
- The sidebar stays out of Ubuntu Dock, Overview and Alt+Tab. Normally opened terminal windows still have their own Dock icon and accurate window counts.
- Position, reveal, hide and close animations use the same edge.
- Animations are clipped to the current monitor, including stacked and offset displays.
- Both displays use only the lower half of their right edge as the reveal zone, keeping status menus clear.
- While the sidebar is opening, visible or closing, another display cannot summon or move it. After it has fully retracted, a fresh edge visit can reveal the same terminal on either display.
- An interrupted hide can reverse into a show without a later minimize callback.
- Closing the terminal releases its controller; a fresh edge visit creates a new session safely, including when closed during an animation.
- Top-edge mode remains available in Preferences.
- Reveal and hide use a slower 300 ms ease-in/ease-out animation.
- Entering Super Overview or the application grid minimizes the sidebar. Returning to the desktop keeps it hidden until a fresh edge visit or shortcut.
- Hover is suspended during dragging, fullscreen applications, the overview and the lock screen.
- The fork has its own UUID and settings schema so upstream extension updates cannot overwrite it.

This is a window controller, not a terminal emulator. It uses the terminal selected in Preferences (Ptyxis on Ubuntu 26.04 by default). It does not change the system's default terminal. It still manages one selected application, rather than a collection of different sidebar apps.

## Install from this repository

Requires Python 3 with PyGObject, `gnome-extensions`, and `glib-compile-schemas`, normally already present on Ubuntu GNOME. No administrator access or `make` is needed.

```sh
git clone https://github.com/ssfxx0923/quake-terminal.git
cd quake-terminal
python3 scripts/build.py --install
```

Log out and back in to load the build. The installer does not log you out. It preserves the upstream terminal selection, shortcut and launch arguments, enables this fork, and disables the original extension to avoid shortcut conflicts. It leaves the original extension installed for rollback. On subsequent installs, it backs up the previous fork build under `~/.local/state/quake-terminal-sidebar/backups/` and preserves the fork's settings.

Build without installing:

```sh
python3 scripts/build.py
```

The package is written to `dist/quake-terminal-sidebar@ssfxx0923.github.io.shell-extension.zip`. `make pack` and `make install` are also supported when make is installed.

## Preferences

```sh
gnome-extensions prefs quake-terminal-sidebar@ssfxx0923.github.io
```

Choose **Slide Edge**, **Reveal on Edge Hover**, **Hover Delay**, **Edge Width**, **Primary Display Only**, **Lower Half of Right Edge Only**, terminal application, window size, shortcut and focus behavior. The defaults use a two-logical-pixel trigger strip and 180 ms dwell and 300 ms animation times. Automatic hiding is triggered by focus loss, not by moving the pointer outside the terminal while typing.

## Development and verification

```sh
npm ci --ignore-scripts
npm test
npm run lint
python3 scripts/build.py
```

The Node tests cover edge dwell cancellation, repeated pointer visits, monitor selection and animation clipping. A separate integration test starts a real GNOME compositor on a private D-Bus session with a virtual display; it does not control or restart the user's desktop:

```sh
python3 tests/run-gnome-smoke.py
```

The integration test requires GNOME Shell's headless backend, its performance helper and Ptyxis. It checks pointer-triggered startup, actual window positioning, animation direction, rapid reversal, focus loss and cleanup. It also closes and reopens the terminal repeatedly while visible, revealing, retracting, minimized, with focus hiding disabled and with animations disabled, and checks that closed actors and native destroy effects are released. On Ubuntu it loads the installed Ubuntu Dock in the isolated session and verifies sidebar-only, normal-terminal and last-normal-window-closed behavior. Set `SIDEBAR_TEST_GDB=1` to capture a native backtrace if the test compositor crashes. The local fork was developed on Ubuntu 26.04 / GNOME 50; the upstream compatibility declarations remain in `src/metadata.json`.

GNOME caches extension JavaScript for the duration of a desktop session. After installing an updated build, log out and back in to load the new code. Disabling and enabling alone is not a source reload on GNOME 50.

## Roll back to the original extension

```sh
gnome-extensions disable quake-terminal-sidebar@ssfxx0923.github.io
gnome-extensions enable quake-terminal@diegodario88.github.io
```

The original extension and its settings are left intact by the installer.

## Upstream and license

Original project and copyright: Diego Dario and contributors, [Quake Terminal](https://github.com/diegodario88/quake-terminal). The upstream source and history are preserved. See [LICENSE](LICENSE) and the source-file license headers.

```sh
git remote add upstream https://github.com/diegodario88/quake-terminal.git
git fetch upstream
```
