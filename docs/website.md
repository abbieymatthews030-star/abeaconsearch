# Run Beacon Search as a full website on your domain

Beacon Search is already a website: React UI + API behind Caddy with automatic
HTTPS. This guide turns a VPS (or any Docker host) into `https://your-domain`
**without Vercel** or any other PaaS.

## 1. Get a domain

Buy a name from any registrar you like (Cloudflare, Namecheap, Porkbun, Google
Domains / Squarespace, etc.). Available product-adjacent examples checked at
build time (prices change):

| Domain              | Notes                         |
| ------------------- | ----------------------------- |
| `beaconsearch.dev`  | Short product domain          |
| `beaconsearch.app`  | App-style TLD                 |
| `abeaconsearch.com` | Matches the npm / GitHub name |

You do **not** need to transfer the domain to anyone else. Keep it at your
registrar and point DNS at your server.

## 2. Point DNS at the server

On a VPS with a public IP:

1. Create an `A` record: `@` (and optionally `www`) → your server IPv4.
2. Create an `AAAA` record if you have IPv6.
3. Open inbound TCP **80** and **443** (UDP 443 optional for HTTP/3).

Propagation is usually minutes; it can take longer at some registrars.

## 3. Choose private or public

| Mode                  | Compose                                                                           | Auth            | Use when                        |
| --------------------- | --------------------------------------------------------------------------------- | --------------- | ------------------------------- |
| **Private** (default) | `docker compose up -d --build`                                                    | HTTP basic auth | Personal / team search box      |
| **Public website**    | `docker compose -f docker-compose.yml -f docker-compose.public.yml up -d --build` | None            | Product site on a custom domain |

### Private (password)

```sh
cp deploy/.env.example .env
# set BEACON_DOMAIN, BEACON_USER, BEACON_PASSWORD_HASH
docker compose up -d --build
```

### Public website (no login wall)

```sh
cp deploy/.env.public.example .env
# set BEACON_DOMAIN and BEACON_SITE_URL (https://your-domain)
docker compose -f docker-compose.yml -f docker-compose.public.yml up -d --build
```

The public Caddyfile blocks mutating admin API routes (`/api/documents`,
`/api/crawl`, `/api/settings`, `/api/index/*`, `/api/providers*`) so strangers
cannot empty your index. Search, answers, plate checks, and Tor browse stay
available. Review `deploy/Caddyfile.public` before going live if you need
different rules.

## 4. Site identity

Optional env vars (also set by the public `.env` example):

| Variable           | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `BEACON_DOMAIN`    | Hostname Caddy terminates TLS for                                          |
| `BEACON_SITE_URL`  | Canonical `https://…` origin reported by `/api/health` and shown in the UI |
| `BEACON_SITE_NAME` | Product name (default `Beacon Search`)                                     |

## 5. Update and back up

```sh
git pull
docker compose -f docker-compose.yml -f docker-compose.public.yml up -d --build
docker run --rm -v abeaconsearch_beacon-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/beacon-index-backup.tgz -C /data .
```

## Local preview (no domain yet)

```sh
npm install
npm run build
npm start
# → http://localhost:7700
```

Or `npm run dev` for hot reload (API `:7700`, Vite `:5173`).
