import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";

import { subscribe } from "./lib/watch.ts";
import { WriteError } from "./lib/write.ts";

/**
 * A plain HTTP server bound to the loopback interface. Every API call must
 * carry the per-launch token (a header, or a query parameter for the event
 * stream, which cannot set headers), and the Host header must name this
 * machine, so another web page cannot drive the engine through the browser.
 */

export type Ctx = {
  url: URL;
  method: string;
  body: unknown;
};

export type Handler = (ctx: Ctx) => Promise<unknown>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".map": "application/json",
};

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024 * 1024) throw new HttpError(413, "The request is too large.");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
}

export function createServer(opts: {
  port: number;
  token: string;
  routes: Record<string, Handler>;
  staticDir: string | null;
}): http.Server {
  // Port 0 means "any free port" (the desktop app); the Host check uses the one actually bound.
  const hosts = (port: number) => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  let allowedHosts = hosts(opts.port);

  const server = http.createServer(async (req, res) => {
    const bound = (server.address() as { port: number } | null)?.port ?? opts.port;
    if (bound !== opts.port && !allowedHosts.has(`127.0.0.1:${bound}`)) allowedHosts = hosts(bound);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${bound}`);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
      res.end(JSON.stringify(body));
    };

    const host = req.headers.host ?? "";
    // The dev proxy forwards with its own Host; the token still guards it.
    if (!allowedHosts.has(host) && !process.env.ACP_DEV) {
      send(421, { error: "Unknown host." });
      return;
    }

    if (url.pathname === "/api/health") {
      send(200, { ok: true });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const given = String(req.headers["x-acp-token"] ?? url.searchParams.get("token") ?? "");
      if (!sameToken(given, opts.token)) {
        send(401, { error: "Missing or wrong token." });
        return;
      }

      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": connected\n\n");
        const off = subscribe((paths) => res.write(`data: ${JSON.stringify({ paths })}\n\n`));
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          off();
          clearInterval(ping);
        });
        return;
      }

      const key = `${req.method} ${url.pathname}`;
      const handler = opts.routes[key];
      if (!handler) {
        send(404, { error: `No route for ${key}.` });
        return;
      }
      try {
        const body = req.method === "POST" ? await readBody(req) : null;
        send(200, await handler({ url, method: req.method ?? "GET", body }));
      } catch (e) {
        if (e instanceof WriteError) send(e.status, { error: e.message, code: e.code });
        else if (e instanceof HttpError) send(e.status, { error: e.message });
        else {
          console.error(e);
          send(500, { error: (e as Error).message || "Something went wrong in the engine." });
        }
      }
      return;
    }

    if (!opts.staticDir) {
      send(404, { error: "The UI is served by Vite in development." });
      return;
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    let file = path.join(opts.staticDir, rel || "index.html");
    if (!file.startsWith(opts.staticDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(opts.staticDir, "index.html");
    }
    let body = fs.readFileSync(file);
    if (file.endsWith("index.html")) {
      body = Buffer.from(body.toString("utf8").replace("</head>", `<meta name="acp-token" content="${opts.token}"></head>`));
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-store",
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    });
    res.end(body);
  });
  return server;
}
