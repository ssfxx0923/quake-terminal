#!/usr/bin/env python3
"""Build the extension using tools shipped with GNOME; make is optional.

SPDX-License-Identifier: LGPL-3.0-or-later
Copyright 2026 ssfxx0923
"""

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--install", action="store_true", help="Install the package after building")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
source = root / "src"
metadata = json.loads((source / "metadata.json").read_text())
output = root / "dist"
output.mkdir(exist_ok=True)
subprocess.run(["glib-compile-schemas", "--strict", "--dry-run", str(source / "schemas")], check=True)
with tempfile.TemporaryDirectory(prefix="quake-sidebar-build-") as directory:
    stage = Path(directory)
    for filename in ("extension.js", "quake-mode.js", "sidebar.js", "visibility.js", "prefs.js", "metadata.json"):
        shutil.copy2(source / filename, stage / filename)
    (stage / "schemas").mkdir()
    for schema in (source / "schemas").glob("*.gschema.xml"):
        shutil.copy2(schema, stage / "schemas" / schema.name)
    shutil.copy2(root / "LICENSE", stage / "LICENSE")
    command = ["gnome-extensions", "pack", "--force", "--out-dir", str(output),
               "--extra-source=quake-mode.js", "--extra-source=sidebar.js",
               "--extra-source=visibility.js", "--extra-source=LICENSE"]
    if shutil.which("msgfmt"):
        shutil.copytree(source / "po", stage / "po")
        command.append("--podir=po")
    subprocess.run(command + [str(stage)], check=True)
package = output / f"{metadata['uuid']}.shell-extension.zip"
print(f"Built {package}")
if args.install:
    subprocess.run(["python3", str(root / "scripts/install-local.py"), str(package)], check=True)
