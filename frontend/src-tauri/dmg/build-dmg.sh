#!/usr/bin/env bash
set -euo pipefail

app="$1"
out="$2"
dir="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"

python3 -m venv "$work/venv"
"$work/venv/bin/pip" install --quiet dmgbuild==1.6.7
"$work/venv/bin/dmgbuild" -s "$dir/settings.py" -D app="$app" -D background="$dir/background.png" -D icon="$dir/../icons/app_icon.icns" "$(basename "$app" .app)" "$out"

mkdir "$work/mount"
hdiutil attach -nobrowse -readonly -mountpoint "$work/mount" "$out" >/dev/null
trap 'hdiutil detach "$work/mount" >/dev/null' EXIT
test -f "$work/mount/.DS_Store"
test -f "$work/mount/.background.tiff"
test -L "$work/mount/Applications"
test -d "$work/mount/$(basename "$app")"
echo "Built $out with the Finder layout"
