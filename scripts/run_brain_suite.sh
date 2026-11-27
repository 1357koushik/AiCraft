#!/usr/bin/env bash
# Runs every task in brain_tasks/ once (or with the given extra flags) and prints one line per task.
cd "$(dirname "$0")/.."
for f in brain_tasks/*.json; do
  id=$(basename "$f" .json)
  [ "$id" = "stone_pickaxe" ] && continue
  out=$(npx tsx scripts/run_brain.ts "$f" "$@" 2>&1)
  verdict=$(echo "$out" | grep -a "\[brain\] \(PASS\|FAIL\|ERROR\|UNVERIFIED\|ASSISTED\)" | tail -1 | cut -c1-220)
  echo "$id: $verdict"
done
