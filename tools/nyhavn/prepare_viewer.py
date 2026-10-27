#!/usr/bin/env python3
"""Install the Nyhavn viewer and checksum-pinned Three.js dependencies."""
import hashlib
import json
import os
from pathlib import Path
import shutil
from urllib.request import urlopen


def main():
    source = Path(__file__).resolve().parent
    project = Path(os.environ.get("NYHAVN_OUT", Path.home() / ".local/share/building-case-3d/nyhavn")).expanduser()
    viewer = project / "viewer-v2"
    for relative, entry in json.loads((source / "viewer/dependencies.json").read_text()).items():
        destination = viewer / "vendor" / relative
        if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest() == entry["sha256"]:
            continue
        with urlopen(entry["url"], timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError(f"Dependency checksum mismatch: {relative}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    for name in ("index.html", "main.js", "style.css"):
        shutil.copy2(source / "viewer" / name, viewer / name)
    scripts = project / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    if source != scripts.resolve():
        shutil.copytree(source / "viewer", scripts / "viewer", dirs_exist_ok=True)
        for name in ("prepare_viewer.py", "serve.py"):
            shutil.copy2(source / name, scripts / name)
    print(f"Viewer installed: {viewer}")


if __name__ == "__main__":
    main()
