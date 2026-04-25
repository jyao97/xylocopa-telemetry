/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "./index";

interface Env {
  RATE_LIMIT_KV: KVNamespace;
  DB: D1Database;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    install_id TEXT NOT NULL,
    version TEXT NOT NULL,
    platform TEXT NOT NULL,
    ts TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_event_ts ON events(event, ts);
  CREATE INDEX IF NOT EXISTS idx_events_install ON events(install_id);
`;

function makeRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://example.com${path}`, init);
}

function isoNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "install_complete",
    install_id: "550e8400-e29b-41d4-a716-446655440000",
    version: "0.6.1",
    platform: "linux",
    timestamp: isoNow(),
    ...overrides,
  };
}

async function dispatch(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const resp = await worker.fetch!(
    req as unknown as Parameters<NonNullable<typeof worker.fetch>>[0],
    env as unknown as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return resp;
}

async function rowCount(e: Env): Promise<number> {
  const r = await e.DB.prepare("SELECT COUNT(*) AS c FROM events").first<{ c: number }>();
  return r?.c ?? 0;
}

beforeAll(async () => {
  // Miniflare gives us an empty D1 per test run; apply schema once.
  const e = env as unknown as Env;
  for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await e.DB.prepare(stmt).run();
  }
});

beforeEach(async () => {
  const e = env as unknown as Env;
  await e.DB.prepare("DELETE FROM events").run();
  const list = await e.RATE_LIMIT_KV.list();
  for (const k of list.keys) {
    await e.RATE_LIMIT_KV.delete(k.name);
  }
});

describe("GET /health", () => {
  it("returns 200 ok with worker version", async () => {
    const resp = await dispatch(makeRequest("/health"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; worker: string };
    expect(body.ok).toBe(true);
    expect(typeof body.worker).toBe("string");
  });
});

describe("POST /v1/event", () => {
  it("accepts valid payload and writes a D1 row", async () => {
    const resp = await dispatch(
      makeRequest("/v1/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validPayload()),
      }),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    expect(await rowCount(env as unknown as Env)).toBe(1);

    const row = await (env as unknown as Env).DB.prepare(
      "SELECT event, install_id, version, platform FROM events LIMIT 1",
    ).first<{ event: string; install_id: string; version: string; platform: string }>();
    expect(row?.event).toBe("install_complete");
    expect(row?.install_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(row?.version).toBe("0.6.1");
    expect(row?.platform).toBe("linux");
  });

  it("rejects missing field with 400 and writes no row", async () => {
    const p = validPayload();
    delete (p as Record<string, unknown>).version;
    const resp = await dispatch(
      makeRequest("/v1/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      }),
    );
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: "invalid_payload" });
    expect(await rowCount(env as unknown as Env)).toBe(0);
  });

  it("rejects extra field with 400", async () => {
    const p = validPayload({ extra: "nope" });
    const resp = await dispatch(
      makeRequest("/v1/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      }),
    );
    expect(resp.status).toBe(400);
    expect(await rowCount(env as unknown as Env)).toBe(0);
  });

  it("rejects bad event name with 400", async () => {
    const p = validPayload({ event: "not_a_real_event" });
    const resp = await dispatch(
      makeRequest("/v1/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      }),
    );
    expect(resp.status).toBe(400);
  });

  it("rejects bad UUID with 400", async () => {
    const p = validPayload({ install_id: "not-a-uuid" });
    const resp = await dispatch(
      makeRequest("/v1/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      }),
    );
    expect(resp.status).toBe(400);
  });

  it("rejects timestamp 72h in past with 400", async () => {
    const p = validPayload({ timestamp: isoNow(-72 * 60 * 60 * 1000) });
    const resp = await dispatch(
      makeRequest("/v1/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      }),
    );
    expect(resp.status).toBe(400);
  });

  it("rejects body > 1KB with 413", async () => {
    const bigVersion = "1." + "a".repeat(2000);
    const p = validPayload({ version: bigVersion });
    const body = JSON.stringify(p);
    expect(body.length).toBeGreaterThan(1024);
    const resp = await dispatch(
      makeRequest("/v1/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
    );
    expect(resp.status).toBe(413);
    expect(await resp.json()).toEqual({ error: "payload_too_large" });
  });

  it("returns 429 on 21st request from same install_id same day", async () => {
    const p = validPayload();
    for (let i = 0; i < 20; i++) {
      const resp = await dispatch(
        makeRequest("/v1/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(p),
        }),
      );
      expect(resp.status).toBe(200);
    }
    const resp = await dispatch(
      makeRequest("/v1/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      }),
    );
    expect(resp.status).toBe(429);
    expect(await resp.json()).toEqual({ error: "rate_limited" });
    // 20 accepted rows, the 21st rejected before D1
    expect(await rowCount(env as unknown as Env)).toBe(20);
  });
});

describe("OPTIONS /v1/event", () => {
  it("returns 204 with CORS headers", async () => {
    const resp = await dispatch(makeRequest("/v1/event", { method: "OPTIONS" }));
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(resp.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(resp.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });
});

describe("Unknown routes", () => {
  it("GET /other returns 404", async () => {
    const resp = await dispatch(makeRequest("/other"));
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ error: "not_found" });
  });

  it("DELETE /v1/event returns 405", async () => {
    const resp = await dispatch(makeRequest("/v1/event", { method: "DELETE" }));
    expect(resp.status).toBe(405);
    expect(await resp.json()).toEqual({ error: "method_not_allowed" });
  });
});
