// Calls to the engine. In production the engine writes the per-launch token
// into index.html; in development Vite's proxy adds it, so none is needed here.
// The landing page's demo has no engine; demo.ts answers from a recording.
import { DEMO, DemoError, demoCall } from "./demo.ts";

const token = document.querySelector<HTMLMetaElement>('meta[name="acp-token"]')?.content ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (DEMO) {
    try {
      return (await demoCall(method, path, body)) as T;
    } catch (e) {
      throw new ApiError((e as Error).message, e instanceof DemoError ? e.status : 500, "demo");
    }
  }
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-acp-token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(data.error ?? `The engine answered ${res.status}.`, res.status, data.code);
  return data as T;
}

export function qs(params: Record<string, string | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : "";
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body: unknown) => call<T>("POST", path, body),
};

export function events(onChange: (paths: string[]) => void): () => void {
  if (DEMO) return () => {};
  let es: EventSource | null = null;
  let closed = false;
  let retry = 1000;
  const open = () => {
    es = new EventSource(`/api/events${token ? `?token=${token}` : ""}`);
    es.onmessage = (e) => {
      retry = 1000;
      try {
        onChange((JSON.parse(e.data) as { paths: string[] }).paths);
      } catch {
        /* a malformed event; ignore it */
      }
    };
    es.onerror = () => {
      es?.close();
      if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 15000)));
    };
  };
  open();
  return () => {
    closed = true;
    es?.close();
  };
}
