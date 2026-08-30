#!/usr/bin/env bash
set -euo pipefail

repo="yanny0616-glitch/ai-virtual-phone"
install_root="/opt/float"
releases_dir="$install_root/releases"
current_link="$install_root/current"
state_dir="/var/lib/float-deploy"
state_file="$state_dir/deployed-version"
service_name="float-ai-phone.service"
api_url="https://api.github.com/repos/$repo/releases/latest"

mkdir -p "$releases_dir" "$state_dir"
exec 9>"$state_dir/deploy.lock"
flock -n 9 || exit 0

work_dir=$(mktemp -d "$state_dir/update.XXXXXX")
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

curl -fsSL --connect-timeout 10 --max-time 60 \
  -H "Accept: application/vnd.github+json" \
  -o "$work_dir/release.json" "$api_url"

mapfile -t release_info < <(
  python3 - "$work_dir/release.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    release = json.load(handle)

assets = {asset["name"]: asset["browser_download_url"] for asset in release.get("assets", [])}
print(release.get("tag_name", ""))
print(assets.get("float-standalone.tar.gz", ""))
print(assets.get("float-standalone.tar.gz.sha256", ""))
PY
)

tag=${release_info[0]:-}
archive_url=${release_info[1]:-}
checksum_url=${release_info[2]:-}

if [[ ! "$tag" =~ ^float-build-[0-9a-f]{12}$ ]]; then
  echo "Refusing unexpected release tag: $tag" >&2
  exit 1
fi
if [[ "$archive_url" != https://github.com/$repo/releases/download/* ]] ||
   [[ "$checksum_url" != https://github.com/$repo/releases/download/* ]]; then
  echo "Release assets are missing or have unexpected URLs" >&2
  exit 1
fi
if [[ -f "$state_file" ]] && [[ "$(<"$state_file")" == "$tag" ]]; then
  echo "Float is already at $tag"
  exit 0
fi

curl -fsSL --connect-timeout 10 --max-time 300 -o "$work_dir/float-standalone.tar.gz" "$archive_url"
curl -fsSL --connect-timeout 10 --max-time 60 -o "$work_dir/float-standalone.tar.gz.sha256" "$checksum_url"
(
  cd "$work_dir"
  sha256sum --check float-standalone.tar.gz.sha256
)

release_dir="$releases_dir/$tag"
mkdir -p "$work_dir/runtime"
tar -xzf "$work_dir/float-standalone.tar.gz" -C "$work_dir/runtime" --no-same-owner
test -f "$work_dir/runtime/server.js"
test -d "$work_dir/runtime/.next/static"
test -d "$work_dir/runtime/public"

rm -rf -- "$release_dir"
mv "$work_dir/runtime" "$release_dir"
previous_target=$(readlink -f "$current_link" 2>/dev/null || true)
ln -s "$release_dir" "$work_dir/current"
mv -Tf "$work_dir/current" "$current_link"

if ! systemctl restart "$service_name"; then
  if [[ -n "$previous_target" ]] && [[ -d "$previous_target" ]]; then
    ln -s "$previous_target" "$work_dir/rollback"
    mv -Tf "$work_dir/rollback" "$current_link"
    systemctl restart "$service_name" || true
  fi
  echo "Service restart failed; rolled back to the previous release" >&2
  exit 1
fi

healthy=false
for _ in $(seq 1 20); do
  if curl -fsS --connect-timeout 2 --max-time 5 \
    -o /dev/null "http://172.17.0.1:3001/api/auth/me"; then
    healthy=true
    break
  fi
  sleep 1
done

if [[ "$healthy" != true ]]; then
  if [[ -n "$previous_target" ]] && [[ -d "$previous_target" ]]; then
    ln -s "$previous_target" "$work_dir/rollback"
    mv -Tf "$work_dir/rollback" "$current_link"
    systemctl restart "$service_name" || true
  fi
  echo "Health check failed; rolled back to the previous release" >&2
  exit 1
fi

printf '%s\n' "$tag" > "$state_file"
echo "Deployed $tag successfully"
