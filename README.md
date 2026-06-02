# contentServer

Self-hosted live event photo wall. Guests upload photos via QR code; a moderator approves them; approved photos display on a fullscreen slideshow in real time.

## Quick start (Docker)

```bash
# 1. Copy and edit the config
cp .env.example .env
# Edit .env — at minimum set MOD_PASSWORD and PUBLIC_URL

# 2. Build and run
docker compose up -d

# 3. Open the pages
#   Upload (guests):   http://<your-ip>:3000/
#   Moderator:         http://<your-ip>:3000/mod
#   Display/slideshow: http://<your-ip>:3000/display
```

## Without Docker

Requires Node.js 18+.

```bash
cp .env.example .env
npm install
npm start
```

## Configuration (`.env`)

| Variable           | Default     | Description                                        |
|--------------------|-------------|----------------------------------------------------|
| `PORT`             | `3000`      | HTTP port                                          |
| `MOD_PASSWORD`     | `changeme`  | Moderator dashboard password — **change this**     |
| `SLIDE_INTERVAL`   | `7000`      | Milliseconds between slides                        |
| `MAX_UPLOAD_BYTES` | `10485760`  | Max upload size in bytes (default 10 MB)           |
| `PUBLIC_URL`       | *(auto)*    | Base URL shown in QR code, e.g. `http://192.168.1.50:3000` |

## Pages

| URL        | Description                                                       |
|------------|-------------------------------------------------------------------|
| `/`        | Guest upload page — mobile-friendly, no login required            |
| `/mod`     | Moderator dashboard — password-protected approve/reject queue     |
| `/display` | Fullscreen slideshow — designed for ProPresenter browser source   |

## Data

Photos are stored in `./uploads/` and metadata in `./contentserver.db` (SQLite). Both are volume-mounted in Docker so data persists across restarts.

## ProPresenter / projector setup

Add a **Web** source in ProPresenter pointing to `http://<your-ip>:3000/display`. The page is fullscreen with a black background and updates automatically via WebSocket — no manual refresh needed.

## Rate limiting

Uploads are limited to **5 per IP per minute** to prevent spam.
