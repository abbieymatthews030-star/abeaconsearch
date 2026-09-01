# Deploying Beacon Search on its own server + domain

Two supported paths:

- **[Render / Railway](#managed-platform-render--railway)** — managed platform, connect the repo, done in minutes.
- **[Your own VPS](#self-hosted-vps--caddy)** — one Linux box, Docker + Caddy, full control.

Placeholder domain throughout: `search.example.com` — swap in your own.

---

## Managed platform (Render / Railway)

The repo ships a Render blueprint at [`render.yaml`](../render.yaml). It builds the
`Dockerfile`, mounts a **persistent disk at `/data`** (so the index survives
deploys), sets a health check on `/api/health`, and **generates a
`BEACON_WRITE_TOKEN`** so the public URL can't be spammed.

1. Push this repo to GitHub (a fork is fine).
2. **Render dashboard → New → Blueprint**, select the repo. Render reads `render.yaml`.
   Pick the `starter` plan (the free tier has no persistent disk).
3. First build + deploy runs automatically; every later push to the default branch redeploys.
4. **Custom domain:** service → **Settings → Custom Domains** → add
   `search.example.com`. Render shows a `CNAME` target — create that record at your
   DNS host. Certificate issuance is automatic once DNS resolves.
5. **Get your write token:** service → **Environment** → reveal `BEACON_WRITE_TOKEN`.
   Paste it into the web UI's _Operator token_ field (Add / Crawl tabs), or send it
   as `Authorization: Bearer <token>` from scripts.

```bash
curl https://search.example.com/api/health
curl -X POST https://search.example.com/api/documents \
  -H "authorization: Bearer $BEACON_WRITE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"Hello","body":"first document","tags":["demo"]}'
curl 'https://search.example.com/api/search?q=hello'
```

**Railway:** no blueprint file needed — create a project from the repo, it detects
the `Dockerfile`. Then add a **Volume** mounted at `/data`, and set the env vars
from `render.yaml` by hand (`BEACON_WRITE_TOKEN` to a long random string,
`PORT=7700`). Add your domain under the service's **Settings → Networking**.

Backups on a managed platform: `GET /api/documents` dumps every document as JSON —
cron that to off-box storage, or snapshot the disk from the provider's dashboard.

---

## Self-hosted VPS + Caddy

This path sets up a **self-sustaining, single-host** deployment:

- Beacon runs in a container, restarts on failure and on reboot.
- **Caddy** terminates TLS and **auto-renews** Let's Encrypt certificates — no cron, no manual steps.
- The index is a single JSON snapshot on a Docker volume, backed up by a one-line cron job.
- Write endpoints are behind HTTP basic auth (Caddy) — and you can also set `BEACON_WRITE_TOKEN`.

Everything lives in [`deploy/`](../deploy).

### 1. Provision a server

Anything with 1 vCPU / 1 GB RAM is plenty (Hetzner CX22, DigitalOcean, Vultr, an
old Pi, …). Use a current Ubuntu LTS or Debian.

```bash
# as root, on a fresh box
adduser deploy && usermod -aG sudo deploy
# install Docker Engine + compose plugin
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy

# automatic OS security patches
apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

# firewall: SSH + HTTP + HTTPS only
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

Log back in as `deploy` for the rest.

---

### 2. Point DNS at it

At your registrar / DNS host, create records for the hostname you'll use:

| Type   | Name                | Value           |
| ------ | ------------------- | --------------- |
| `A`    | `search`            | `<server IPv4>` |
| `AAAA` | `search` (optional) | `<server IPv6>` |

Wait for it to resolve (`dig +short search.example.com`) before the next step —
Caddy needs it reachable to complete the ACME challenge.

---

### 3. Configure

```bash
sudo git clone https://github.com/abbieymatthews030-star/abeaconsearch /opt/abeaconsearch
sudo chown -R deploy:deploy /opt/abeaconsearch
cd /opt/abeaconsearch/deploy

cp beacon.env.example beacon.env
chmod 600 beacon.env

# generate a password hash for write access
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'a-strong-password'
```

Edit `beacon.env`:

```ini
BEACON_DOMAIN=search.example.com
BEACON_ACME_EMAIL=you@example.com
BEACON_AUTH_USER=admin
BEACON_AUTH_HASH=$2a$14$…the hash you just generated…
```

---

### 4. Launch

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f caddy   # watch the cert get issued
```

Visit `https://search.example.com`. Searching, stats and plate lookups are open;
adding/crawling/deleting will prompt for the basic-auth credentials.

Test the API:

```bash
curl https://search.example.com/api/health
curl -u admin:a-strong-password -X POST https://search.example.com/api/documents \
  -H 'content-type: application/json' \
  -d '{"title":"Hello","body":"first document","tags":["demo"]}'
curl 'https://search.example.com/api/search?q=hello'
```

---

### 5. Backups

```bash
sudo crontab -e
# daily 03:30, keep 14 days
30 3 * * *  /opt/abeaconsearch/deploy/backup.sh >> /var/log/beacon-backup.log 2>&1
```

Archives land in `/var/backups/beacon/`. Copy them off-box (`rclone`, `scp`,
object storage) for real durability. Restore instructions are in the header of
[`deploy/backup.sh`](../deploy/backup.sh).

---

### 6. Updates

```bash
cd /opt/abeaconsearch && git pull
docker compose -f deploy/docker-compose.prod.yml up -d --build
docker image prune -f
```

Caddy's own image: `docker compose -f deploy/docker-compose.prod.yml pull caddy && … up -d`.

To automate this, add [Watchtower](https://containrrr.dev/watchtower/) — but
pinning and updating deliberately is the safer default for a single instance.

---

## What's hardened

| Concern                | Mitigation                                                                    |
| ---------------------- | ----------------------------------------------------------------------------- |
| TLS                    | Caddy auto-provisions + auto-renews; HSTS; HTTP→HTTPS redirect                |
| Unauthenticated writes | Basic auth on `POST/PUT/DELETE/PATCH` via Caddy (`@writes` matcher)           |
| Container escape       | `no-new-privileges`, `cap_drop: ALL`, read-only rootfs, `pids_limit`, mem cap |
| SSRF via crawler       | `BEACON_CRAWL_ALLOW_PRIVATE=false` (default) blocks loopback/private targets  |
| Direct app exposure    | Beacon has no host port — only Caddy is published                             |
| Disk fill from logs    | json-file driver capped at 3×10 MB per container                              |
| Host drift             | `unattended-upgrades`, `ufw` default-deny inbound                             |
| Data loss              | Nightly volume tarball + off-box copy                                         |

**Run it fully private** (no public reads either): in [`deploy/Caddyfile`](../deploy/Caddyfile)
replace the `@writes` matcher with

```caddy
@protected not path /api/health
basic_auth @protected {
	{$BEACON_AUTH_USER} {$BEACON_AUTH_HASH}
}
```

---

## Without Docker

Use [`deploy/beacon.service`](../deploy/beacon.service) — a hardened systemd unit
running `node dist/server/index.js` on `127.0.0.1:7700`, with Caddy (native
package) or nginx+certbot in front. Setup steps are in the file's header.
