import { DurableObject } from "cloudflare:workers";
import page from "./page.html";

interface Env {
  NAMESTI: DurableObjectNamespace<Namesti>;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><ellipse cx="30" cy="38" rx="20" ry="13" fill="#9ba3ad"/><path d="M12 36 L2 40 L4 46 L16 42Z" fill="#6b7380"/><path d="M36 34 Q44 20 46 18" stroke="#4f9a7a" stroke-width="12" stroke-linecap="round" fill="none"/><circle cx="46" cy="16" r="9" fill="#6b7380"/><path d="M54 14 L62 17 L54 19Z" fill="#3a3433"/><circle cx="48" cy="14" r="2.6" fill="#e8862a"/><path d="M20 36 Q26 42 22 48 M27 34 Q33 40 29 47" stroke="#2c2f36" stroke-width="2.4" fill="none"/></svg>`;

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);

    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    switch (url.pathname) {
      case "/ws": {
        if (req.headers.get("Upgrade") !== "websocket") {
          return new Response("Čekám WebSocket.", { status: 426 });
        }
        const stub = env.NAMESTI.get(env.NAMESTI.idFromName("namesti"));
        return stub.fetch(req);
      }
      case "/":
        return new Response(page, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=300",
            ...SECURITY_HEADERS,
          },
        });
      case "/favicon.svg":
      case "/favicon.ico":
        return new Response(FAVICON, {
          headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
        });
      case "/robots.txt":
        return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
      default:
        return new Response("Tady žádní holubi nejsou. → https://holuby.cz/", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
    }
  },
} satisfies ExportedHandler<Env>;

/** Each socket gets a small token bucket so nobody can flood the square with crumbs. */
interface Attachment {
  tokens: number;
  last: number;
}

const BUCKET_SIZE = 6;
const REFILL_PER_SEC = 3;
const FLUSH_DELAY_MS = 5000;

/** The one shared square. Holds every visitor's WebSocket and the all-time crumb counter. */
export class Namesti extends DurableObject<Env> {
  private total: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS stats (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    const row = ctx.storage.sql.exec<{ v: number }>("SELECT v FROM stats WHERE k = 'crumbs'").toArray()[0];
    this.total = row ? Number(row.v) : 0;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ tokens: BUCKET_SIZE, last: Date.now() } satisfies Attachment);
    const n = this.ctx.getWebSockets().length;
    server.send(JSON.stringify({ t: "hi", n, total: this.total }));
    this.broadcast({ t: "p", n }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 200) return;
    let msg: { t?: unknown; x?: unknown; y?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t !== "c") return;
    const x = Number(msg.x);
    const y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return;

    const a = (ws.deserializeAttachment() as Attachment | null) ?? { tokens: BUCKET_SIZE, last: Date.now() };
    const now = Date.now();
    a.tokens = Math.min(BUCKET_SIZE, a.tokens + ((now - a.last) / 1000) * REFILL_PER_SEC);
    a.last = now;
    if (a.tokens < 1) {
      ws.serializeAttachment(a);
      return;
    }
    a.tokens -= 1;
    ws.serializeAttachment(a);

    this.total++;
    await this.scheduleFlush();
    const round = (v: number) => Math.round(v * 1e4) / 1e4;
    this.broadcast({ t: "c", x: round(x), y: round(y), total: this.total }, ws);
    ws.send(JSON.stringify({ t: "s", total: this.total }));
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.leave(ws, code);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.leave(ws, 1011);
  }

  /** Counter writes are batched: one row write per few seconds instead of one per crumb. */
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO stats (k, v) VALUES ('crumbs', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      this.total,
    );
  }

  private async scheduleFlush(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_DELAY_MS);
    }
  }

  private leave(ws: WebSocket, code: number): void {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "sbohem");
    } catch {
      // already closed
    }
    const n = this.ctx.getWebSockets().filter((s) => s !== ws).length;
    this.broadcast({ t: "p", n }, ws);
  }

  private broadcast(msg: object, except?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const s of this.ctx.getWebSockets()) {
      if (s === except) continue;
      try {
        s.send(data);
      } catch {
        // socket went away mid-broadcast; its close handler will clean up
      }
    }
  }
}
