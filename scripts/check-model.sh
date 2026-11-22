#!/usr/bin/env bash
set -euo pipefail

model=${1:?Specify a model name from verification/models}
invariant=${2:?Specify the historical invariant}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT

curl --fail --silent --show-error --location --retry 3 --max-time 60 \
  https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar \
  --output "$scratch/tla2tools.jar"
cd "$scratch"
sha256sum --check <<'CHECKSUM'
936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  tla2tools.jar
CHECKSUM

cp "$root/verification/models/$model.tla" "$root/verification/models/$model".*.cfg \
  "$root/verification/models/$model.cfg" .
run_tlc() {
  java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers 1 -deadlock -config "$1" "$model.tla"
}

run_tlc "$model.cfg"
for historical in "$model".historical.*.cfg; do
  status=0
  run_tlc "$historical" > historical.log 2>&1 || status=$?
  cat historical.log
  if [[ $status != 12 ]] || ! grep -Fxq "Error: Invariant $invariant is violated." historical.log; then
    printf '%s\n' "Expected $historical to violate $invariant (TLC status $status)." >&2
    exit 1
  fi
done
