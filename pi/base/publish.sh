#!/usr/bin/env bash
set -Eeuo pipefail

base_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${PI_CORE_ENV_FILE:-${base_dir}/.env}"

if [[ ! -f "$env_file" ]]; then
    echo "Environment file not found: $env_file" >&2
    echo "Copy ${base_dir}/.env.example to ${base_dir}/.env and provide registry credentials." >&2
    exit 1
fi

set -a
# shellcheck source=/dev/null
source "$env_file"
set +a

: "${PI_CORE_REGISTRY:?PI_CORE_REGISTRY must be set in the environment file}"
: "${PI_CORE_REPOSITORY:?PI_CORE_REPOSITORY must be set in the environment file}"
: "${PI_CORE_USERNAME:?PI_CORE_USERNAME must be set in the environment file}"
: "${PI_CORE_PASSWORD:?PI_CORE_PASSWORD must be set in the environment file}"

platform="${PI_CORE_PLATFORM:-linux/amd64}"
tag="$(date +%F)"
image="${PI_CORE_REGISTRY%/}/${PI_CORE_REPOSITORY#/}"

printf '%s' "$PI_CORE_PASSWORD" | docker login "$PI_CORE_REGISTRY" --username "$PI_CORE_USERNAME" --password-stdin

docker buildx build \
    --platform "$platform" \
    --pull \
    --push \
    --provenance=true \
    --tag "${image}:${tag}" \
    --tag "${image}:latest" \
    --file "${base_dir}/Dockerfile" \
    "$base_dir"

printf '\nPublished image:\n  %s:%s\n  %s:latest\n' "$image" "$tag" "$image"
