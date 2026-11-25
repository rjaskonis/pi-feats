#!/bin/sh
set -eu

case "${1:-}" in
  status|restart|pair|tabs|navigate|snapshot|click|fill|type|press|select|hover|drag|scroll|wait_for|dialog|upload|eval|screenshot|screenshot_diff|network|console|handoff|settings|mcp|--version) ;;
  *)
    printf '%s\n' 'Usage: pi-agent-browse <status|pair|tabs|navigate|snapshot|...|mcp>' >&2
    exit 2
    ;;
esac

root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
OPENCODE_BROWSER_HOME=${XDG_STATE_HOME:-$HOME/.local/state}/pi-agent-browse
umask 077
mkdir -p -- "$OPENCODE_BROWSER_HOME"
export OPENCODE_BROWSER_HOME
export OPENCODE_BROWSER_PORT=20087
export OPENCODE_BROWSER_AUTO_UPDATE=off
unset OPENCODE_BROWSER_ALLOW_FOREGROUND OPENCODE_BROWSER_ALLOW_ALL_COOKIES OPENCODE_BROWSER_ALLOW_ALL_STORAGE
unset OPENCODE_BROWSER_ALLOW_FILE_URLS OPENCODE_BROWSER_ALLOW_REMOTE_DRIVERS OPENCODE_BROWSER_EXTENSION_ORIGINS
exec "$root/pi-agent-browse-relay" "$@"
