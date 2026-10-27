#!/usr/bin/env python3
"""Export this reconstruction to the twin as detail overrides (docs/detail-overrides.md): runs tools/overrides/nyhavn.py on $NYHAVN_OUT.

    python3 tools/nyhavn/export_overrides.py [--out ~/.local/share/cph-twin/overrides/nyhavn] [any tools/overrides/nyhavn.py option]
"""
import os, subprocess, sys
from pathlib import Path

here = Path(__file__).resolve()
project = os.environ.get('NYHAVN_OUT', str(Path.home() / '.local/share/building-case-3d/nyhavn'))
args = sys.argv[1:]
if '--project' not in args:
    args = ['--project', project] + args
sys.exit(subprocess.call([sys.executable, str(here.parents[1] / 'overrides/nyhavn.py'), *args]))
