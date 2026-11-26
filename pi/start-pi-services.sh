#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  pi pulse stop || true
  pi console stop || true
  pi api stop || true
}

trap cleanup EXIT
trap 'exit 0' INT TERM

pi api start
pi pulse start
pi console start

tail -f /dev/null &
wait $!
