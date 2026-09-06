import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword } from "../auth/password.js";
import { deleteLinkById, getPublicLink } from "../db/share-links.js";
import { buildZip } from "./archive.js";
import { isInlineSafe, mimeOf } from "./mime.js";
import { resolveSafe } from "./paths.js";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - OpenNAS</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1730;color:#e7edf5;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{background:#1b2434;border-radius:16px;padding:32px;max-width:380px;width:90%;box-shadow:0 10px 40px -8px #0008;text-align:center}
h1{font-size:18px;margin:0 0 6px}p{color:#8a98ac;margin:0 0 18px}
input{width:100%;box-sizing:border-box;border:0;border-radius:8px;padding:10px;background:#0e1730;color:#e7edf5;margin-bottom:12px}
button{width:100%;border:0;border-radius:8px;padding:10px;background:#2563eb;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:#fda4af;margin-bottom:12px}</style></head><body><div class="card">${body}</div></body></html>`;
}

const notFoundPage = () => page("Link not found", "<h1>Link not found</h1><p>This share link doesn't exist or was revoked.</p>");
const expiredPage = () => page("Link expired", "<h1>Link expired</h1><p>This share link is no longer available.</p>");
const passwordPage = (token: string, wrong: boolean) =>
  page(
    "Password required",
    `<h1>Password required</h1><p>This shared item is protected.</p>
     ${wrong ? '<div class="err">Incorrect password. Try again.</div>' : ""}
     <form method="post" action="/s/${esc(token)}"><input type="password" name="password" placeholder="Password" autofocus><button type="submit">Unlock</button></form>`,
  );

/** GET /s/:token - serve the shared file/folder (after expiry + password checks). */
export async function servePublicLink(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const token = (req.params as { token: string }).token;
  const link = getPublicLink(token);
  if (!link) return reply.code(404).type("text/html").send(notFoundPage());
  if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
    deleteLinkById(token);
    return reply.code(410).type("text/html").send(expiredPage());
  }
  if (link.passwordHash) {
    const cookie = req.cookies[`dl_${token}`];
    const valid = cookie ? req.unsignCookie(cookie).valid : false;
    if (!valid) return reply.type("text/html").send(passwordPage(token, false));
  }

  let real: string;
  try {
    real = resolveSafe(link.virtualPath);
  } catch {
    return reply.code(404).type("text/html").send(notFoundPage());
  }
  const s = await lstat(real).catch(() => null);
  if (!s) return reply.code(404).type("text/html").send(notFoundPage());

  if (s.isDirectory()) {
    const zip = await buildZip([real]);
    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${encodeURIComponent(basename(real))}.zip"`)
      .header("Content-Length", zip.length)
      .send(Buffer.from(zip));
  }

  const name = basename(real);
  const mime = mimeOf(name);
  const disposition = isInlineSafe(mime) ? "inline" : "attachment";
  return reply
    .header("Content-Type", mime ?? "application/octet-stream")
    .header("Content-Length", s.size)
    .header("Content-Disposition", `${disposition}; filename="${encodeURIComponent(name)}"`)
    .header("X-Content-Type-Options", "nosniff")
    // Same hardening as /api/files/raw - never let shared content sniff/script in our origin.
    .header("Content-Security-Policy", "default-src 'none'; sandbox; media-src 'self'; img-src 'self'")
    .send(createReadStream(real));
}

/** POST /s/:token - verify the password, set a short signed cookie, redirect. */
export async function checkPublicPassword(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const token = (req.params as { token: string }).token;
  const link = getPublicLink(token);
  if (!link || !link.passwordHash) return reply.redirect(`/s/${token}`);
  if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
    return reply.code(410).type("text/html").send(expiredPage());
  }
  const password = String((req.body as { password?: string } | undefined)?.password ?? "");
  if (!(await verifyPassword(password, link.passwordHash))) {
    return reply.type("text/html").send(passwordPage(token, true));
  }
  reply.setCookie(`dl_${token}`, "1", { signed: true, path: `/s/${token}`, httpOnly: true, sameSite: "lax", maxAge: 3600 });
  return reply.redirect(`/s/${token}`);
}
