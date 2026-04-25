/**
 * Xylocopa Telemetry Worker
 *
 * Receives JSON telemetry events from Xylocopa clients, validates + rate-limits,
 * then writes to D1. Clients never need Discord webhook URLs or any third-party
 * credentials — the Worker's public endpoint is the only thing they hit.
 *
 * Privacy hard rules (do NOT relax these):
 *   - Never log IPs (don't read cf-connecting-ip)
 *   - Never touch request.cf (country, ASN, geo)
 *   - Never log request bodies on success
 *   - install_id is the only persisted client identifier, and it is a random
 *     UUID generated locally — not tied to any account, device, IP, or hostname
 */

const WORKER_VERSION = "0.1.0";

export interface Env {
  RATE_LIMIT_KV: KVNamespace;
  DB: D1Database;
  // Optional — when set, the Worker posts a Discord message on first-ever
  // event from a new install_id, and a weekly digest on the cron trigger.
  DISCORD_WEBHOOK?: string;
}

const ALLOWED_EVENTS = new Set([
  "install_complete",
  "daily_heartbeat",
  "first_session_created",
  "first_agent_run",
  "day_7_return",
]);

const ALLOWED_PLATFORMS = new Set(["darwin", "linux", "win32"]);

const ALLOWED_FIELDS = ["event", "install_id", "version", "platform", "timestamp"] as const;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION_RE = /^[0-9a-z.+-]+$/;

const MAX_BODY_BYTES = 1024;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_TTL_SECONDS = 48 * 60 * 60;
const SKEW_PAST_MS = 48 * 60 * 60 * 1000;
const SKEW_FUTURE_MS = 1 * 60 * 60 * 1000;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(code: string, status: number, subcode?: string): Response {
  if (subcode) {
    console.warn(`reject status=${status} code=${code} sub=${subcode}`);
  }
  return jsonResponse({ error: code }, status);
}

interface TelemetryEvent {
  event: string;
  install_id: string;
  version: string;
  platform: string;
  timestamp: string;
}

function validatePayload(body: unknown): { ok: true; event: TelemetryEvent } | { ok: false; subcode: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, subcode: "not_object" };
  }
  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== ALLOWED_FIELDS.length) {
    return { ok: false, subcode: "wrong_field_count" };
  }
  for (const k of ALLOWED_FIELDS) {
    if (!(k in obj)) {
      return { ok: false, subcode: `missing_${k}` };
    }
  }
  for (const k of keys) {
    if (!(ALLOWED_FIELDS as readonly string[]).includes(k)) {
      return { ok: false, subcode: "extra_field" };
    }
  }
  const { event, install_id, version, platform, timestamp } = obj;
  if (typeof event !== "string" || !ALLOWED_EVENTS.has(event)) {
    return { ok: false, subcode: "invalid_event_name" };
  }
  if (typeof install_id !== "string" || !UUID_V4_RE.test(install_id)) {
    return { ok: false, subcode: "invalid_install_id" };
  }
  if (typeof version !== "string" || version.length === 0 || version.length > 20 || !VERSION_RE.test(version)) {
    return { ok: false, subcode: "invalid_version" };
  }
  if (typeof platform !== "string" || !ALLOWED_PLATFORMS.has(platform)) {
    return { ok: false, subcode: "invalid_platform" };
  }
  if (typeof timestamp !== "string") {
    return { ok: false, subcode: "invalid_timestamp_type" };
  }
  const tsMs = Date.parse(timestamp);
  if (Number.isNaN(tsMs)) {
    return { ok: false, subcode: "invalid_timestamp_parse" };
  }
  const now = Date.now();
  if (tsMs < now - SKEW_PAST_MS) {
    return { ok: false, subcode: "timestamp_too_old" };
  }
  if (tsMs > now + SKEW_FUTURE_MS) {
    return { ok: false, subcode: "timestamp_too_new" };
  }
  return {
    ok: true,
    event: { event, install_id, version, platform, timestamp },
  };
}

function utcDateKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function checkAndIncrementRateLimit(kv: KVNamespace, installId: string): Promise<boolean> {
  const key = `rl:${installId}:${utcDateKey()}`;
  const cur = await kv.get(key);
  const count = cur ? parseInt(cur, 10) : 0;
  if (count >= RATE_LIMIT_MAX) {
    return false;
  }
  await kv.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_TTL_SECONDS });
  return true;
}

async function insertEvent(db: D1Database, evt: TelemetryEvent): Promise<void> {
  await db
    .prepare(
      "INSERT INTO events (event, install_id, version, platform, ts) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(evt.event, evt.install_id, evt.version, evt.platform, evt.timestamp)
    .run();
}

async function isFirstEvent(db: D1Database, installId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT COUNT(*) AS c FROM events WHERE install_id = ?")
    .bind(installId)
    .first<{ c: number }>();
  return (row?.c ?? 0) === 0;
}

async function postDiscord(webhookUrl: string, content: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `Xylocopa-Telemetry-Worker/${WORKER_VERSION}`,
      },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.warn(`discord_non_2xx status=${resp.status}`);
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    console.warn(`discord_fetch_error type=${name}`);
  } finally {
    clearTimeout(timer);
  }
}

