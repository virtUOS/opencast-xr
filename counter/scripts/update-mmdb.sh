#!/usr/bin/env bash
# Downloads the current month's db-ip.com "Country Lite" database and installs
# it at the path the counter service expects (COUNTER_MMDB_PATH, default
# /var/lib/opencast-xr-counter/dbip-country-lite.mmdb — see
# opencast-xr-counter.service). Free, no API key or account required,
# licensed CC BY 4.0 (attribution already on the /stats page — see
# counter/src/render.js).
#
# Run manually, or wire up as a monthly systemd timer (optional — the
# database only goes slightly less precise over time as new IP ranges are
# allocated; there is no hard requirement to refresh it on any schedule).
#
# Usage: sudo ./update-mmdb.sh [destination-path]
set -euo pipefail

DEST="${1:-/var/lib/opencast-xr-counter/dbip-country-lite.mmdb}"
YEAR_MONTH="$(date -u +%Y-%m)"
URL="https://download.db-ip.com/free/dbip-country-lite-${YEAR_MONTH}.mmdb.gz"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ${URL} ..."
curl -fsSL "$URL" -o "${TMP_DIR}/dbip-country-lite.mmdb.gz"

echo "Decompressing ..."
gunzip -c "${TMP_DIR}/dbip-country-lite.mmdb.gz" > "${TMP_DIR}/dbip-country-lite.mmdb"

echo "Installing to ${DEST} ..."
install -D -m 0644 "${TMP_DIR}/dbip-country-lite.mmdb" "${DEST}"

echo "Done. Restart the counter service if it's already running so it picks up the new file:"
echo "  sudo systemctl restart opencast-xr-counter.service"
