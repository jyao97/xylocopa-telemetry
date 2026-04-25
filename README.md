# xylocopa-telemetry

Cloudflare Worker that receives anonymous telemetry events from Xylocopa clients and writes them to Cloudflare D1 (SQLite). The Worker's public URL is the only endpoint clients hit — no third-party analytics, no Discord, no secrets baked into the npm package.

```
Xylocopa client  ─▶  POST /v1/event  ─▶  Cloudflare Worker  ─▶  D1 (events table)
                                                │
                                                └── KV (per-install daily rate-limit counter)
```

## Endpoints

- `POST /v1/event` — validate, rate-limit, insert into D1
- `GET /health` — returns `{"ok": true, "worker": "<version>"}`
- `OPTIONS *` — 204 with CORS headers
- Unknown path → 404 `not_found`
- Wrong method → 405 `method_not_allowed`

## Setup

1. **Install deps**

   ```bash
   npm install
   ```

2. **Authenticate** (API token or OAuth — both work; API token is headless-friendly)

   Either:
   ```bash
   npx wrangler login
   ```
   Or set `CLOUDFLARE_API_TOKEN` env var (create a token at https://dash.cloudflare.com/profile/api-tokens with the **Edit Cloudflare Workers** template).

3. **Create KV namespace** (rate-limit store)

   ```bash
   npx wrangler kv namespace create RATE_LIMIT_KV
   ```
   Paste the printed `id = "..."` value into `wrangler.toml` under `[[kv_namespaces]]`.

4. **Create D1 database** (event storage)

   ```bash
   npx wrangler d1 create xylocopa-telemetry
   ```
   Paste the printed `database_id = "..."` value into `wrangler.toml` under `[[d1_databases]]`.

5. **Apply schema**

   ```bash
   npx wrangler d1 execute xylocopa-telemetry --remote --file=schema.sql
   ```

6. **Run tests**

   ```bash
   npm test
   ```

7. **Local dev server**

   ```bash
   npx wrangler dev
   ```

   Smoke test:
   ```bash
   curl -X POST http://localhost:8787/v1/event \
     -H "Content-Type: application/json" \
     -d '{"event":"install_complete","install_id":"550e8400-e29b-41d4-a716-446655440000","version":"0.6.1","platform":"linux","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'
   ```

8. **(Optional) Discord notifications** — real-time new-install pings + a weekly digest (Monday 09:00 UTC):

   ```bash
   npx wrangler secret put DISCORD_WEBHOOK
   ```

   Paste a Discord webhook URL. If unset, the Worker silently no-ops both the inline notification and the cron handler.

9. **Deploy**

   ```bash
   npx wrangler deploy
   ```

   Prints the public URL, e.g. `https://xylocopa-telemetry.<account>.workers.dev`. Hardcode that URL into the Xylocopa client as the default telemetry endpoint.

## Request schema

Strict whitelist — any deviation returns 400 `invalid_payload`:

```json
{
  "event": "install_complete | daily_heartbeat | first_session_created | first_agent_run | day_7_return",
  "install_id": "<uuid v4>",
  "version": "<= 20 chars, [0-9a-z.+-]>",
  "platform": "darwin | linux | win32",
  "timestamp": "<ISO8601, within now-48h .. now+1h>"
}
```

- Exactly these 5 fields, no more, no fewer.
- Body ≤ 1 KB (otherwise 413).
- Rate limit: 20 events per `install_id` per UTC day (otherwise 429).

## Privacy

Non-negotiable rules enforced in `src/index.ts`:

- Never log IP addresses. The Worker does not read `cf-connecting-ip` or any related header.
- Never read `request.cf` (country, ASN, colo). It is not referenced anywhere.
- Never log request bodies on success. On validation failure the Worker logs a short subcode (e.g. `invalid_event_name`) but not the payload.
- `install_id` is a random UUID v4 generated locally on the client — not tied to any account, device fingerprint, IP, or hostname. It is the only identifier stored.

## Error responses

All non-2xx responses are JSON `{"error": "<code>"}`:

| Status | Code                  | When                                              |
| -----: | --------------------- | ------------------------------------------------- |
|    400 | `invalid_payload`     | Any schema validation failure                     |
|    413 | `payload_too_large`   | Body > 1 KB                                       |
|    429 | `rate_limited`        | `install_id` hit 20 events for the current UTC day |
|    500 | `internal`            | D1 insert failed (transient DB error)             |
|    405 | `method_not_allowed`  | Wrong method on a known path                      |
|    404 | `not_found`           | Unknown path                                      |

## Querying the data

Once events are flowing, query D1 directly:

```bash
# Total events by type
npx wrangler d1 execute xylocopa-telemetry --remote --command \
  "SELECT event, COUNT(*) c FROM events GROUP BY event ORDER BY c DESC"

# Daily active installs (via daily_heartbeat)
npx wrangler d1 execute xylocopa-telemetry --remote --command \
  "SELECT date(ts) day, COUNT(DISTINCT install_id) dau
   FROM events WHERE event='daily_heartbeat'
   GROUP BY day ORDER BY day DESC LIMIT 30"

# Activation funnel (installs → first agent run)
npx wrangler d1 execute xylocopa-telemetry --remote --command \
  "SELECT
     (SELECT COUNT(DISTINCT install_id) FROM events WHERE event='install_complete') installs,
     (SELECT COUNT(DISTINCT install_id) FROM events WHERE event='first_session_created') sessions,
     (SELECT COUNT(DISTINCT install_id) FROM events WHERE event='first_agent_run') runs,
     (SELECT COUNT(DISTINCT install_id) FROM events WHERE event='day_7_return') d7_returned"
```

For richer analysis, export to a local SQLite file:

```bash
npx wrangler d1 export xylocopa-telemetry --remote --output=events.sql
sqlite3 events.db < events.sql
```

Then explore with any SQL client, Python/pandas, Grafana, Metabase, etc.