function newInstallMessage(evt: TelemetryEvent): string {
  const shortId = evt.install_id.slice(0, 8);
  return `🆕 New install: \`${shortId}\` · ${evt.platform} · v${evt.version}`;
}

interface WeeklyStats {
  new_this_week: number;
  active_this_week: number;
  all_time: number;
  platforms: Array<{ platform: string; count: number }>;
}

async function computeWeeklyStats(db: D1Database): Promise<WeeklyStats> {
  const newThisWeek = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT install_id, MIN(received_at) AS first_seen
         FROM events GROUP BY install_id
         HAVING datetime(first_seen) >= datetime('now','-7 days')
       )`
    )
    .first<{ c: number }>();

  const active = await db
    .prepare(
      `SELECT COUNT(DISTINCT install_id) AS c FROM events
       WHERE datetime(received_at) >= datetime('now','-7 days')`
    )
    .first<{ c: number }>();

  const all = await db
    .prepare("SELECT COUNT(DISTINCT install_id) AS c FROM events")
    .first<{ c: number }>();

  const platforms = await db
    .prepare(
      `SELECT platform, COUNT(DISTINCT install_id) AS c FROM events
       WHERE datetime(received_at) >= datetime('now','-7 days')
       GROUP BY platform ORDER BY c DESC`
    )
    .all<{ platform: string; c: number }>();

  return {
    new_this_week: newThisWeek?.c ?? 0,
    active_this_week: active?.c ?? 0,
    all_time: all?.c ?? 0,
    platforms: (platforms.results ?? []).map((r) => ({ platform: r.platform, count: r.c })),
  };
}

function formatWeeklyDigest(stats: WeeklyStats): string {
  const date = new Date().toISOString().slice(0, 10);
  const platLine =
    stats.platforms.length > 0
      ? stats.platforms.map((p) => `${p.platform} ${p.count}`).join(", ")
      : "—";
  return [
    `📊 **Xylocopa Weekly** · ${date}`,
    `• New this week: **${stats.new_this_week}**`,
    `• Active this week: **${stats.active_this_week}**`,
    `• All-time unique installs: **${stats.all_time}**`,
    `• Platforms (active): ${platLine}`,
  ].join("\n");
}

async function handleEvent(request: Request, env: Env): Promise<Response> {
  const cl = request.headers.get("content-length");
  if (cl !== null) {
    const n = parseInt(cl, 10);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return errorResponse("payload_too_large", 413, "content_length");
    }
  }
  let raw: string;
  try {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      return errorResponse("payload_too_large", 413, "body_bytes");
    }
    raw = new TextDecoder("utf-8").decode(buf);
  } catch {
    return errorResponse("invalid_payload", 400, "body_read_failed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse("invalid_payload", 400, "json_parse");
  }

  const result = validatePayload(parsed);
  if (!result.ok) {
    return errorResponse("invalid_payload", 400, result.subcode);
  }
  const evt = result.event;

  const allowed = await checkAndIncrementRateLimit(env.RATE_LIMIT_KV, evt.install_id);
  if (!allowed) {
    return errorResponse("rate_limited", 429);
  }

  let firstEver = false;
  try {
    if (env.DISCORD_WEBHOOK) {
      firstEver = await isFirstEvent(env.DB, evt.install_id);
    }
    await insertEvent(env.DB, evt);
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    console.warn(`d1_insert_error type=${name}`);
    return errorResponse("internal", 500, "d1_insert");
  }

  // Fire-and-forget new-install notification. Not awaited — must not block the
  // response or leak Discord errors to the client.
  if (firstEver && env.DISCORD_WEBHOOK) {
    const msg = newInstallMessage(evt);
    const url = env.DISCORD_WEBHOOK;
    // Use waitUntil via ExecutionContext if available; otherwise just drop.
    // CF runtime ignores rejected/slow promises once the response is sent.
    postDiscord(url, msg).catch(() => {});
  }

  return jsonResponse({ ok: true }, 200);
}

const handler: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === "/health") {
      if (method !== "GET") {
        return errorResponse("method_not_allowed", 405);
      }
      return jsonResponse({ ok: true, worker: WORKER_VERSION }, 200);
    }

    if (path === "/v1/event") {
      if (method !== "POST") {
        return errorResponse("method_not_allowed", 405);
      }
      return handleEvent(request, env);
    }

    return errorResponse("not_found", 404);
  },

  // Weekly digest — triggered by cron in wrangler.toml.
  async scheduled(_event, env, ctx): Promise<void> {
    if (!env.DISCORD_WEBHOOK) {
      console.warn("scheduled: DISCORD_WEBHOOK not configured; skipping");
      return;
    }
    ctx.waitUntil(
      (async () => {
        try {
          const stats = await computeWeeklyStats(env.DB);
          const msg = formatWeeklyDigest(stats);
          await postDiscord(env.DISCORD_WEBHOOK!, msg);
        } catch (err) {
          const name = err instanceof Error ? err.name : "unknown";
          console.warn(`scheduled_error type=${name}`);
        }
      })()
    );
  },
};

export default handler;
