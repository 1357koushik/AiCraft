#!/usr/bin/env bash
# Runs every task in brain_tasks/ (except the long stone_pickaxe) and prints one line per run, from verdict.json.
# Extra flags (e.g. --seeds a,b,c --repeat n) are passed to run_brain.ts.
cd "$(dirname "$0")/.."
for f in brain_tasks/*.json; do
  id=$(basename "$f" .json)
  [ "$id" = "stone_pickaxe" ] && continue
  out=$(npx tsx scripts/run_brain.ts "$f" "$@" 2>&1)
  for run in $(echo "$out" | grep -ao "brain_[0-9]*_[0-9]*_${id}" | sort -u); do
    node -e "const v=require('./logs/runs/$run/verdict.json'); const b=(()=>{try{return require('./logs/runs/$run/brain.json')}catch{return {}}})(); console.log('$id', '$run', v.status, (b.calls??'?')+' calls', '|', v.reason.slice(0,150))"
  done
done
