/**
 * The per-load token that ties an app iframe's *document* to its bridge grant.
 *
 * The bridge identifies an app by its iframe's `contentWindow`, and that
 * WindowProxy outlives navigation: if the app's frame is navigated to some
 * other page - a link the user clicked, a redirect - the new page would be
 * posting from the very same window, and would inherit every permission the
 * app was granted. Watching the iframe's `load` event can't close that,
 * because a page's scripts run (and can post) before its load event fires.
 *
 * So each mount of an app frame gets a fresh random token, put in the iframe's
 * URL. The SDK reads it from its own `location` and stamps it on every message;
 * the host only answers messages that carry it. A page the frame navigates to
 * isn't loaded with that URL, so it doesn't have the token and gets nothing.
 *
 * Its own module, with no imports, so it can be tested outside a browser.
 */

/** The query parameter the token travels in. Must match the SDK. */
export const FRAME_TOKEN_PARAM = "opennas_frame";

/**
 * An unguessable token. `crypto.getRandomValues` rather than `randomUUID`,
 * because the latter only exists in secure contexts and a NAS is very often
 * reached over plain http on the LAN.
 */
export function randomToken(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `url` with the frame token added to its query string, leaving any path,
 * existing query and fragment alone. Works on relative URLs, which is what
 * `appContentUrl` returns in the usual same-origin setup.
 */
export function withFrameToken(url: string, token: string): string {
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const sep = base.includes("?") ? (base.endsWith("?") || base.endsWith("&") ? "" : "&") : "?";
  return `${base}${sep}${FRAME_TOKEN_PARAM}=${encodeURIComponent(token)}${hash}`;
}
