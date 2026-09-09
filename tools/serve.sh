#!/usr/bin/env bash
# Starts the bridge and the static server. It uses your Claude Code sign in.
set -e
cd "$(dirname "$0")/.."
exec node tools/bridge.mjs "${1:-8777}"
