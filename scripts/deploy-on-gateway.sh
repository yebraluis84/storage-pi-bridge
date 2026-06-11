#!/usr/bin/env bash
# Pull + build + install + restart storage-pi-bridge on a gateway.
#
# Usage (run on the gateway as a user with sudo or as root):
#   curl -sSL https://raw.githubusercontent.com/yebraluis84/storage-pi-bridge/main/scripts/deploy-on-gateway.sh | bash
#
# Or pin to a specific commit/tag:
#   PI_BRIDGE_REF=main bash deploy-on-gateway.sh
#
# Assumes:
#   - Node + npm already installed (>=18)
#   - /opt/storage-pi-bridge already exists with a working .env (deploys only update dist/)
#   - The storage-pi-bridge.service systemd unit exists and runs as root
#
# What it does:
#   1. git pull (or clone) into /tmp/storage-pi-bridge-build
#   2. npm install (omits dev deps after build, keeps better-sqlite3 if present)
#   3. npm run build
#   4. rsync dist/ over /opt/storage-pi-bridge/dist/
#   5. systemctl restart storage-pi-bridge
#   6. tail -n 30 the journal to confirm the bridge re-connects to Railway

set -euo pipefail

PI_BRIDGE_REF="${PI_BRIDGE_REF:-main}"
REPO_URL="https://github.com/yebraluis84/storage-pi-bridge.git"
BUILD_DIR="/tmp/storage-pi-bridge-build"
INSTALL_DIR="/opt/storage-pi-bridge"
SERVICE_NAME="storage-pi-bridge"

# Re-exec under sudo if not root. Avoids surprise permission errors halfway through.
if [[ "${EUID}" -ne 0 ]]; then
  echo "[deploy] not root — re-running under sudo"
  exec sudo PI_BRIDGE_REF="${PI_BRIDGE_REF}" bash "$0" "$@"
fi

echo "[deploy] ref=${PI_BRIDGE_REF}  install=${INSTALL_DIR}  service=${SERVICE_NAME}"

# 1. Get source. Re-use existing checkout to keep node_modules warm.
if [[ -d "${BUILD_DIR}/.git" ]]; then
  echo "[deploy] updating existing checkout at ${BUILD_DIR}"
  git -C "${BUILD_DIR}" fetch origin --quiet
  git -C "${BUILD_DIR}" checkout --quiet "${PI_BRIDGE_REF}"
  git -C "${BUILD_DIR}" reset --hard --quiet "origin/${PI_BRIDGE_REF}" || git -C "${BUILD_DIR}" reset --hard --quiet "${PI_BRIDGE_REF}"
else
  echo "[deploy] cloning fresh into ${BUILD_DIR}"
  rm -rf "${BUILD_DIR}"
  git clone --quiet --branch "${PI_BRIDGE_REF}" "${REPO_URL}" "${BUILD_DIR}"
fi

cd "${BUILD_DIR}"
echo "[deploy] HEAD: $(git rev-parse --short HEAD) - $(git log -1 --format=%s)"

# 2. Install + build.
echo "[deploy] npm ci (or npm install if no lock)"
if [[ -f package-lock.json ]]; then
  npm ci --silent
else
  npm install --silent
fi
echo "[deploy] npm run build"
npm run build --silent

# 3. Sync dist/. Keep .env, node_modules, gw.sqlite, anything outside dist/ untouched.
echo "[deploy] syncing dist/ -> ${INSTALL_DIR}/dist/"
mkdir -p "${INSTALL_DIR}/dist"
rsync -a --delete "${BUILD_DIR}/dist/" "${INSTALL_DIR}/dist/"

# Also sync node_modules — the new build may have new prod deps. Skip if the
# build dir's node_modules has dev deps mixed in (keep production-clean).
if [[ -d "${BUILD_DIR}/node_modules" ]]; then
  echo "[deploy] running npm prune --production in build dir before syncing modules"
  ( cd "${BUILD_DIR}" && npm prune --omit=dev --silent ) || true
  echo "[deploy] syncing node_modules/"
  rsync -a --delete "${BUILD_DIR}/node_modules/" "${INSTALL_DIR}/node_modules/"
fi

# 4. Restart service.
echo "[deploy] systemctl restart ${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
sleep 2
systemctl --no-pager --lines=0 status "${SERVICE_NAME}" || true

# 5. Show recent journal — confirms WS reconnect + identifies any startup error.
echo "[deploy] tailing last 30 journal lines:"
journalctl -u "${SERVICE_NAME}" --no-pager -n 30 || true

echo "[deploy] done."
