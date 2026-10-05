import type { ApiError } from "@opennas/shared";
import { tr } from "../i18n/index.ts";

/**
 * Base URL of the backend API. Defaults to the same origin (`/api`), so the
 * reverse-proxy topology needs zero config. Set `VITE_OPENNAS_API_BASE` at build
 * time (e.g. `https://nas.example.com/api`) to point this static frontend at a
 * backend on a different origin.
 */
const API_BASE = (import.meta.env.VITE_OPENNAS_API_BASE ?? "/api").replace(/\/+$/, "");

/** Build a full URL for an API path (which must start with "/"). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** Origin that serves non-/api content (app-content, the SDK). "" = same origin. */
const ORIGIN_BASE = API_BASE.replace(/\/api$/, "");

/** URL for an installed app's content, e.g. appContentUrl("todo", "index.html"). */
export function appContentUrl(appId: string, path = ""): string {
  return `${ORIGIN_BASE}/app-content/${appId}/${path.replace(/^\/+/, "")}`;
}

/** Build the WebSocket URL for an API path, honoring the configured API base. */
export function apiWsUrl(path: string): string {
  const httpUrl = API_BASE.startsWith("http")
    ? `${API_BASE}${path}`
    : `${location.origin}${API_BASE}${path}`;
  return httpUrl.replace(/^http/, "ws"); // http->ws, https->wss
}

/** Thrown for any non-2xx API response; carries the server's structured error. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;

  constructor(status: number, body: ApiError) {
    super(body.message || body.error || tr("ui.api.requestFailed", { status }));
    this.name = "ApiRequestError";
    this.status = status;
    this.code = body.error;
    this.fields = body.fields;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  // Not every response is ours: a reverse proxy's 502 page or a captive portal
  // answers in HTML, and a SyntaxError from JSON.parse would hide the status.
  let data: unknown;
  let parsed = true;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = false;
  }

  if (!res.ok) {
    const err: ApiError =
      data && typeof data === "object" && "error" in data
        ? (data as ApiError)
        : {
            error: "http_error",
            message: res.status >= 502 && res.status <= 504
              ? tr("ui.api.unreachable", { status: res.status })
              : tr("ui.api.requestFailed", { status: res.status }),
          };
    throw new ApiRequestError(res.status, err);
  }
  if (!parsed) {
    throw new ApiRequestError(res.status, {
      error: "bad_response",
      message: tr("ui.api.badResponse", { status: res.status }),
    });
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};
