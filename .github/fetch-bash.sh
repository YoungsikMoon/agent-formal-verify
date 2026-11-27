#!/usr/bin/env bash
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
set -eu

mkdir -p "$BASH_TARBALL_DIR"
cd "$BASH_TARBALL_DIR"

check() {
  echo "$BASH_TARBALL_SHA256  bash-3.2.57.tar.gz" | sha256sum -c -
}

fetch() {
  curl -fL --no-progress-meter --connect-timeout 30 --retry 3 -o bash-3.2.57.tar.gz "$1" && check
}

{ [ -f bash-3.2.57.tar.gz ] && check; } ||
  fetch https://ftpmirror.gnu.org/bash/bash-3.2.57.tar.gz ||
  fetch https://ftp.gnu.org/gnu/bash/bash-3.2.57.tar.gz
