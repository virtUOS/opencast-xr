# Installationsanleitung: Opencast-Player auf Rocky Linux 10

Diese Anleitung richtet sich an Administratorinnen und Administratoren, die
den [`opencast-player`](../README.md) als statische
Website produktiv auf einem Rocky-Linux-10-Server betreiben wollen. Der
Player selbst ist ein reines Client-seitiges Build (HTML/JS/CSS ohne
eigenen Server-Prozess); ausgeliefert wird er über einen gewöhnlichen
Webserver (hier: nginx).

Alle Befehle sind zum Kopieren gedacht. Ersetzen Sie Platzhalter wie
`opencast.example.org` und `player.example.org` durch Ihre tatsächlichen
Hostnamen — es handelt sich **nicht** um echte, erreichbare Adressen.

## Inhalt

1. [Voraussetzungen](#1-voraussetzungen)
2. [Build erstellen](#2-build-erstellen)
3. [Auslieferung mit nginx](#3-auslieferung-mit-nginx)
4. [HTTPS (WebXR erfordert einen sicheren Kontext)](#4-https-webxr-erfordert-einen-sicheren-kontext)
5. [SELinux](#5-selinux)
6. [firewalld](#6-firewalld)
7. [CORS auf dem Opencast-Server](#7-cors-auf-dem-opencast-server)
8. [Update-Verfahren](#8-update-verfahren)

## 1. Voraussetzungen

### Node.js

Der Player wird mit Vite 6 gebaut. Das in diesem Repository tatsächlich
installierte Vite (6.4.3) verlangt laut seinem `package.json`
(`engines.node`) eine der folgenden Node-Versionen:

```
^18.0.0 || ^20.0.0 || >=22.0.0
```

Anders als unter RHEL/Rocky 8 oder 9 ist Node.js unter Rocky Linux 10 kein
modulares AppStream-Paket mehr (`dnf module ...` gibt es dafür nicht
mehr — ein `dnf module enable nodejs:...` schlägt mit „no modular data
found“ fehl). Stattdessen installiert das reguläre Paket direkt eine
feste Node-Hauptversion (zum Zeitpunkt dieser Anleitung 22.x, was die
obige Anforderung erfüllt):

```bash
sudo dnf install -y nodejs
node --version
```

Prüfen Sie die ausgegebene Version gegen die oben genannte Anforderung.
Liefert Ihr AppStream-Repository eine Hauptversion, die die Anforderung
**nicht** erfüllt (z. B. weil ein künftiger Rocky-10-Minor-Release auf
eine andere Node-Hauptversion umstellt), installieren Sie stattdessen
über das offizielle NodeSource-Repository oder über `nvm` — beide
erlauben, eine bestimmte Node-Hauptversion unabhängig vom
AppStream-Paket zu wählen.

### pnpm

Das Projekt pinnt den Paketmanager über `packageManager` in der
Root-`package.json` auf `pnpm@10.4.1`. Die offiziellen Node-Builds
brächten dafür Corepack mit — **das Rocky-/RHEL-RPM liefert Corepack
jedoch nicht aus** (`corepack: command not found`). Installieren Sie
pnpm deshalb über das mitgelieferte npm:

```bash
sudo npm install -g pnpm@10.4.1
pnpm --version
```

(Alternativ funktioniert jeder `pnpm`-Aufruf in dieser Anleitung auch
ohne globale Installation als `npx pnpm@10.4.1 …`.)

### git

```bash
sudo dnf install -y git
```

## 2. Build erstellen

Als ein dafür vorgesehener, nicht-privilegierter Build-Benutzer (kein
`root`):

```bash
git clone https://github.com/virtUOS/opencast-xr.git
cd opencast-xr
pnpm install
```

### Opencast-Server-URL setzen

**Wichtig — das ist kein Konfigurationsfeld und keine Umgebungsvariable,
sondern eine Code-Änderung vor dem Build.** Der Player verbindet sich in
seiner ausgelieferten Form standardmäßig mit
`https://develop.opencast.org` (Konstante `DEFAULT_BASE_URL` in
`src/opencast/client.ts`). Für den produktiven
Einsatz muss vor dem Build in
`src/App.tsx` die `baseUrl`-Option gesetzt werden.
Suchen Sie im aktuellen Quelltext nach genau diesen Zeilen (Stand dieses
Repositories):

```ts
// src/App.tsx — aktueller Stand, unverändert
const client = useMemo(
  () => (import.meta.env.DEV ? new SyntheticDualStreamClient() : new OpencastClient()),
  [],
)
```

und ersetzen Sie sie durch:

```ts
// src/App.tsx — angepasst für dieses Deployment
const client = useMemo(
  () => {
    const options = { baseUrl: 'https://opencast.example.org' }   // <- anpassen
    return import.meta.env.DEV ? new SyntheticDualStreamClient(options) : new OpencastClient(options)
  },
  [],
)
```

Ersetzen Sie `https://opencast.example.org` durch die tatsächliche URL
Ihres Opencast-Servers. Es gibt bewusst keinen anderen Mechanismus (keine
`.env`-Datei, kein Laufzeit-Parameter) — Details siehe
[`README.md`, Abschnitt „Server configuration“](../README.md#server-configuration).

Diese Änderung sollte als eigener, dokumentierter lokaler Commit oder
Patch auf Ihrer Deployment-Kopie gepflegt werden, damit sie bei jedem
`git pull` (siehe [Update-Verfahren](#8-update-verfahren)) erneut
angewendet werden kann.

### Bauen

```bash
pnpm build
```

Das Ergebnis liegt danach unter `dist/` — eine
`index.html` plus ein `assets/`-Verzeichnis mit den gebündelten
JS-/CSS-Dateien. Genau dieses `dist/`-Verzeichnis wird auf den Webserver
kopiert.

## 3. Auslieferung mit nginx

```bash
sudo dnf install -y nginx
sudo systemctl enable --now nginx
```

Webroot anlegen und den Build hineinkopieren (Beispiel-Pfad, anpassbar):

```bash
sudo mkdir -p /var/www/opencast-player
sudo rsync -a --delete dist/ /var/www/opencast-player/
```

Server-Block anlegen, z. B. `/etc/nginx/conf.d/opencast-player.conf`:

```nginx
server {
    listen 80;
    server_name player.example.org;

    root /var/www/opencast-player;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

`try_files ... /index.html` ist ein SPA-Fallback: Der Player selbst
verwendet aktuell kein clientseitiges Routing (keine URLs außer `/`), die
Regel schadet aber nicht und macht das Deployment robust, falls künftige
Versionen eigene Routen bekommen.

Konfiguration testen und laden:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 4. HTTPS (WebXR erfordert einen sicheren Kontext)

**WebXR-Sitzungen lassen sich nur in einem sicheren Kontext (HTTPS)
starten.** Ohne gültiges TLS-Zertifikat funktioniert der „VR betreten“-
Knopf im Player nicht (Browser verweigern den WebXR-API-Zugriff über
Klartext-HTTP, `localhost` ausgenommen). Zwei gängige Wege:

### Option A: Zertifikat der Universität / eigene CA

Falls die Universität Osnabrück / virtUOS eigene Zertifikate ausstellt
(z. B. über eine interne CA oder ein zentrales Zertifikatsmanagement),
legen Sie das Zertifikat und den privaten Schlüssel an einem geschützten
Pfad ab (z. B. `/etc/pki/tls/certs/player.example.org.crt` und
`/etc/pki/tls/private/player.example.org.key`, Rechte `600` für den
Schlüssel) und erweitern Sie den Server-Block:

```nginx
server {
    listen 443 ssl;
    server_name player.example.org;

    ssl_certificate     /etc/pki/tls/certs/player.example.org.crt;
    ssl_certificate_key /etc/pki/tls/private/player.example.org.key;

    root /var/www/opencast-player;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}

server {
    listen 80;
    server_name player.example.org;
    return 301 https://$host$request_uri;
}
```

### Option B: Let's Encrypt via certbot

Falls der Host von außen erreichbar ist und Let's Encrypt genutzt werden
darf: `certbot` ist auf Rocky Linux 10 nicht Teil der Standard-Repositories,
sondern kommt aus EPEL. EPEL zuerst aktivieren, dann `certbot`
installieren (steht bei Ihnen bereits ein CRB/PowerTools-Repository
aktiv, ist das ausreichend — falls `dnf install epel-release`
Abhängigkeitsfehler meldet, zusätzlich
`sudo dnf config-manager --set-enabled crb` ausführen):

```bash
sudo dnf install -y epel-release
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d player.example.org
```

`certbot` schreibt die `ssl_certificate`-Zeilen selbst in den
Server-Block und richtet die HTTP→HTTPS-Weiterleitung ein; die
automatische Erneuerung läuft über den vom Paket installierten Systemd-Timer
(`sudo systemctl status certbot-renew.timer`).

Nach jeder Änderung erneut testen und laden:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 5. SELinux

Rocky Linux 10 läuft standardmäßig mit SELinux im `enforcing`-Modus
(prüfbar mit `getenforce`). Liegt der Webroot **nicht** unter dem von
nginx erwarteten Standardkontext (z. B. weil er nicht unter `/var/www/`
liegt oder Dateien per `rsync` von einem anderen Kontext kopiert wurden),
blockiert SELinux das Ausliefern der Dateien.

Wurde der oben verwendete Pfad `/var/www/opencast-player` genutzt, reicht
in der Regel ein einmaliges Neu-Labeln nach dem ersten Kopieren:

```bash
sudo restorecon -Rv /var/www/opencast-player
```

Liegt der Webroot an einem anderen Ort außerhalb des Standard-`httpd`-
Baums, muss der Kontext dauerhaft registriert werden, bevor
`restorecon` ihn anwenden kann:

```bash
sudo semanage fcontext -a -t httpd_sys_content_t "/pfad/zu/opencast-player(/.*)?"
sudo restorecon -Rv /pfad/zu/opencast-player
```

(`semanage` steht ggf. erst nach `sudo dnf install -y policycoreutils-python-utils`
zur Verfügung.)

Prüfen Sie im Fehlerfall (nginx liefert 403, obwohl die Dateirechte
passen) die Audit-Logs:

```bash
sudo ausearch -m avc -ts recent
```

## 6. firewalld

Auf einer Server-Installation von Rocky Linux 10 ist `firewalld`
standardmäßig aktiv; auf einem Minimal- oder Cloud-Image kann es fehlen.
Prüfen und bei Bedarf nachinstallieren:

```bash
rpm -q firewalld || sudo dnf install -y firewalld
sudo systemctl enable --now firewalld
```

Der HTTPS-Dienst muss freigegeben werden (HTTP nur, falls Sie
Klartext-HTTP dauerhaft mitbetreiben wollen — für WebXR reicht und genügt
HTTPS):

```bash
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
sudo firewall-cmd --list-services
```

## 7. CORS auf dem Opencast-Server

Der Player läuft vollständig im Browser und spricht die Search-API des
Opencast-Servers **direkt und anonym** an (siehe
[`README.md`, Abschnitt „Server configuration“](../README.md#server-configuration)).
Damit der Browser diese Cross-Origin-Anfragen zulässt, muss der
Opencast-Server selbst — nicht dieses Deployment — passende
`Access-Control-Allow-Origin`-Header für die Origin des Players
(`https://player.example.org` in den Beispielen oben) auf seiner
Search-API senden.

Das ist eine **Opencast-seitige** Einstellung, keine Einstellung dieses
Repositories oder dieser Installationsanleitung, und ihr genauer Ort
hängt von der Opencast-Version und davon ab, ob eine eigene
CORS-Konfiguration von Opencast oder ein vorgeschalteter Reverse-Proxy
verwendet wird. Ausgangspunkte:

- Die aktuelle Opencast-Administrationsdokumentation zum Stichwort
  „CORS“ (Version des jeweiligen Opencast-Servers beachten).
- Falls Opencast selbst hinter einem Reverse-Proxy (nginx/Apache) läuft,
  der von der Opencast-Administration betrieben wird: Dort lässt sich
  `Access-Control-Allow-Origin` für die Player-Origin ergänzen, ohne
  Opencast selbst anzufassen.

Ohne diese Freigabe schlägt jede Anfrage des Players an den
Opencast-Server im Browser mit einem CORS-Fehler fehl — der Player zeigt
in diesem Fall laut Spezifikation eine lesbare Fehlermeldung mit
Wiederholen-Option an, lädt aber keine Inhalte.

## 8. Update-Verfahren

```bash
cd opencast-xr
git pull
# Ihren lokalen baseUrl-Patch aus Schritt 2 erneut anwenden/rebasen,
# falls er nicht als eigener Commit im Repository verwaltet wird.
pnpm install
pnpm build
sudo rsync -a --delete dist/ /var/www/opencast-player/
sudo restorecon -Rv /var/www/opencast-player
```

Ein Reload von nginx ist für ein reines Auswechseln statischer Dateien
nicht nötig; die neue `index.html` und die neuen `assets/`-Dateien werden
sofort beim nächsten Seitenaufruf ausgeliefert.
