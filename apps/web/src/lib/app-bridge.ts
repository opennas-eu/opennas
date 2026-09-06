import type {
  AppFetchResponse,
  AppFileEntry,
  AppManifest,
  AppPermission,
  AppShareGrantsResponse,
  AppShareListResponse,
  AppSystemInfo,
  ScheduledTask,
  ScheduledTasksResponse,
} from "@opennas/shared";
import { api, apiUrl } from "./api.ts";
import { asBlob, lastSegment } from "./blob-util.ts";
import { useNotifications } from "../store/notifications.ts";
import { useAuth } from "../store/auth.ts";
import { confirmDialog, promptDialog } from "../store/dialogs.ts";
import { pickForApp } from "../store/picker.ts";

/**
 * Host side of the OpenNAS app SDK. Installed apps run in sandboxed iframes
 * (opaque origin) and can only reach the desktop through `postMessage`. This
 * module is the single broker: it maps each message's `source` (the app's
 * iframe window) to the registered app, enforces the app's declared permissions,
 * services the request against the real OpenNAS APIs (with the user's session),
 * and replies. Apps are isolated from each other and from OpenNAS internals - the
 * only authority they get is what their manifest declared and the user installed.
 */

interface AppReg {
  manifest: AppManifest;
  /** The app iframe's window - the identity we trust messages from. */
  source: Window;
  onSetTitle?: (title: string) => void;
  onClose?: () => void;
  /** Taskbar badge count, or null to clear it. */
  onBadge?: (count: number | null) => void;
  /** Ask for a window size, in CSS pixels; the host clamps to the screen. */
  onRequestSize?: (size: { width: number; height: number }) => void;
  onFullscreen?: (on: boolean) => void;
  /** Set once the app says it wants to be asked before its window closes. */
  guardsClose?: boolean;
}

const apps = new Map<Window, AppReg>();
let hostVersion = "";
let started = false;

const PROTOCOL = 1;

function currentTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Start the global message broker (idempotent). Call once at app startup. */
export function startAppBridge(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("message", handleMessage);
  api.get<{ version: string }>("/health").then((h) => { hostVersion = h.version; }).catch(() => {});
}

/** Register a running app instance. Returns an unregister fn. */
export function registerApp(reg: AppReg): () => void {
  apps.set(reg.source, reg);
  return () => {
    if (apps.get(reg.source) === reg) apps.delete(reg.source);
  };
}

/** Push a theme change to a specific app iframe (sent on the SDK's event channel). */
export function postThemeToApp(source: Window, theme: "light" | "dark"): void {
  source.postMessage({ __opennas: PROTOCOL, event: "theme", payload: theme }, "*");
}

function hasPermission(reg: AppReg, perm: AppPermission): boolean {
  return reg.manifest.permissions?.includes(perm) ?? false;
}

async function handleMessage(e: MessageEvent): Promise<void> {
  const d = e.data as {
    __opennas?: number;
    id?: number;
    type?: string;
    payload?: Record<string, unknown>;
    beforeCloseReply?: number;
    allow?: boolean;
  } | null;
  if (!d || d.__opennas !== PROTOCOL) return;
  const source = e.source as Window | null;
  if (!source) return;

  // An answer to "may I close you?" - only honoured from the window that was
  // asked, so one app cannot answer for another.
  if (typeof d.beforeCloseReply === "number") {
    if (!apps.has(source)) return;
    closeWaiters.get(d.beforeCloseReply)?.(d.allow !== false);
    return;
  }

  if (typeof d.id !== "number" || typeof d.type !== "string") return;
  const reg = apps.get(source);
  if (!reg) return; // unknown / closed app - ignore silently

  try {
    const result = await service(reg, d.type, d.payload ?? {}, d.id);
    source.postMessage({ __opennas: PROTOCOL, id: d.id, ok: true, result }, "*");
  } catch (err) {
    source.postMessage(
      { __opennas: PROTOCOL, id: d.id, ok: false, error: err instanceof Error ? err.message : "Request failed" },
      "*",
    );
  }
}

const NOTIFY_LEVELS = ["info", "success", "warning", "critical"];


