#!/usr/bin/env python3
"""Install the maintained sidebar fork and migrate the existing terminal choice.

SPDX-License-Identifier: LGPL-3.0-or-later
Copyright 2026 ssfxx0923
"""

import json
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from gi.repository import Gio

UUID = "quake-terminal-sidebar@ssfxx0923.github.io"
UPSTREAM_UUID = "quake-terminal@diegodario88.github.io"
SCHEMA = "org.gnome.shell.extensions.quake-terminal-sidebar"
extensions = Path.home() / ".local/share/gnome-shell/extensions"
destination = extensions / UUID
state = Path.home() / ".local/state/quake-terminal-sidebar"
if destination.exists():
    backup = state / "backups" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    shutil.copytree(destination, backup)
    print(f"Previous build backed up to {backup}")

subprocess.run(["gnome-extensions", "install", "--force", sys.argv[1]], check=True)
default_source = Gio.SettingsSchemaSource.get_default()
source = Gio.SettingsSchemaSource.new_from_directory(
    str(destination / "schemas"), default_source, False
)
settings = Gio.Settings.new_full(source.lookup(SCHEMA, False), None, None)
upstream_schemas = extensions / UPSTREAM_UUID / "schemas"
if upstream_schemas.exists():
    old_source = Gio.SettingsSchemaSource.new_from_directory(
        str(upstream_schemas), default_source, False
    )
    old_schema = old_source.lookup("org.gnome.shell.extensions.quake-terminal", False)
    if old_schema:
        previous = Gio.Settings.new_full(old_schema, None, None)
        for key in ("terminal-id", "terminal-shortcut", "launch-args-map"):
            if settings.get_user_value(key) is None:
                settings.set_value(key, previous.get_value(key))

shell = Gio.Settings.new("org.gnome.shell")
enabled = [uuid for uuid in shell.get_strv("enabled-extensions") if uuid != UPSTREAM_UUID]
disabled = list(shell.get_strv("disabled-extensions"))
if UUID in disabled:
    disabled.remove(UUID)
    shell.set_strv("disabled-extensions", disabled)
if UUID not in enabled:
    enabled.append(UUID)
if not shell.set_strv("enabled-extensions", enabled):
    raise RuntimeError("GNOME did not accept the extension configuration")
Gio.Settings.sync()
metadata = json.loads((destination / "metadata.json").read_text())
print(f"Installed {metadata['name']} {metadata['version-name']}")
print(f"Terminal: {settings.get_string('terminal-id')}")
print("Log out and back in to load this build; the installer does not end your session.")
