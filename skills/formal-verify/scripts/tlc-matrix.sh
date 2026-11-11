#!/bin/bash
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
# Model-checks TLA+ specs with TLC over a matrix of constants. tlc.py holds the
# runner and documents the matrix file and its environment settings.
# Usage: tlc-matrix.sh <matrix-file> [label-substring]
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { echo "usage: tlc-matrix.sh <matrix-file> [label-substring]"; exit 2; }
command -v python3 > /dev/null || { echo "UNAVAILABLE python3 is not on PATH; install Python 3"; exit 3; }
exec python3 "$(dirname "$0")/tlc.py" "$@"