/**
 * Bytes, rather than strings.
 *
 * Everything else in the bridge is JSON over `postMessage`, which is right for
 * a setting or a listing and hopeless for a photo: a 40 MB JPEG becomes a 54 MB
 * base64 string, built in the app's heap, copied into the host's, and copied
 * again into a request body. That ruled out most of what people would actually
 * write for a NAS.
 *
 * `postMessage` structured-clones a `Blob` **by reference** - the bytes stay in
 * the browser's blob store, which is disk-backed for anything large, and never
 * pass through either side's JavaScript heap. So a file moves app → host as a
 * Blob, and host → app as a Blob, and the only thing that streams is the actual
 * HTTP request. That is why these take and return Blobs rather than
 * ArrayBuffers, which *are* heap.
 *
 * The app never gets a URL it could fetch itself. It hands over bytes and gets
 * bytes back; the session cookie and the API stay on this side, exactly as they
 * do for every other call.
 */

/** Tell an app how far along a transfer is. Fire-and-forget: never awaited. */
function postProgress(source: Window, requestId: number, loaded: number, total: number): void {
  source.postMessage(
    { __opennas: PROTOCOL, event: "progress", payload: { id: requestId, loaded, total } },
    "*",
  );
}

/**
 * Upload one Blob, reporting progress.
 *
 * XHR rather than fetch purely for `upload.onprogress` - fetch still cannot
 * report how much of a request body has gone out, and on a NAS, where uploading
 * a video over wifi is a minute of nothing happening, a progress bar is not a
 * nicety.
 */
function uploadBlob(
  url: string,
  blob: Blob,
  filename: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ bytes: number }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", blob, filename);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.withCredentials = true;
    if (onProgress) {
      xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : blob.size);
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(blob.size, blob.size);
        let bytes = blob.size;
        try {
          bytes = (JSON.parse(xhr.responseText) as { bytes?: number }).bytes ?? blob.size;
        } catch {
          /* the count is a nicety; the upload succeeded */
        }
        resolve({ bytes });
        return;
      }
      let message = `Upload failed (${xhr.status})`;
      try {
        message = (JSON.parse(xhr.responseText) as { message?: string }).message ?? message;
      } catch {
        /* keep the status-code message */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Upload failed - the connection dropped."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    xhr.send(form);
  });
}

/**
 * Download to a Blob, reporting progress.
 *
 * Read through the stream so progress is real rather than a spinner, but each
 * chunk is handed straight to a Blob at the end rather than concatenated into
 * one big ArrayBuffer - the browser keeps a multi-part Blob's pieces in its own
 * store, so a large download never becomes a large allocation.
 */
async function downloadBlob(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Blob | null> {
  const res = await fetch(url, { credentials: "include" });
  if (res.status === 404) return null;
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      message = ((await res.json()) as { message?: string }).message ?? message;
    } catch {
      /* keep the status-code message */
    }
    throw new Error(message);
  }
  const total = Number(res.headers.get("content-length") ?? 0);
  const type = res.headers.get("content-type") ?? "application/octet-stream";
  if (!res.body || !onProgress) return new Blob([await res.blob()], { type });

  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as unknown as BlobPart);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  return new Blob(chunks, { type });
}

/**
 * Hand a file to the browser to save.
 *
 * Done here rather than by giving the app a URL, because the app's iframe is
 * sandboxed without `allow-downloads` - and loosening that so an app could
 * start its own downloads would let it start ones the user didn't ask for.
 */
