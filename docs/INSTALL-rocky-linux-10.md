# Installationsanleitung: Opencast-Player auf Rocky Linux 10

Diese Anleitung richtet sich an Administratorinnen und Administratoren, die
den [`opencast-player`](../README.md) als statische
Website produktiv auf einem Rocky-Linux-10-Server betreiben wollen. Der
Player selbst ist ein reines Client-seitiges Build (HTML/JS/CSS ohne
eigenen Server-Prozess); ausgeliefert wird er über einen gewöhnlichen
Webserver.

Diese Anleitung beschreibt zwei Wege: **Caddy mit automatischem
Let's-Encrypt-Zertifikat** (Abschnitt 3) als empfohlenen Standardweg und
**nginx + certbot** (Abschnitt 4) als Alternative für den Fall, dass
bereits nginx-Infrastruktur oder eine Hausrichtlinie dafür existiert.
**WebXR-Sitzungen lassen sich nur in einem sicheren Kontext (HTTPS)
starten** — egal für welchen der beiden Wege Sie sich entscheiden, muss
am Ende ein gültiges TLS-Zertifikat stehen, sonst funktioniert der „VR
betreten“-Knopf im Player nicht (Browser verweigern den
WebXR-API-Zugriff über Klartext-HTTP, `localhost` ausgenommen).

Alle Befehle sind zum Kopieren gedacht. Ersetzen Sie Platzhalter wie
`opencast.example.org`, `player.example.org` und `admin@example.org`
durch Ihre tatsächlichen Werte — es handelt sich **nicht** um echte,
erreichbare Adressen.

## Inhalt

