#!/usr/bin/env bash
#
# Update-Skript für ein produktives opencast-xr-Deployment
# (siehe docs/INSTALL-rocky-linux-10.md).
#
# Macht in einem Durchlauf: git pull → Opencast-URL einsetzen → Build →
# nach $WEBROOT synchronisieren → SELinux-Labels erneuern. Die Quelltext-
# Änderung für die Server-URL wird nur für den Build eingesetzt und danach
# wieder zurückgenommen, damit das Arbeitsverzeichnis für das nächste
# `git pull` sauber bleibt.
#
# Einrichtung (einmalig): dieses Skript legt beim ersten Aufruf eine
# .update-config im Repo-Wurzelverzeichnis an (nicht versioniert) — dort
# OPENCAST_URL und WEBROOT eintragen, dann erneut aufrufen.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

CONFIG_FILE="$REPO_DIR/.update-config"
if [[ ! -f "$CONFIG_FILE" ]]; then
  cat > "$CONFIG_FILE" <<'EOF'
# Konfiguration für scripts/update.sh (nicht versioniert).
# Die URL Ihres Opencast-Servers (Search-API muss CORS-seitig erreichbar sein):
OPENCAST_URL="https://opencast.example.org"
# Zielverzeichnis des Webservers (Caddy/nginx "root"):
WEBROOT="/var/www/opencast-xr"
# Node-Heap für den Build in MB. Auf kleinen VMs setzt Node sein Limit
# sonst zu niedrig an und der Build bricht mit "heap out of memory" ab.
# Nicht höher setzen, als die VM an freiem RAM hat (siehe: free -h).
NODE_HEAP_MB=2048
EOF
  echo "Erstaufruf: $CONFIG_FILE wurde angelegt."
  echo "Bitte OPENCAST_URL und WEBROOT dort eintragen und das Skript erneut starten."
  exit 1
fi

# shellcheck source=/dev/null
source "$CONFIG_FILE"

if [[ "${OPENCAST_URL:-}" == "" || "$OPENCAST_URL" == "https://opencast.example.org" ]]; then
  echo "FEHLER: OPENCAST_URL in $CONFIG_FILE ist noch nicht gesetzt." >&2
  exit 1
fi

APP_FILE="src/App.tsx"

# Das Arbeitsverzeichnis muss sauber sein, damit pull und Patch verlässlich
# sind — einzig eine liegengebliebene URL-Änderung räumen wir selbst weg.
git restore "$APP_FILE" 2>/dev/null || true
if [[ -n "$(git status --porcelain)" ]]; then
  echo "FEHLER: Das Repo hat lokale Änderungen (git status). Bitte erst aufräumen." >&2
  exit 1
fi

echo "==> git pull"
git pull --ff-only

# Ab hier garantiert das Skript, dass die URL-Änderung auch bei einem
# Fehlschlag wieder zurückgenommen wird.
trap 'git restore "$APP_FILE" 2>/dev/null || true' EXIT

echo "==> Opencast-URL einsetzen: $OPENCAST_URL"
sed -i "s|new OpencastClient()|new OpencastClient({ baseUrl: '$OPENCAST_URL' })|" "$APP_FILE"
if ! grep -qF "new OpencastClient({ baseUrl: '$OPENCAST_URL' })" "$APP_FILE"; then
  echo "FEHLER: Die erwartete Stelle 'new OpencastClient()' wurde in $APP_FILE nicht gefunden." >&2
  echo "Der Quelltext hat sich vermutlich geändert — bitte docs/INSTALL-rocky-linux-10.md," >&2
  echo "Abschnitt 'Opencast-Server-URL setzen', gegen den aktuellen Stand prüfen." >&2
  exit 1
fi

echo "==> Abhängigkeiten (lockfile-treu)"
pnpm install --frozen-lockfile

echo "==> Build (Node-Heap: ${NODE_HEAP_MB:-2048} MB)"
NODE_OPTIONS="--max-old-space-size=${NODE_HEAP_MB:-2048}" pnpm build

echo "==> Nach $WEBROOT synchronisieren"
sudo mkdir -p "$WEBROOT"
sudo rsync -a --delete dist/ "$WEBROOT"/

if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then
  echo "==> SELinux-Labels erneuern"
  sudo restorecon -R "$WEBROOT"
fi

echo "==> Fertig. Ausgeliefert nach $WEBROOT (Quelle: $(git rev-parse --short HEAD))."
