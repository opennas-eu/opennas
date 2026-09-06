import { extname } from "node:path";

/** Minimal extension→MIME map. Enough for icons, previews and download headers
 *  without pulling in a dependency. */
const MIME: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".log": "text/plain",
  ".json": "application/json", ".xml": "application/xml", ".csv": "text/csv",
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".ts": "text/plain", ".yml": "text/yaml", ".yaml": "text/yaml", ".toml": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".avif": "image/avif", ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
  ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed", ".rar": "application/vnd.rar",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function mimeOf(filename: string): string | null {
  return MIME[extname(filename).toLowerCase()] ?? null;
}

/**
 * Whether a MIME type is safe to render inline in the browser (preview).
 *
 * Security: anything script-capable in our own origin is excluded so a user
 * can't upload e.g. evil.html or a scripted .svg and get stored XSS by opening
 * it inline. SVG and HTML are always served as downloads, never inline.
 */
export function isInlineSafe(mime: string | null): boolean {
  if (!mime) return false;
  if (mime === "image/svg+xml") return false; // SVG can carry script
  if (mime === "text/html") return false; // would execute in our origin
  return (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime === "application/pdf" ||
    mime === "text/plain" ||
    mime === "text/markdown" ||
    mime === "text/csv"
  );
}