1. [Voraussetzungen](#1-voraussetzungen)
2. [Build erstellen](#2-build-erstellen)
3. [Auslieferung: Caddy mit automatischem Let's Encrypt (empfohlen)](#3-auslieferung-caddy-mit-automatischem-lets-encrypt-empfohlen)
4. [Alternative: nginx + certbot](#4-alternative-nginx--certbot)
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

## 3. Auslieferung: Caddy mit automatischem Let's Encrypt (empfohlen)

Caddy bezieht und erneuert sein TLS-Zertifikat selbständig über Let's
Encrypt (ACME), sobald es öffentlich erreichbar ist — ohne certbot, ohne
eigenen Renewal-Timer. Voraussetzung dafür sind ein öffentlich
auflösender DNS-Eintrag für `player.example.org`, der auf diesen Server
zeigt, sowie **beide** Ports 80 (für die ACME-HTTP-Challenge und die
automatische HTTP→HTTPS-Weiterleitung) und 443 (für HTTPS selbst) von
außen erreichbar — siehe [firewalld](#6-firewalld). Ist der Host nicht
öffentlich erreichbar (nur internes Netz, kein öffentlicher DNS-Eintrag),
funktioniert automatisches Let's Encrypt nicht; in dem Fall entweder die
Zertifikats-Option in [Abschnitt 4](#4-alternative-nginx--certbot)
verwenden (eigene Zertifikate/Universitäts-CA — dasselbe Vorgehen lässt
sich auch auf Caddy übertragen, indem der Caddyfile-Site-Block statt
automatischem TLS eine `tls <zertifikat> <schlüssel>`-Zeile mit den
eigenen Dateien bekommt) oder gleich die nginx-Alternative verwenden.

### Installation

Caddy liegt nicht in den Rocky-10-Standard-Repositories. Nach den
verfügbaren Installationsanleitungen (siehe Quellen unten) braucht es auf
Rocky Linux 10 sowohl EPEL als auch das offizielle Caddy-COPR-Repository:

```bash
sudo dnf install -y epel-release
sudo dnf copr enable @caddy/caddy
sudo dnf install -y caddy
```

**Nicht auf allen Minimal-Installationen vorhanden:** Meldet `dnf copr
enable` „command not found“, fehlt das COPR-Plugin. Welches Paket das
nachliefert, hängt davon ab, welche `dnf`-Generation auf dem System
läuft — prüfen Sie das zuerst:

```bash
dnf --version
```

Rocky Linux 10 setzt standardmäßig weiterhin auf das klassische DNF 4
(wie RHEL/CentOS Stream 10) — dnf5 lässt sich zwar installieren, ist aber
nicht die Voreinstellung. Je nach ausgegebener Hauptversion:

```bash
# dnf --version beginnt mit "4." (Standardfall auf Rocky Linux 10):
sudo dnf install -y dnf-plugins-core

# dnf --version beginnt mit "5." (dnf5 wurde installiert/aktiviert):
sudo dnf install -y dnf5-plugins
```

Danach den `copr enable`-Befehl von oben erneut ausführen. `dnf copr`
fragt beim ersten Aufruf interaktiv nach Bestätigung des
Repository-GPG-Schlüssels — mit „y“ bestätigen.

**Die EPEL-Aktivierung und das COPR-Repository für Caddy konnte ich
nicht gegen einen echten Rocky-Linux-10-Server verifizieren**, nur gegen
die aktuelle Dokumentation (siehe Quellen); auch die Aussage, dass Rocky
Linux 10 standardmäßig DNF 4 statt dnf5 mitbringt, stammt aus der
Release-Dokumentation, nicht aus einem Test auf einer laufenden
Maschine. Prüfen Sie vor einem Produktiv-Rollout mit `dnf info caddy`,
ob das Paket nach `copr enable` tatsächlich auflösbar ist, und ziehen
Sie im Zweifel die verlinkten Quellen zurate — Caddy-Paketierung für
RHEL-Derivate ändert sich gelegentlich.

```bash
sudo systemctl enable --now caddy
```

### Webroot anlegen und Build kopieren

```bash
sudo mkdir -p /var/www/opencast-xr
sudo rsync -a --delete dist/ /var/www/opencast-xr/
```

### Caddyfile

`/etc/caddy/Caddyfile` (ersetzt den mitgelieferten Default-Inhalt):

```caddyfile
{
    email admin@example.org
}

player.example.org {
    root * /var/www/opencast-xr
    encode gzip
    try_files {path} /index.html
    file_server
}
```

- Der globale Block `{ email admin@example.org }` am Dateianfang setzt
  die Kontaktadresse, die Let's Encrypt für Ablauf-/Problemhinweise zur
  ausgestellten Zertifikatskette nutzt. Ersetzen Sie sie durch eine
  tatsächlich gelesene Adresse.
- `root * /var/www/opencast-xr` setzt das Wurzelverzeichnis für den
  Site-Block.
- `encode gzip` aktiviert Gzip-Kompression für die ausgelieferten Dateien.
- `try_files {path} /index.html` ist der SPA-Fallback: Existiert der
  angefragte Pfad nicht als Datei, liefert Caddy stattdessen
  `index.html` aus. Der Player verwendet aktuell kein clientseitiges
  Routing (keine URLs außer `/`), die Regel schadet aber nicht und macht
  das Deployment robust, falls künftige Versionen eigene Routen bekommen.
- `file_server` aktiviert die eigentliche Dateiauslieferung.
- Die Reihenfolge der Zeilen im Site-Block spielt für Caddy selbst keine
  Rolle: Caddy sortiert Direktiven beim Laden intern nach einer festen
  Priorität, unabhängig davon, wie sie im Caddyfile notiert sind. Die
  Reihenfolge oben folgt nur der Lesbarkeit.

Allein durch das Vorhandensein von `player.example.org` als Site-Adresse
(ohne `http://`-Präfix) aktiviert Caddy automatisches HTTPS: Es besorgt
sich beim ersten Start ein Let's-Encrypt-Zertifikat für genau diesen
Namen, leitet Anfragen auf Port 80 automatisch auf HTTPS um, und erneuert
das Zertifikat selbständig im Hintergrund, lange bevor es abläuft — ohne
weiteres Zutun, ohne certbot, ohne eigenen systemd-Timer.

Konfiguration übernehmen:

```bash
sudo systemctl reload caddy
```

(`reload` setzt voraus, dass die installierte Caddy-systemd-Unit
`ExecReload=/usr/bin/caddy reload …` definiert, wie es die
offiziellen Caddy-Pakete tun; prüfen Sie das im Zweifel mit
`systemctl cat caddy`. Andernfalls tut es auch
`sudo systemctl restart caddy`, nur mit einer kurzen Unterbrechung.)

**Quellen für diesen Abschnitt** (Stand: Recherche zu dieser Anleitung;
Paketierung und Repository-Struktur für Caddy auf RHEL-Derivaten können
sich ändern — im Zweifel dort nachschlagen statt dieser Anleitung
blind zu vertrauen):

- [docs.rockylinux.org – Caddy Web Server](https://docs.rockylinux.org/10/guides/web/caddy/)
- [Caddy-Dokumentation – Installation](https://caddyserver.com/docs/install)
- [Caddy-COPR-Repository](https://copr.fedorainfracloud.org/coprs/g/caddy/caddy/)
- [Caddy-Dokumentation – `try_files`-Direktive](https://caddyserver.com/docs/caddyfile/directives/try_files)

## 4. Alternative: nginx + certbot

Wählen Sie diesen Weg statt Caddy, wenn bereits nginx-Infrastruktur
(Konfigurationsmanagement, Monitoring, Betriebswissen) existiert oder
eine Hausrichtlinie nginx vorschreibt. Funktional unterscheidet sich das
Ergebnis nicht vom Caddy-Weg — nur der Betriebsaufwand (eigener
certbot-Timer statt eingebauter Erneuerung).

### Installation und Webroot

```bash
sudo dnf install -y nginx
sudo systemctl enable --now nginx
```

```bash
sudo mkdir -p /var/www/opencast-xr
sudo rsync -a --delete dist/ /var/www/opencast-xr/
```

Server-Block anlegen, z. B. `/etc/nginx/conf.d/opencast-player.conf`:

```nginx
server {
    listen 80;
    server_name player.example.org;

    root /var/www/opencast-xr;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

`try_files $uri $uri/ /index.html;` ist derselbe SPA-Fallback wie beim
Caddy-Weg. Konfiguration testen und laden:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### TLS: eigene Zertifikate oder certbot

**Option A — Zertifikat der Universität / eigene CA.** Falls die
Universität Osnabrück / virtUOS eigene Zertifikate ausstellt (z. B. über
eine interne CA oder ein zentrales Zertifikatsmanagement), legen Sie das
Zertifikat und den privaten Schlüssel an einem geschützten Pfad ab (z. B.
`/etc/pki/tls/certs/player.example.org.crt` und
`/etc/pki/tls/private/player.example.org.key`, Rechte `600` für den
Schlüssel) und erweitern Sie den Server-Block:

```nginx
server {
    listen 443 ssl;
    server_name player.example.org;

    ssl_certificate     /etc/pki/tls/certs/player.example.org.crt;
    ssl_certificate_key /etc/pki/tls/private/player.example.org.key;

    root /var/www/opencast-xr;
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

**Option B — Let's Encrypt via certbot.** Falls der Host von außen
erreichbar ist und Let's Encrypt genutzt werden darf: `certbot` ist auf
Rocky Linux 10 nicht Teil der Standard-Repositories, sondern kommt aus
EPEL. EPEL zuerst aktivieren, dann `certbot` installieren (steht bei
Ihnen bereits ein CRB/PowerTools-Repository aktiv, ist das ausreichend —
falls `dnf install epel-release` Abhängigkeitsfehler meldet, zusätzlich
`sudo dnf config-manager --set-enabled crb` ausführen):

```bash
sudo dnf install -y epel-release
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d player.example.org
```

`certbot` schreibt die `ssl_certificate`-Zeilen selbst in den
Server-Block und richtet die HTTP→HTTPS-Weiterleitung ein; die
automatische Erneuerung läuft über den vom Paket installierten Systemd-Timer
(`sudo systemctl status certbot-renew.timer`) — anders als bei Caddy ist
das ein zusätzlicher, separat zu überwachender Baustein.

Nach jeder Änderung erneut testen und laden:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 5. SELinux

Rocky Linux 10 läuft standardmäßig mit SELinux im `enforcing`-Modus
(prüfbar mit `getenforce`). Liegt der Webroot **nicht** unter dem vom
jeweiligen Webserver erwarteten Standardkontext (z. B. weil er nicht
unter `/var/www/` liegt oder Dateien per `rsync` von einem anderen
Kontext kopiert wurden), kann SELinux das Ausliefern der Dateien
blockieren.

Wurde der oben verwendete Pfad `/var/www/opencast-xr` genutzt, reicht
in der Regel ein einmaliges Neu-Labeln nach dem ersten Kopieren:

```bash
sudo restorecon -Rv /var/www/opencast-xr
```

Liegt der Webroot an einem anderen Ort außerhalb des Standard-`httpd`-
Baums, muss der Kontext dauerhaft registriert werden, bevor
`restorecon` ihn anwenden kann:

```bash
sudo semanage fcontext -a -t httpd_sys_content_t "/pfad/zu/opencast-xr(/.*)?"
sudo restorecon -Rv /pfad/zu/opencast-xr
```

(`semanage` steht ggf. erst nach `sudo dnf install -y policycoreutils-python-utils`
zur Verfügung.)

**Für nginx** ist das die vollständige Geschichte: nginx läuft auf
RHEL-Derivaten als konfinierter Dienst und liest Webinhalte nur, wenn sie
mit `httpd_sys_content_t` (oder einem verwandten Typ) beschriftet sind.

**Für Caddy konnte ich nicht verifizieren**, ob das COPR-Paket eine
eigene SELinux-Policy mitbringt und den Caddy-Prozess in eine konfinierte
Domäne setzt, oder ob er unconfined läuft (dazu fand sich in der
Caddy-/COPR-Dokumentation keine belastbare Aussage). Prüfen Sie das auf
Ihrem System mit `ps -eZ | grep caddy`, nachdem der Dienst läuft:

- Läuft Caddy in einer eigenen konfinierten Domäne, gilt dasselbe wie
  für nginx — der Webroot muss passend beschriftet sein, und die
  `restorecon`/`semanage`-Befehle oben greifen.
- Läuft Caddy `unconfined_service_t` (unconfined), hat die Beschriftung
  faktisch keine Wirkung, solange das so bleibt — sie schadet aber nicht
  und macht das Deployment robust, falls eine spätere Paketversion Caddy
  doch konfiniert. Deshalb wird sie hier für beide Wege gleichermaßen
  empfohlen.

Prüfen Sie im Fehlerfall (Webserver liefert 403, obwohl die Dateirechte
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

Beide Dienste — **http und https** — müssen freigegeben werden, nicht
nur https: Port 80 wird für die Let's-Encrypt-HTTP-Challenge gebraucht
(sowohl bei Caddys eingebautem ACME-Client als auch bei certbot) und für
die automatische HTTP→HTTPS-Weiterleitung, die beide Webserver-Wege
einrichten:

```bash
sudo firewall-cmd --permanent --add-service=http
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
- Falls Opencast selbst hinter einem Reverse-Proxy läuft, der von der
  Opencast-Administration betrieben wird: Dort lässt sich
  `Access-Control-Allow-Origin` für die Player-Origin ergänzen, ohne
  Opencast selbst anzufassen.

Ohne diese Freigabe schlägt jede Anfrage des Players an den
Opencast-Server im Browser mit einem CORS-Fehler fehl — der Player zeigt
in diesem Fall laut Spezifikation eine lesbare Fehlermeldung mit
Wiederholen-Option an, lädt aber keine Inhalte.

## 8. Update-Verfahren

Am einfachsten über das mitgelieferte Skript, das alle folgenden Schritte
in der richtigen Reihenfolge ausführt (inklusive Einsetzen der
Opencast-URL vor dem Build und Zurücknehmen danach). Beim ersten Aufruf
legt es eine `.update-config` an, in die `OPENCAST_URL` und `WEBROOT`
eingetragen werden; danach genügt:

```bash
./scripts/update.sh
```

Von Hand entsprechen die Schritte:

```bash
cd opencast-xr
git pull
# Ihren lokalen baseUrl-Patch aus Schritt 2 erneut anwenden/rebasen,
# falls er nicht als eigener Commit im Repository verwaltet wird.
pnpm install
pnpm build
sudo rsync -a --delete dist/ /var/www/opencast-xr/
sudo restorecon -Rv /var/www/opencast-xr
```

Ein Reload des Webservers ist für ein reines Auswechseln statischer
Dateien nicht nötig; die neue `index.html` und die neuen
`assets/`-Dateien werden sofort beim nächsten Seitenaufruf ausgeliefert.
Nur wenn Sie die Caddyfile oder den nginx-Server-Block selbst geändert
haben, muss der jeweilige Dienst neu geladen werden:

```bash
sudo systemctl reload caddy    # Caddy-Weg
# oder
sudo systemctl reload nginx    # nginx-Weg
```
