#!/usr/bin/env bash
# Prefer system-installed esbuild (e.g. Homebrew) over the npm-bundled binary.
# The bundled @esbuild/<platform> binaries are unsigned and may be blocked by
# endpoint-security tools (Santa on macOS). The Homebrew-installed binary at
# /opt/homebrew/bin/esbuild is already approved.
#
# Usage: source this from .envrc or your shell profile.
#
#   source scripts/prefer-system-esbuild.sh   # exports ESBUILD_BINARY_PATH

if [ -z "$ESBUILD_BINARY_PATH" ]; then
  for _candidate in /opt/homebrew/bin/esbuild /usr/local/bin/esbuild; do
    if [ -x "$_candidate" ]; then
      export ESBUILD_BINARY_PATH="$_candidate"
      break
    fi
  done
  unset _candidate
fi
