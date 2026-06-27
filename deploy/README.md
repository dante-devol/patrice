# Deploying Patrice

This bundle is everything you need to run Patrice on a server:

| File                      | What it is                                              |
| ------------------------- | ------------------------------------------------------- |
| `docker-compose.prod.yml` | The production stack — pulls pre-built images from GHCR |
| `.env.example`            | The configuration contract; copy to `.env` and fill in  |

**Requirements:** a Linux host with Docker Engine + the Compose plugin, and a
reverse proxy in front to terminate TLS (nginx, Caddy, Cloudflare, a cloud load
balancer — whatever you already run). Postgres ships inside the stack; you do
not need a separate database.

Patrice serves **one organization per deployment**. The stack runs four app
services from two images: `api` (HTTP), `worker` (background jobs + Discord
gateway), `web` (the SPA + an `/api` reverse proxy), and a bundled `db`.

---

## 1. Configure

```bash
mkdir -p /opt/patrice && cd /opt/patrice
# put docker-compose.prod.yml and .env.example here, then:
cp .env.example .env
```

Edit `.env` and fill in every `CHANGE_ME`. At minimum:

- `PATRICE_VERSION` — pin to the release you are deploying (e.g. `1.4.0`).
- `PUBLIC_BASE_URL` — the public **https** URL users will hit.
- `SESSION_SECRET`, `TOKEN_PEPPER` — `openssl rand -base64 48` each.
- `POSTGRES_PASSWORD` — must match the password inside `DATABASE_URL`.
- `SMTP_URL`, `EMAIL_FROM` — a real outbound mail server (invites + email login
  links go through it).

The API validates `.env` on boot and refuses to start with a readable list of
every bad/missing key, so a typo fails fast rather than half-booting.

## 2. Start

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Startup order is automatic: `db` becomes healthy → a one-shot `migrate` service
applies database migrations and exits → `api` and `worker` boot → `web` comes up
on `${WEB_PORT}` (default `8080`).

## 3. Create the first admin

On a fresh database Patrice enters **bootstrap mode** and prints a one-time key:

```bash
docker compose -f docker-compose.prod.yml logs api | grep -i bootstrap
```

Open `PUBLIC_BASE_URL` in a browser, go through setup with that key, and you
become the first admin. The key is ephemeral — it lives only for that process
run and a restart mints a fresh one, so grab it promptly.

---

## TLS: point your proxy at the stack

The stack speaks **plain HTTP on `${WEB_PORT}`** (default `8080`). Terminate TLS
at your edge and forward to it. Example nginx vhost:

```nginx
server {
    listen 443 ssl http2;
    server_name patrice.example.com;

    ssl_certificate     /etc/letsencrypt/live/patrice.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/patrice.example.com/privkey.pem;

    # Must be >= ATTACHMENT_MAX_BYTES (default 25 MiB) or uploads 413.
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;  # https -> secure cookies work
    }
}
```

The matching `.env` settings — already defaulted in `.env.example` — are
`PUBLIC_BASE_URL=https://…`, `TRUST_PROXY=true`, and `COOKIE_SECURE=true`. Without
`X-Forwarded-Proto: https` reaching the app, session cookies (which are
`Secure`) won't be set and login will appear to silently fail.

---

## Upgrades

```bash
# bump PATRICE_VERSION in .env to the new release, then:
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The `migrate` one-shot applies any new migrations before `api`/`worker` rebind,
so upgrades are a pull + up. Roll back by setting `PATRICE_VERSION` to the prior
tag and `up -d` again (note: a release that added a migration may not be safely
downgradable — back up first).

## Backups

Two things hold state: the database and (if `STORAGE_DRIVER=local`) attachment
blobs.

```bash
# Database
docker compose -f docker-compose.prod.yml exec db \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > patrice-$(date +%F).sql

# Local attachment blobs live in the `patrice-storage` volume — snapshot it, or
# avoid the problem entirely by using STORAGE_DRIVER=s3 (also required if you
# ever run more than one instance).
```

## Operating notes

- **Logs:** `docker compose -f docker-compose.prod.yml logs -f api` (or
  `worker` / `web`).
- **Single-instance:** `worker` must stay at one replica (it holds the Discord
  gateway socket and background-job singletons). `api` is stateless, but scaling
  it past one replica requires `STORAGE_DRIVER=s3` (local blobs aren't shared).
- **Database port** is not exposed to the host by default; uncomment the `db`
  `ports:` block in the compose file if you need direct access for backups/admin.
