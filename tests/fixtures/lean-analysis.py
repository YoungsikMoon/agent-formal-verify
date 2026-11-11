# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Emit controlled frontend results for mutation-runner orchestration tests."""
import json
import sys
from pathlib import Path

config, source = (Path(arg) for arg in sys.argv[1:])
settings = json.loads(config.read_text(encoding="utf-8"))
text = source.read_text(encoding="utf-8")
analysis = settings["baseline"]
for mutation in settings["mutations"]:
    if mutation["text"] in text:
        analysis = mutation["analysis"]
        break
for error in analysis["errors"]:
    error.setdefault("fileName", str(source))
print("AFV_LEAN " + json.dumps(analysis))
