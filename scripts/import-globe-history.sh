#!/usr/bin/env bash
# Imports a day of adsb.lol globe history (default: yesterday, UTC) into the
# database, then points the compose server's REPLAY_DATE at it.
#
# usage: scripts/import-globe-history.sh [YYYY-MM-DD]
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
date=${1:-$(date -u -d yesterday +%F)}
if ! [[ $date =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || ! date -u -d "$date" >/dev/null 2>&1; then
    echo "invalid date: $date (expected YYYY-MM-DD)" >&2
    exit 2
fi

year=${date:0:4}
tag="v${date//-/.}-planes-readsb-prod-0"
repo_slug="adsblol/globe_history_${year}"
work=${GLOBE_HISTORY_DIR:-$HOME/.cache/controltower/globe_history}/$tag

# The archive is split into parts (.tar.aa, .tar.ab, ...). List them from the
# release so a missing release fails here, before anything is downloaded.
release_json=$(curl -fsS --retry 3 "https://api.github.com/repos/${repo_slug}/releases/tags/${tag}") || {
    echo "release $tag not found in $repo_slug (not published yet?)" >&2
    exit 1
}
mapfile -t parts < <(python3 -I -c '
import json, re, sys
names = [a["name"] for a in json.load(sys.stdin)["assets"]]
print("\n".join(sorted(n for n in names if re.fullmatch(r".*\.tar\.[a-z]{2}", n))))
' <<<"$release_json")
if [[ ${#parts[@]} -eq 0 ]]; then
    echo "release $tag has no .tar.?? parts" >&2
    exit 1
fi

rm -rf "$work"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

echo "downloading $tag (${#parts[@]} parts) into $work"
# Only traces/ is imported, so the rest of the archive isn't extracted.
for part in "${parts[@]}"; do
    curl -fsSL --retry 3 "https://github.com/${repo_slug}/releases/download/${tag}/${part}"
done | tar -x -C "$work" --no-same-owner --no-same-permissions ./traces

echo "importing $date"
(cd "$repo/apps/api" && cargo run --release -p ingest -- import "$work")

echo "REPLAY_DATE=$date" >|"$repo/.env.replay"
(cd "$repo" && docker compose up -d server)
echo "server now replays $date"