function saveToDisk(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough for the browser to have taken it, short enough not to pin a
  // multi-gigabyte blob for the session.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}


async function service(
  reg: AppReg,
  type: string,
  p: Record<string, unknown>,
  requestId: number,
): Promise<unknown> {
  const id = reg.manifest.id;
  switch (type) {
    case "ready": {
      // Only hand over the user identity if the app was granted "user".
      let user = null;
      if (hasPermission(reg, "user")) {
        const u = useAuth.getState().session?.user;
        if (u) user = { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
      }
      return {
        host: { version: hostVersion, theme: currentTheme() },
        app: { id, name: reg.manifest.name, permissions: reg.manifest.permissions ?? [] },
        user,
      };
    }

    case "notify": {
      if (!hasPermission(reg, "notifications")) throw new Error("This app didn't request notifications access.");
      const level = (NOTIFY_LEVELS.includes(String(p.level)) ? p.level : "info") as "info" | "success" | "warning" | "critical";
      useNotifications.getState().push({
        level,
        title: String(p.title ?? reg.manifest.name).slice(0, 120),
        body: p.body != null ? String(p.body).slice(0, 400) : undefined,
      });
      return null;
    }

    // Settings need no permission: the app declared these fields itself, an
    // admin can see them in the panel, and the values only ever go back to the
    // app they belong to. It is read-only on purpose - an app changing its own
    // settings behind the user's back would make the panel a lie.
    case "settings.all": {
      const r = await api.get<{ values: Record<string, string | number | boolean> }>(`/apps/${id}/settings`);
      return r.values;
    }

    case "storage.get": {
      requireStorage(reg);
      const r = await api.get<{ value: string | null }>(`/apps/${id}/storage/${encodeURIComponent(String(p.key))}`);
      return r.value;
    }
    case "storage.set": {
      requireStorage(reg);
      await api.put(`/apps/${id}/storage/${encodeURIComponent(String(p.key))}`, { value: String(p.value ?? "") });
      return null;
    }
    case "storage.delete": {
      requireStorage(reg);
      await api.del(`/apps/${id}/storage/${encodeURIComponent(String(p.key))}`);
      return null;
    }
    case "storage.list": {
      requireStorage(reg);
      const r = await api.get<{ values: Record<string, string> }>(`/apps/${id}/storage`);
      return r.values;
    }

    case "files.list": {
      requireFiles(reg);
      const q = encodeURIComponent(String(p.path ?? "/"));
      const r = await api.get<{ entries: AppFileEntry[] }>(`/apps/${id}/files?path=${q}`);
      return r.entries;
    }
    case "files.read": {
      requireFiles(reg);
      const q = encodeURIComponent(String(p.path ?? ""));
      const r = await api.get<{ content: string | null }>(`/apps/${id}/files/content?path=${q}`);
      return r.content;
    }
    case "files.write": {
      requireFiles(reg);
      const q = encodeURIComponent(String(p.path ?? ""));
      await api.put(`/apps/${id}/files?path=${q}`, { content: String(p.content ?? "") });
      return null;
    }
    case "files.readBinary": {
      requireFiles(reg);
      const path = String(p.path ?? "");
      return await downloadBlob(
        apiUrl(`/apps/${id}/files/raw?path=${encodeURIComponent(path)}`),
        p.progress ? (loaded, total) => postProgress(reg.source, requestId, loaded, total) : undefined,
      );
    }
    case "files.writeBinary": {
      requireFiles(reg);
      const path = String(p.path ?? "");
      await uploadBlob(
        apiUrl(`/apps/${id}/files/upload?path=${encodeURIComponent(path)}`),
        asBlob(p.data),
        lastSegment(path),
        p.progress ? (loaded, total) => postProgress(reg.source, requestId, loaded, total) : undefined,
      );
      return null;
    }
    case "files.save": {
      requireFiles(reg);
      const path = String(p.path ?? "");
      const blob = await downloadBlob(apiUrl(`/apps/${id}/files/raw?path=${encodeURIComponent(path)}`));
      if (!blob) return false;
      saveToDisk(blob, String(p.filename ?? "") || lastSegment(path));
      return true;
    }
    case "files.mkdir": {
      requireFiles(reg);
      await api.post(`/apps/${id}/files/mkdir`, { path: String(p.path ?? "") });
      return null;
    }
    case "files.delete": {
      requireFiles(reg);
      const q = encodeURIComponent(String(p.path ?? ""));
      await api.del(`/apps/${id}/files?path=${q}`);
      return null;
    }

    case "system.info": {
      if (!hasPermission(reg, "system")) throw new Error("This app didn't request system access.");
      const r = await api.get<{ system: AppSystemInfo }>(`/apps/${id}/system`);
      return r.system;
    }

    case "fetch": {
      if (!hasPermission(reg, "fetch")) throw new Error("This app didn't request network access.");
      // The backend owns the allowlist and every SSRF check - the bridge only
      // confirms the app declared the capability at all.
      return await api.post<AppFetchResponse>(`/apps/${id}/fetch`, {
        url: String(p.url ?? ""),
        method: p.method != null ? String(p.method) : undefined,
        headers: p.headers && typeof p.headers === "object" ? (p.headers as Record<string, string>) : undefined,
        body: p.body != null ? String(p.body) : undefined,
      });
    }

    case "schedule.list": {
      requireSchedule(reg);
      const r = await api.get<ScheduledTasksResponse>(`/apps/${id}/schedule`);
      return r.tasks;
    }
    case "schedule.set": {
      requireSchedule(reg);
      const r = await api.put<{ task: ScheduledTask }>(`/apps/${id}/schedule`, {
        name: String(p.name ?? ""),
        intervalSeconds: Number(p.intervalSeconds ?? 0),
        action: p.action,
        enabled: p.enabled,
      });
      return r.task;
    }
    case "schedule.delete": {
      requireSchedule(reg);
      await api.del(`/apps/${id}/schedule/${encodeURIComponent(String(p.name ?? ""))}`);
      return null;
    }


    // ---- The user's real shared folders ------------------------------------

    // Two ways in, and the server decides between them: a `handle` from the
    // picker (paths relative to the granted folder, no permission needed), or
    // the app's manifest grant (absolute virtual paths). The bridge passes both
    // through rather than judging - the grant table and `pathAccess` live on the
    // server, and duplicating that decision here would only let the two drift.

    case "shares.pick": {
      const select = p.select === "file" ? "file" : "dir";
      const mode = p.mode === "readwrite" ? "readwrite" : "read";
      const choice = await pickForApp(reg.manifest, {
        select,
        mode,
        title: typeof p.title === "string" ? p.title : undefined,
      });
      // Cancelling is an ordinary answer, not an error.
      if (!choice) return null;
      const r = await api.post<AppShareGrantsResponse>(`/apps/${id}/shares/grants`, {
        path: choice.path,
        type: choice.type,
        mode,
      });
      return r.grants.find((g) => g.path === choice.path) ?? null;
    }
    case "shares.grants": {
      const r = await api.get<AppShareGrantsResponse>(`/apps/${id}/shares/grants`);
      return r.grants;
    }
    case "shares.revoke": {
      const r = await api.del<AppShareGrantsResponse>(
        `/apps/${id}/shares/grants/${encodeURIComponent(String(p.handle ?? ""))}`,
      );
      return r.grants;
    }
    case "shares.list": {
      const r = await api.get<AppShareListResponse>(`/apps/${id}/shares/list?${shareQuery(p)}`);
      return r;
    }
    case "shares.read": {
      const r = await api.get<{ content: string | null }>(`/apps/${id}/shares/content?${shareQuery(p)}`);
      return r.content;
    }
    case "shares.write": {
      await api.put(`/apps/${id}/shares/content?${shareQuery(p)}`, { content: String(p.content ?? "") });
      return null;
    }
    case "shares.readBinary": {
      return await downloadBlob(
        apiUrl(`/apps/${id}/shares/raw?${shareQuery(p)}`),
        p.progress ? (loaded, total) => postProgress(reg.source, requestId, loaded, total) : undefined,
      );
    }
    case "shares.writeBinary": {
      await uploadBlob(
        apiUrl(`/apps/${id}/shares/upload?${shareQuery(p)}`),
        asBlob(p.data),
        lastSegment(String(p.path ?? "")),
        p.progress ? (loaded, total) => postProgress(reg.source, requestId, loaded, total) : undefined,
      );
      return null;
    }
    case "shares.save": {
      const blob = await downloadBlob(apiUrl(`/apps/${id}/shares/raw?${shareQuery(p)}`));
      if (!blob) return false;
      saveToDisk(blob, String(p.filename ?? "") || lastSegment(String(p.path ?? "")));
      return true;
    }
    case "shares.mkdir": {
      await api.post(`/apps/${id}/shares/mkdir`, {
        path: String(p.path ?? ""),
        handle: p.handle != null ? String(p.handle) : undefined,
      });
      return null;
    }
    case "shares.delete": {
      await api.del(`/apps/${id}/shares/content?${shareQuery(p)}`);
      return null;
    }

    // ---- Host-drawn dialogs -------------------------------------------------

    // Drawn by OpenNAS, outside the iframe, so they look like the rest of the
    // desktop and an app can't dress its own markup up as a system prompt. The
    // app's name is put in the title for the same reason: whatever the app
    // writes in the message, the frame around it is the host's.

    case "dialog.alert": {
      await confirmDialog({
        title: reg.manifest.name,
        message: String(p.message ?? "").slice(0, 2000),
        confirmLabel: "OK",
        cancelLabel: "",
      });
      return null;
    }
    case "dialog.confirm": {
      return await confirmDialog({
        title: typeof p.title === "string" && p.title ? String(p.title).slice(0, 120) : reg.manifest.name,
        message: String(p.message ?? "").slice(0, 2000),
        confirmLabel: typeof p.confirmLabel === "string" ? p.confirmLabel.slice(0, 40) : "OK",
        cancelLabel: typeof p.cancelLabel === "string" ? p.cancelLabel.slice(0, 40) : "Cancel",
        danger: p.danger === true,
      });
    }
    case "dialog.prompt": {
      return await promptDialog({
        title: typeof p.title === "string" && p.title ? String(p.title).slice(0, 120) : reg.manifest.name,
        message: String(p.message ?? "").slice(0, 2000),
        defaultValue: typeof p.defaultValue === "string" ? p.defaultValue.slice(0, 4096) : "",
        placeholder: typeof p.placeholder === "string" ? p.placeholder.slice(0, 120) : undefined,
        // Deliberately no password type: an app must never be able to render
        // something that looks like OpenNAS asking for the user's credentials.
        inputType: "text",
      });
    }

    // ---- Window ------------------------------------------------------------

    case "setBadge": {
      const n = Number(p.count);
      reg.onBadge?.(Number.isFinite(n) && n > 0 ? Math.min(999, Math.floor(n)) : null);
      return null;
    }
    case "requestSize": {
      const width = Number(p.width);
      const height = Number(p.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
      reg.onRequestSize?.({ width, height });
      return null;
    }
    case "setFullscreen": {
      reg.onFullscreen?.(p.on === true);
      return null;
    }
    case "guardClose": {
      // The app is saying it wants a say before its window closes. Recorded on
      // the registration so the window can ask; see `askBeforeClose`.
      reg.guardsClose = p.on !== false;
      return null;
    }

    case "setTitle":
      reg.onSetTitle?.(String(p.title ?? "").slice(0, 120));
      return null;
    case "close":
      reg.onClose?.();
      return null;

    default:
      throw new Error(`Unknown request: ${type}`);
  }
}

function requireStorage(reg: AppReg): void {
  if (!hasPermission(reg, "storage")) throw new Error("This app didn't request storage access.");
}

function requireFiles(reg: AppReg): void {
  if (!hasPermission(reg, "files")) throw new Error("This app didn't request file access.");
}

function requireSchedule(reg: AppReg): void {
  if (!hasPermission(reg, "schedule")) throw new Error("This app didn't request scheduling.");
}

/** Build the query string shared by every shares endpoint. */
function shareQuery(p: Record<string, unknown>): string {
  const q = new URLSearchParams();
  q.set("path", String(p.path ?? ""));
  if (p.handle != null) q.set("handle", String(p.handle));
  return q.toString();
}

/**
 * Ask an app whether its window may close.
 *
 * This is the one place the host makes a *request* of the app rather than the
 * other way round, so it gets its own tiny protocol. An app that never answers
 * must not be able to make its window unclosable, so an unanswered question
 * times out and the close proceeds - the guard is a courtesy for unsaved work,
 * not a veto.
 */
export function askBeforeClose(source: Window, timeoutMs = 1500): Promise<boolean> {
  const reg = apps.get(source);
  if (!reg?.guardsClose) return Promise.resolve(true);

  const requestId = ++closeRequestId;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      closeWaiters.delete(requestId);
      resolve(true);
    }, timeoutMs);
    closeWaiters.set(requestId, (allow) => {
      window.clearTimeout(timer);
      closeWaiters.delete(requestId);
      resolve(allow);
    });
    source.postMessage({ __opennas: PROTOCOL, event: "beforeClose", payload: { requestId } }, "*");
  });
}

let closeRequestId = 0;
const closeWaiters = new Map<number, (allow: boolean) => void>();

/**
 * Windows whose app asked to be consulted before closing.
 *
 * Keyed by window id rather than by the iframe's Window object, because the
 * close comes from the title bar - which knows the window it belongs to and
 * nothing about iframes.
 */
const closeGuards = new Map<string, Window>();

export function registerCloseGuard(winId: string, source: Window): () => void {
  closeGuards.set(winId, source);
  return () => {
    if (closeGuards.get(winId) === source) closeGuards.delete(winId);
  };
}

/**
 * May this window close? True for anything that isn't a guarded app, so the
 * ordinary case costs nothing.
 */
export function requestWindowClose(winId: string): Promise<boolean> {
  const source = closeGuards.get(winId);
  return source ? askBeforeClose(source) : Promise.resolve(true);
}
