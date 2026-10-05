import test from "node:test";
import assert from "node:assert/strict";
import { FRAME_TOKEN_PARAM, randomToken, withFrameToken } from "../../apps/web/src/lib/frame-token.ts";
import { isSafeLinkHref, isSafeResourceUrl, isScriptUrl } from "../../apps/web/src/lib/safe-markup.ts";

/**
 * The pure halves of two browser-side defences: the token that ties an app
 * frame's document to its bridge grant, and the URL rules used to defuse a
 * rendered .docx. The DOM walk and the postMessage plumbing need a browser;
 * the decisions they make don't.
 */

test("frame tokens are long, hex and not repeated", () => {
  const a = randomToken();
  const b = randomToken();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test("withFrameToken adds the token without disturbing the URL", () => {
  assert.equal(withFrameToken("/app-content/x/index.html", "t"), `/app-content/x/index.html?${FRAME_TOKEN_PARAM}=t`);
  assert.equal(withFrameToken("/a/index.html?mode=1", "t"), `/a/index.html?mode=1&${FRAME_TOKEN_PARAM}=t`);
  assert.equal(withFrameToken("/a/index.html#/route", "t"), `/a/index.html?${FRAME_TOKEN_PARAM}=t#/route`);
  assert.equal(withFrameToken("http://localhost:5173/?", "t"), `http://localhost:5173/?${FRAME_TOKEN_PARAM}=t`);
  // What the SDK reads back is exactly what was put in.
  const url = new URL(withFrameToken("http://nas.local/app-content/x/index.html?q=1#h", "abc123"));
  assert.equal(url.searchParams.get(FRAME_TOKEN_PARAM), "abc123");
  assert.equal(url.hash, "#h");
});

test("docx links: only web, mail, phone and anchors survive", () => {
  for (const ok of ["https://example.com", "http://x", "mailto:a@b.c", "tel:123", "#_Toc1", ""]) {
    assert.equal(isSafeLinkHref(ok), true, ok);
  }
  for (const bad of [
    "javascript:alert(1)",
    " JavaScript:alert(1)",
    "java\tscript:alert(1)",
    "\u0000javascript:alert(1)",
    "vbscript:msgbox",
    "data:text/html,<script>alert(1)</script>",
    "/api/auth/logout",
    "file:///etc/passwd",
  ]) {
    assert.equal(isSafeLinkHref(bad), false, bad);
  }
});

test("docx images keep their own blob and data:image sources only", () => {
  assert.equal(isSafeResourceUrl("blob:http://nas/1234"), true);
  assert.equal(isSafeResourceUrl("data:image/png;base64,AAAA"), true);
  assert.equal(isSafeResourceUrl("data:text/html,hi"), false);
  assert.equal(isSafeResourceUrl("javascript:alert(1)"), false);
  assert.equal(isScriptUrl("  vbscript:x"), true);
  assert.equal(isScriptUrl("https://x"), false);
});
