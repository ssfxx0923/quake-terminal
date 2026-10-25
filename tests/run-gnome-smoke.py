#!/usr/bin/env python3
"""Run the real GNOME integration test on a private bus and virtual display.

SPDX-License-Identifier: LGPL-3.0-or-later
Copyright 2026 ssfxx0923
"""

import os
import shutil
import signal
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
artifacts = root / "dist/smoke"
artifacts.mkdir(parents=True, exist_ok=True)
uuid = "quake-terminal-sidebar@ssfxx0923.github.io"
with tempfile.TemporaryDirectory(prefix="quake-sidebar-test-", ignore_cleanup_errors=True) as directory:
    state = Path(directory)
    config = state / "config"
    config.mkdir()
    empty = state / "empty-user-folders"
    empty.mkdir()
    (config / "user-dirs.dirs").write_text("\n".join(
        f'XDG_{name}_DIR="{empty}"' for name in
        ("DESKTOP", "DOWNLOAD", "TEMPLATES", "PUBLICSHARE", "DOCUMENTS", "MUSIC", "PICTURES", "VIDEOS")
    ) + "\n")
    extension = state / "data/gnome-shell/extensions" / uuid
    shutil.copytree(root / "src", extension)
    subprocess.run(["glib-compile-schemas", str(extension / "schemas")], check=True)
    # Avoid GNOME's first-login network update check in this disposable profile.
    major = subprocess.check_output(["gnome-shell", "--version"], text=True).split()[-1].split(".")[0]
    (extension.parent.parent / f"update-check-{major}").touch()
    dock_source = Path("/usr/share/gnome-shell/extensions/ubuntu-dock@ubuntu.com")
    runtime = state / "runtime"
    runtime.mkdir(mode=0o700)
    environment = os.environ.copy()
    environment["XDG_RUNTIME_DIR"] = str(runtime)
    environment["SIDEBAR_ARTIFACT_DIR"] = str(artifacts)
    if dock_source.exists():
        dock = extension.parent / dock_source.name
        shutil.copytree(dock_source, dock)
        environment["SIDEBAR_TEST_DOCK_PATH"] = str(dock)
    for variable, folder in (("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
                             ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state")):
        environment[variable] = str(state / folder)
    environment.update(GSETTINGS_BACKEND="keyfile", XDG_CURRENT_DESKTOP="GNOME",
                       LIBGL_ALWAYS_SOFTWARE="1", GNOME_SHELL_SESSION_MODE="user",
                       NO_AT_BRIDGE="1", GTK_USE_PORTAL="0", GIO_USE_VFS="local",
                       G_DEBUG="fatal-criticals")
    command = ["dbus-run-session", "--", "gnome-shell", "--headless", "--mode=user",
               "--virtual-monitor=1280x800", "--virtual-monitor=1600x900",
               f"--wayland-display=quake-test-{os.getpid()}",
               f"--automation-script={root / 'tests/gnome-smoke.js'}"]
    if os.getenv("SIDEBAR_TEST_GDB"):
        command[2:2] = ["gdb", "--batch", "-ex", "set debuginfod enabled off",
                       "-ex", "run", "-ex",
                       "python if gdb.selected_inferior().pid: gdb.execute('bt'); gdb.execute('call (void) gjs_dumpstack()')",
                       "--args"]
    log = state / "gnome.log"
    with log.open("w") as output:
        process = subprocess.Popen(command, env=environment, stdout=output,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=45)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
            code = 1
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    if shutil.which("fusermount3"):
        subprocess.run(["fusermount3", "-uz", str(runtime / "doc")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    text = log.read_text()
    (artifacts / "gnome.log").write_text(text)
    for line in text.splitlines():
        if "SIDEBAR" in line:
            print(line)
    if code or "SIDEBAR SMOKE COMPLETE" not in text:
        print("\n".join(text.splitlines()[-100:]))
        raise SystemExit(code or 1)
