#!/usr/bin/env bash
# Glassboard updater.
#
# Runs as root, started by glassboard-update.service when the application drops
# its request file. The application never runs this script and never writes to
# its own directory: that separation is the whole point.
#
# Steps: download the branch as a tarball, install the production dependencies
# in a staging directory next to the app, carry the .env over, swap the two
# directories with a rename, restart the service, and roll back if the new
# version does not come up.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/glassboard}
DATA_DIR=${DATA_DIR:-/var/lib/glassboard}
SERVICE=${SERVICE:-glassboard}
APP_USER=${APP_USER:-glassboard}
REPO=${UPDATE_REPO:-Lokyron/GlassBoard}
BRANCH=${UPDATE_BRANCH:-main}

REQUEST_FILE="$DATA_DIR/update.request"
STATUS_FILE="$DATA_DIR/update.status"
STEP=start

status() { # state step [message]
  printf '{"state":"%s","step":"%s","message":"%s","at":"%s"}\n' \
    "$1" "$2" "${3:-}" "$(date -Is)" > "$STATUS_FILE"
  chown "$APP_USER" "$STATUS_FILE" 2>/dev/null || true
}
fail() { status failed "$STEP" "$1"; exit 1; }
trap 'fail "the updater stopped during: $STEP"' ERR

rm -f "$REQUEST_FILE"

STEP=download
status running "$STEP"
STAGING=$(mktemp -d "${APP_DIR}.update-XXXXXX")   # same filesystem, so the swap is a rename
cleanup() { [ -d "$STAGING" ] && rm -rf "$STAGING"; }
trap cleanup EXIT
curl -fsSL --max-time 180 "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}" \
  | tar -xz -C "$STAGING" --strip-components=1
[ -f "$STAGING/package.json" ] || fail "the downloaded archive is not Glassboard"

STEP=version
status running "$STEP"
SHA=$(curl -fsSL --max-time 30 "https://api.github.com/repos/${REPO}/commits/${BRANCH}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).sha||""))')

STEP=dependencies
status running "$STEP"
(cd "$STAGING" && npm ci --omit=dev --no-audit --no-fund >/dev/null)

STEP=swap
status running "$STEP"
[ -f "$APP_DIR/.env" ] && cp -a "$APP_DIR/.env" "$STAGING/.env"
printf '{"commit":"%s","branch":"%s","installedAt":"%s"}\n' "$SHA" "$BRANCH" "$(date -Is)" > "$STAGING/VERSION"
chown -R root:root "$STAGING"
PREVIOUS="${APP_DIR}.previous"
rm -rf "$PREVIOUS"
mv "$APP_DIR" "$PREVIOUS"
mv "$STAGING" "$APP_DIR"
trap - EXIT

STEP=restart
status running "$STEP"
systemctl restart "$SERVICE"
sleep 3
if ! systemctl is-active --quiet "$SERVICE"; then
  rm -rf "${APP_DIR}.failed"
  mv "$APP_DIR" "${APP_DIR}.failed"
  mv "$PREVIOUS" "$APP_DIR"
  systemctl restart "$SERVICE" || true
  fail "the new version did not start, the previous one was put back"
fi

status done complete "updated to ${SHA:0:7}"
rm -rf "$PREVIOUS"
