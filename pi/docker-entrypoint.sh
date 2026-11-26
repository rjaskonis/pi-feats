#!/usr/bin/env bash
set -euo pipefail

# Pi's native configuration directory is /root/.pi/agent. The mounted
# /root/.pi directory is only its persistent parent directory.
agent_dir=/root/.pi/agent
legacy_dir=/root/.pi
pi_feats_source="${PI_FEATS_SOURCE:-git:github.com/rjaskonis/pi-feats}"
pi_feats_ref="${PI_FEATS_REF:-main}"
case "$pi_feats_source" in
  git:*/*) ;;
  *) echo "PI_FEATS_SOURCE must use the git:<host>/<owner>/<repository> form without a ref." >&2; exit 1 ;;
esac
pi_feats_path="${pi_feats_source#git:}"
if [[ "$pi_feats_path" == *"@"* ]]; then
  echo "PI_FEATS_SOURCE must not contain a ref; set PI_FEATS_REF instead." >&2
  exit 1
fi
pi_feats_package="${pi_feats_source}@${pi_feats_ref}"
pi_feats_dir="$agent_dir/git/${pi_feats_path%.git}"
mkdir -p "$agent_dir" "$agent_dir/legacy-root"

# Older deployments incorrectly wrote native Pi files directly into /root/.pi.
# Merge those files into the native agent directory once, then archive the old
# copies so future Pi processes cannot accidentally read the wrong location.
migrate_legacy_json() {
  local name="$1" legacy="$legacy_dir/$1" target="$agent_dir/$1"
  [ -f "$legacy" ] || return 0
  LEGACY_FILE="$legacy" TARGET_FILE="$target" node -e '
    const fs = require("fs");
    const read = (path) => fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
    const merge = (base, override) => Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(override)])].map((key) => {
      const left = base[key], right = override[key];
      return [key, left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right) ? merge(left, right) : right ?? left];
    }));
    const output = merge(read(process.env.LEGACY_FILE), read(process.env.TARGET_FILE));
    const temporary = process.env.TARGET_FILE + ".migration-" + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, process.env.TARGET_FILE);
  '
  mv "$legacy" "$agent_dir/legacy-root/$name"
  echo "Migrated legacy Pi file: $name" >&2
}

for name in settings.json auth.json models.json models-store.json; do
  migrate_legacy_json "$name"
done

if [ -d "$legacy_dir/sessions" ]; then
  mkdir -p "$agent_dir/sessions"
  rsync -a --ignore-existing "$legacy_dir/sessions/" "$agent_dir/sessions/"
  mv "$legacy_dir/sessions" "$agent_dir/legacy-root/sessions"
  echo "Migrated legacy Pi sessions." >&2
fi

if [ -d "$legacy_dir/bin" ]; then
  mkdir -p "$agent_dir/bin"
  rsync -a --ignore-existing "$legacy_dir/bin/" "$agent_dir/bin/"
  mv "$legacy_dir/bin" "$agent_dir/legacy-root/bin"
  echo "Migrated legacy Pi binaries." >&2
fi

# Previous images copied pi-feats' source directly to agent/extensions. Archive
# it instead of loading it together with the package, which would register each
# extension twice. User data never lives in this directory.
if [ -d "$agent_dir/extensions" ] && [ ! -e "$agent_dir/legacy-root/extensions" ]; then
  mv "$agent_dir/extensions" "$agent_dir/legacy-root/extensions"
  echo "Archived legacy local extensions." >&2
fi

# Seed the package-manager location only once. Explicit `pi update` operations
# remain persistent across restarts and are never overwritten by this image.
if [ ! -f "$pi_feats_dir/package.json" ]; then
  mkdir -p "$(dirname "$pi_feats_dir")"
  rsync -a --delete /opt/pi-feats/ "$pi_feats_dir/"
  echo "Seeded pi-feats package: $pi_feats_package" >&2
fi

# Register precisely one pi-feats package entry. Pi resolves its extension list
# from the package manifest; no top-level `extensions` paths are configured.
AGENT_DIR="$agent_dir" PI_FEATS_SOURCE="$pi_feats_source" PI_FEATS_PACKAGE="$pi_feats_package" node -e '
  const fs = require("fs");
  const path = require("path");
  const settingsPath = path.join(process.env.AGENT_DIR, "settings.json");
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
  const source = process.env.PI_FEATS_SOURCE;
  const sourceIdentity = source.replace(/^git:/, "").replace(/@.*$/, "");
  const packageSource = (entry) => typeof entry === "string" ? entry : entry && entry.source;
  const samePackage = (entry) => {
    const value = packageSource(entry);
    return typeof value === "string" && value.replace(/^git:/, "").replace(/@.*$/, "") === sourceIdentity;
  };
  settings.packages = [...(Array.isArray(settings.packages) ? settings.packages : []).filter((entry) => !samePackage(entry)), process.env.PI_FEATS_PACKAGE];
  const temporary = settingsPath + ".package-" + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, settingsPath);
'

# Initialize secrets only on first startup. Environment values take precedence
# and the persistent volume is never overwritten.
random_secret() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))'; }
if [ ! -f "$agent_dir/pi-console.webui.json" ]; then
  console_username="${PI_CONSOLE_USERNAME:-admin}"
  console_password="${PI_CONSOLE_PASSWORD:-}"
  if [ -z "$console_password" ]; then
    console_password="$(random_secret)"
    echo "PI_CONSOLE_PASSWORD was not set; a random initial password was generated in $agent_dir/pi-console.webui.json." >&2
  fi
  AGENT_DIR="$agent_dir" CONSOLE_USERNAME="$console_username" CONSOLE_PASSWORD="$console_password" node -e '
    const fs = require("fs");
    fs.writeFileSync(process.env.AGENT_DIR + "/pi-console.webui.json", JSON.stringify({ host: "0.0.0.0", port: 3030, username: process.env.CONSOLE_USERNAME, password: process.env.CONSOLE_PASSWORD }, null, 2) + "\n", { mode: 0o600 });
  '
fi
if [ ! -f "$agent_dir/api-server.json" ]; then
  api_token="${PI_API_TOKEN:-}"
  if [ -z "$api_token" ]; then
    api_token="$(random_secret)"
    echo "PI_API_TOKEN was not set; a random initial token was generated in $agent_dir/api-server.json." >&2
  elif [ "${#api_token}" -lt 24 ]; then
    echo "PI_API_TOKEN must contain at least 24 characters." >&2
    exit 1
  fi
  AGENT_DIR="$agent_dir" API_TOKEN="$api_token" API_CORS_ORIGIN="${PI_API_CORS_ORIGIN:-}" PUBLIC_BASE_URL="${PI_PUBLIC_BASE_URL:-}" node -e '
    const fs = require("fs");
    fs.writeFileSync(process.env.AGENT_DIR + "/api-server.json", JSON.stringify({ host: "0.0.0.0", port: 8767, apiToken: process.env.API_TOKEN, cors: { origin: process.env.API_CORS_ORIGIN || "*" }, publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined }, null, 2) + "\n", { mode: 0o600 });
  '
fi

if [ "$#" -eq 0 ] || [[ "$1" == -* ]]; then
  set -- pi "$@"
elif [[ "$1" != "pi" && "$1" != "bash" && "$1" != "sh" && "$1" != /* ]]; then
  set -- pi "$@"
fi

exec "$@"
