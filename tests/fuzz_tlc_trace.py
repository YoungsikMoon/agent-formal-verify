# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Check that reducing a generated TLC trace reports exactly the state changes, and that parse() reads the same trace."""
import sys
from pathlib import Path

import atheris

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills/formal-verify/scripts"))
with atheris.instrument_imports():
    import tlc_trace
import tlc_trace_agreement


def check_trace(data):
    lines = ["Error: The behavior up to this point is:"]
    expected = []
    previous = {}
    for step, byte in enumerate(data, start=1):
        # Small value ranges exercise steps where neither, one or both values change.
        values = {"x": byte & 3, "y": (byte >> 2) & 3}
        action = "Initial predicate" if step == 1 else "Step"
        lines.append(f"State {step}: <{action}>")
        expected.append(f"--- state {step}: {action}")
        for name, value in values.items():
            lines.append(f"/\\ {name} = {value}")
            if previous.get(name) != value:
                expected.append(f"    {name} = {value}")
        lines.append("")
        previous = values

    assert tlc_trace.reduce(lines) == (expected or None)
    assert tlc_trace_agreement.differences(lines) == ([], [])


if __name__ == "__main__":
    atheris.Setup(sys.argv, check_trace)
    atheris.Fuzz()
