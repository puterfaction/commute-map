#!/bin/bash
# Put an archived snapshot back live.
#   pipeline/restore_snapshot.sh streeteasy 2026-07-31
#   pipeline/restore_snapshot.sh craigslist            # lists available dates
set -e
cd "$(dirname "$0")/.."
src=$1; day=$2
[ -z "$day" ] && { ls "archive/$src" | sed 's/\.json$//'; exit 0; }
cp "archive/$src/$day.json" "data/listings-$src.json"
git add "data/listings-$src.json"
git commit -qm "restore $src snapshot $day"
git push -q
echo "restored $src $day (live in ~1 min)"
