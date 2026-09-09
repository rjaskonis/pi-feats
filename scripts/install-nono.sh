#!/usr/bin/env sh
set -eu

if command -v nono >/dev/null 2>&1; then
  printf '%s\n' "Nono is already available: $(command -v nono)"
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  printf '%s\n' "Nono is required by pi-feats but curl is not available to install it." >&2
  printf '%s\n' "Install curl and rerun npm install, or install Nono manually from https://nono.sh/." >&2
  exit 1
fi

temporary="$(mktemp "${TMPDIR:-/tmp}/pi-feats-nono.XXXXXX")"
cleanup() { rm -f "$temporary"; }
trap cleanup EXIT HUP INT TERM

printf '%s\n' "Installing Nono for sandboxed Pi Profiles..."
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 https://nono.sh/install.sh --output "$temporary"
sh "$temporary"

if command -v nono >/dev/null 2>&1; then
  printf '%s\n' "Installed Nono: $(command -v nono)"
  exit 0
fi

if [ -x "$HOME/.local/bin/nono" ]; then
  printf '%s\n' "Nono was installed at $HOME/.local/bin/nono. Add $HOME/.local/bin to PATH before running Pi." >&2
  exit 0
fi

printf '%s\n' "Nono installation finished but the nono executable was not found." >&2
exit 1
