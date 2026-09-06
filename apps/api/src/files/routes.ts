import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { basename, dirname, extname, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import type {
  FileEntry,
  FileInfoResponse,
  FileSearchResponse,
  FileListResponse,
  ShareLinkListResponse,
  ShareLinkResponse,
  TrashListResponse,
} from "@opennas/shared";
import { requireAuth } from "../auth/plugin.js";
import { searchFiles } from "./search.js";
import { hashPassword } from "../auth/password.js";
import { ArchiveError, buildZip, extractZip } from "./archive.js";
import { emptyTrash, getTrashRow, listTrash, moveToTrash, purgeTrashItem, restoreFromTrash } from "./trash.js";
import { createLink, getLink, listLinks, removeLink } from "../db/share-links.js";
import { accessibleShareNames, pathAccess } from "./access.js";
import { mimeOf, isInlineSafe } from "./mime.js";
import { DEFAULT_THUMB_SIZE, getThumbnail, isThumbable, ThumbError } from "./thumbs.js";
import {
  isShareRoot,
  normalizeVirtual,
  PathError,
  resolveSafe,
  toVirtual,
  validateName,
} from "./paths.js";

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Translate path-safety errors into clean 400s.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof PathError) {
      return reply.code(400).send({ error: "bad_path", message: err.message });
    }
    app.log.error({ err }, "file route error");
    return reply.code(500).send({ error: "io_error", message: "File operation failed." });
  });

  // ---- List a directory -------------------------------------------------
  /**
   * Filename search across the shares this user can read. Bounded and
   * index-free - see files/search.ts for why it can return `truncated`.
   */
  app.get("/search", async (req, reply): Promise<FileSearchResponse> => {
    const q = z.object({ q: z.string().min(1).max(128) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid", message: "Provide a search term." }) as never;
    return searchFiles(req.auth!.user, q.data.q);
  });

  app.get("/list", async (req, reply): Promise<FileListResponse> => {
    const path = normalizeVirtual((req.query as { path?: string }).path ?? "/");
    const access = pathAccess(req.auth!.user, path);
    if (!access.read) {
      return reply.code(403).send({ error: "forbidden", message: "You don't have access to this folder." }) as never;
    }

    // Root = the list of shared folders. Each may live on a different volume, so
    // there's no single real directory to read - synthesize entries per share.
    if (path === "/") {
      const entries: FileEntry[] = [];
      for (const name of accessibleShareNames(req.auth!.user)) {
        let modifiedAt = new Date().toISOString();
        try {
          modifiedAt = (await stat(resolveSafe("/" + name))).mtime.toISOString();
        } catch {
          /* share folder missing (e.g. its volume is offline) - still list it */
        }
        entries.push({ name, type: "dir", sizeBytes: 0, modifiedAt, mime: null });
      }
      return { path: "/", entries, writable: false };
    }

    const real = resolveSafe(path);

    const dirStat = await stat(real).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) {
      return reply.code(404).send({ error: "not_found", message: "Folder not found." }) as never;
    }

    const dirents = await readdir(real, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const d of dirents) {
      try {
        const full = join(real, d.name);
        const s = await lstat(full); // don't follow symlinks
        const isDir = s.isDirectory();
        if (!isDir && !s.isFile()) continue; // skip sockets/fifos/symlinks
        entries.push({
          name: d.name,
          type: isDir ? "dir" : "file",
          sizeBytes: isDir ? 0 : s.size,
          modifiedAt: s.mtime.toISOString(),
          mime: isDir ? null : mimeOf(d.name),
        });
      } catch {
        /* unreadable entry - skip */
      }
    }

    // Folders first, then alphabetical (case-insensitive).
    entries.sort((a, b) =>
      a.type !== b.type
        ? a.type === "dir" ? -1 : 1
        : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    return { path, entries, writable: access.write };
  });

  // ---- Download / inline preview ---------------------------------------
  app.get("/download", (req, reply) => sendFile(req, reply, "attachment"));
  app.get("/raw", (req, reply) => sendFile(req, reply, "inline"));

  async function sendFile(req: FastifyRequest, reply: FastifyReply, mode: "attachment" | "inline") {
    const path = normalizeVirtual((req.query as { path?: string }).path ?? "/");
    if (!pathAccess(req.auth!.user, path).read) {
      return reply.code(403).send({ error: "forbidden", message: "You don't have access to this file." });
    }
    const real = resolveSafe(path);
    const s = await lstat(real).catch(() => null);
    if (!s || !s.isFile()) {
      return reply.code(404).send({ error: "not_found", message: "File not found." });
    }
    const name = basename(real);
    const mime = mimeOf(name);
    const disposition = mode === "inline" && isInlineSafe(mime) ? "inline" : "attachment";
    const total = s.size;
    reply
      .header("Content-Type", mime ?? "application/octet-stream")
      .header("Content-Disposition", `${disposition}; filename="${encodeURIComponent(name)}"`)
      // Advertise range support so browsers can seek within audio/video.
      .header("Accept-Ranges", "bytes")
      .header("Cache-Control", "private, max-age=0")
      // Defense in depth: never let user-supplied content sniff into an
      // executable type or run script, even if served inline.
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox; media-src 'self'; img-src 'self'");

    // ---- Range requests (video/audio seeking) --------------------------
    const range = req.headers.range;
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : NaN;
      let end = m[2] ? Number(m[2]) : NaN;
      if (Number.isNaN(start)) {
        // Suffix range "bytes=-N": the final N bytes.
        start = Math.max(0, total - end);
        end = total - 1;
      } else if (Number.isNaN(end)) {
        end = total - 1;
      }
      if (start > end || start >= total || total === 0) {
        return reply.code(416).header("Content-Range", `bytes */${total}`).send();
      }
      end = Math.min(end, total - 1);
      reply
        .code(206)
        .header("Content-Range", `bytes ${start}-${end}/${total}`)
        .header("Content-Length", end - start + 1);
      return reply.send(createReadStream(real, { start, end }));
    }

    reply.header("Content-Length", total);
    return reply.send(createReadStream(real));
  }

  // ---- Image thumbnails (cached) ---------------------------------------
  app.get("/thumb", async (req, reply) => {
    const q = req.query as { path?: string; size?: string };
    const path = normalizeVirtual(q.path ?? "/");
    if (!pathAccess(req.auth!.user, path).read) {
      return reply.code(403).send({ error: "forbidden", message: "You don't have access to this file." });
    }
    const real = resolveSafe(path);
    const s = await lstat(real).catch(() => null);
    if (!s || !s.isFile()) {
      return reply.code(404).send({ error: "not_found", message: "File not found." });
    }
    if (!isThumbable(mimeOf(basename(real)))) {
      return reply.code(415).send({ error: "unsupported", message: "No thumbnail for this file type." });
    }
    let size = Number(q.size);
    if (!Number.isFinite(size)) size = DEFAULT_THUMB_SIZE;
    size = Math.max(64, Math.min(512, Math.round(size)));
    try {
      const buf = await getThumbnail(real, size, s.mtimeMs, s.size);
      reply
        .header("Content-Type", "image/webp")
        .header("Content-Length", buf.length)
        // Key embeds mtime+size, so a hit is always current - cache it hard.
        .header("Cache-Control", "private, max-age=86400")
        .header("X-Content-Type-Options", "nosniff");
      return reply.send(buf);
    } catch (err) {
      if (err instanceof ThumbError) {
        return reply.code(415).send({ error: "thumb_failed", message: err.message });
      }
      throw err;
    }
  });

  // ---- Create folder ----------------------------------------------------
  const mkdirSchema = z.object({ path: z.string(), name: z.string() });
  app.post("/mkdir", async (req, reply) => {
    const body = mkdirSchema.parse(req.body);
    if (!pathAccess(req.auth!.user, body.path).write) {
      return reply.code(403).send({ error: "forbidden", message: "You don't have write access here." });
    }
    const name = validateName(body.name);
    const parent = resolveSafe(body.path);
    const target = join(parent, name);
    if (await exists(target)) {
      return reply.code(409).send({ error: "exists", message: "Something with that name already exists." });
    }
    await mkdir(target);
    return { ok: true, path: toVirtual(target) };
  });

  // ---- Rename -----------------------------------------------------------
  const renameSchema = z.object({ path: z.string(), newName: z.string() });
  app.post("/rename", async (req, reply) => {
    const body = renameSchema.parse(req.body);
    if (!pathAccess(req.auth!.user, body.path).write) {
      return reply.code(403).send({ error: "forbidden", message: "You don't have write access here." });
    }
    const newName = validateName(body.newName);
    if (isShareRoot(body.path)) {
      return reply.code(400).send({ error: "bad_path", message: "Rename shared folders in Control Panel → Shared Folders." });
    }
    const src = resolveSafe(body.path);
    const dest = join(dirname(src), newName);
    if (await exists(dest)) {
      return reply.code(409).send({ error: "exists", message: "A file with that name already exists." });
    }
    await rename(src, dest);
    return { ok: true, path: toVirtual(dest) };
  });

  // ---- Copy / Move ------------------------------------------------------
  const transferSchema = z.object({ path: z.string(), toDir: z.string() });

  /** Resolve a transfer and pick a destination path, avoiding collisions for copy. */
  async function planTransfer(
    req: FastifyRequest,
    reply: FastifyReply,
    uniquify: boolean,
  ): Promise<{ src: string; dest: string } | null> {
    const body = transferSchema.parse(req.body);
    const srcVirtual = normalizeVirtual(body.path);
    const toDirVirtual = normalizeVirtual(body.toDir);
    // Need read on the source and write into the destination directory.
    if (!pathAccess(req.auth!.user, srcVirtual).read || !pathAccess(req.auth!.user, toDirVirtual).write) {
      reply.code(403).send({ error: "forbidden", message: "You don't have access to do that." });
      return null;
    }
    if (isShareRoot(srcVirtual)) {
      reply.code(400).send({ error: "bad_path", message: "Move shared folders in Control Panel → Shared Folders." });
      return null;
    }
    const src = resolveSafe(srcVirtual);
    const destDir = resolveSafe(toDirVirtual);
    const destDirStat = await stat(destDir).catch(() => null);
    if (!destDirStat?.isDirectory()) {
      reply.code(404).send({ error: "not_found", message: "Destination folder not found." });
      return null;
    }
    // Refuse to move/copy a directory into itself or its own subtree.
    if (destDir === src || destDir.startsWith(src + "/")) {
      reply.code(400).send({ error: "bad_path", message: "Cannot move a folder into itself." });
      return null;
    }
    const name = basename(src);
    let dest = join(destDir, name);
    if (await exists(dest)) {
      if (!uniquify) {
        reply.code(409).send({ error: "exists", message: "An item with that name already exists there." });
        return null;
      }
      dest = await uniqueName(destDir, name); // "file (copy).txt", "file (copy 2).txt"...
    }
    return { src, dest };
  }

  app.post("/copy", async (req, reply) => {
    const plan = await planTransfer(req, reply, true);
    if (!plan) return reply;
    await cp(plan.src, plan.dest, { recursive: true, errorOnExist: false });
    return { ok: true, path: toVirtual(plan.dest) };
  });

  app.post("/move", async (req, reply) => {
    const plan = await planTransfer(req, reply, false);
    if (!plan) return reply;
    await rename(plan.src, plan.dest);
    return { ok: true, path: toVirtual(plan.dest) };
  });

  // ---- Properties / detailed info --------------------------------------
  app.get("/info", async (req, reply): Promise<FileInfoResponse> => {
    const path = normalizeVirtual((req.query as { path?: string }).path ?? "/");
    if (!pathAccess(req.auth!.user, path).read) {
      return reply.code(403).send({ error: "forbidden", message: "You don't have access to this item." }) as never;
    }
    const real = resolveSafe(path);
    const s = await lstat(real).catch(() => null);
    if (!s) return reply.code(404).send({ error: "not_found", message: "Not found." }) as never;
    const isDir = s.isDirectory();
    let sizeBytes = isDir ? 0 : s.size;
    let itemCount = 0;
    if (isDir) {
      const children = await readdir(real, { withFileTypes: true }).catch(() => []);
      itemCount = children.length;
      sizeBytes = await dirSize(real);
    }
    return {
      info: {
        name: basename(real) || "/",
        path,
        type: isDir ? "dir" : "file",
        sizeBytes,
        modifiedAt: s.mtime.toISOString(),
        createdAt: s.birthtime.toISOString(),
        itemCount,
        mime: isDir ? null : mimeOf(basename(real)),
      },
    };
  });

  // ---- Archives (zip / unzip) ------------------------------------------
  app.post("/compress", async (req, reply) => {
    const body = z.object({ dir: z.string(), names: z.array(z.string()).min(1).max(1000), name: z.string().min(1) }).parse(req.body);
    if (!pathAccess(req.auth!.user, body.dir).write) {
      return reply.code(403).send({ error: "forbidden", message: "You don't have write access here." });
    }
    const dir = resolveSafe(body.dir);
    const zipName = validateName(body.name.toLowerCase().endsWith(".zip") ? body.name : `${body.name}.zip`);
    const reals = body.names.map((n) => join(dir, validateName(n)));
    const dest = join(dir, zipName);
    if (await exists(dest)) return reply.code(409).send({ error: "exists", message: "An archive with that name already exists." });
    try {
      await writeFile(dest, await buildZip(reals));
    } catch (err) {
      if (err instanceof ArchiveError) return reply.code(400).send({ error: "zip_failed", message: err.message });
      throw err;
    }
    return { ok: true, path: toVirtual(dest) };
  });

  app.post("/extract", async (req, reply) => {
    const body = z.object({ path: z.string() }).parse(req.body);
    if (isShareRoot(body.path)) return reply.code(400).send({ error: "bad_path", message: "Pick a .zip file to extract." });
    const parentVirtual = normalizeVirtual(body.path.slice(0, body.path.lastIndexOf("/")) || "/");
    if (!pathAccess(req.auth!.user, parentVirtual).write) {
      return reply.code(403).send({ error: "forbidden", message: "You don't have write access here." });
    }
    const zipReal = resolveSafe(body.path);
    const s = await lstat(zipReal).catch(() => null);
    if (!s?.isFile()) return reply.code(404).send({ error: "not_found", message: "Archive not found." });
    const folder = basename(zipReal).replace(/\.zip$/i, "") || "extracted";
    const destReal = await uniqueDir(dirname(zipReal), folder);
    await mkdir(destReal, { recursive: true });
    try {
      await extractZip(zipReal, destReal);
    } catch (err) {
      await rm(destReal, { recursive: true, force: true });
      if (err instanceof ArchiveError) return reply.code(400).send({ error: "unzip_failed", message: err.message });
      throw err;
    }
    return { ok: true, path: toVirtual(destReal) };
  });

  app.get("/zip", async (req, reply) => {
    const path = normalizeVirtual((req.query as { path?: string }).path ?? "/");
    if (!pathAccess(req.auth!.user, path).read) {
      return reply.code(403).send({ error: "forbidden", message: "You don't have access to this folder." });
    }
    const real = resolveSafe(path);
    const s = await lstat(real).catch(() => null);
    if (!s?.isDirectory()) return reply.code(400).send({ error: "not_dir", message: "Only folders can be downloaded as a zip." });
    let zip: Uint8Array;
    try {
      zip = await buildZip([real]);
    } catch (err) {
      if (err instanceof ArchiveError) return reply.code(413).send({ error: "too_large", message: err.message });
      throw err;
    }
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${encodeURIComponent(basename(real))}.zip"`)
      .header("Content-Length", zip.length);
    return reply.send(Buffer.from(zip));
  });

  // ---- Delete -----------------------------------------------------------
  app.delete("/", async (req, reply) => {
    const q = req.query as { path?: string; permanent?: string };
    const path = normalizeVirtual(q.path ?? "");
    if (!pathAccess(req.auth!.user, path).write) {
      return reply.code(403).send({ error: "forbidden", message: "You don't have write access here." });
    }
    if (isShareRoot(path)) {
      return reply.code(400).send({ error: "bad_path", message: "Delete shared folders in Control Panel → Shared Folders." });
    }
    const real = resolveSafe(path);
    const s = await lstat(real).catch(() => null);
    if (!s) return reply.code(404).send({ error: "not_found", message: "Not found." });
    if (q.permanent === "1" || q.permanent === "true") {
      await rm(real, { recursive: true, force: true });
      return { ok: true };
    }
    // Soft delete → recycle bin (restorable).
    await moveToTrash(req.auth!.user.id, real, path, s.isDirectory(), s.isFile() ? s.size : 0);
    return { ok: true, trashed: true };
  });

  // ---- Recycle bin ------------------------------------------------------
  app.get("/trash", async (req): Promise<TrashListResponse> => ({ items: listTrash(req.auth!.user.id) }));

  app.post("/trash/empty", async (req) => {
    await emptyTrash(req.auth!.user.id);
    return { ok: true };
  });

  app.post("/trash/:id/restore", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const item = getTrashRow(req.auth!.user.id, id);
    if (item) {
      const parent = normalizeVirtual(item.originalPath.slice(0, item.originalPath.lastIndexOf("/")) || "/");
      if (!pathAccess(req.auth!.user, parent).write) {
        return reply.code(403).send({ error: "forbidden", message: "You no longer have write access to restore there." });
      }
    }
    const res = await restoreFromTrash(req.auth!.user.id, id);
    if (!res.ok) return reply.code(res.code).send({ error: "restore_failed", message: res.message });
    return { ok: true, path: res.path };
  });

  app.delete("/trash/:id", async (req) => {
    await purgeTrashItem(req.auth!.user.id, (req.params as { id: string }).id);
    return { ok: true };
  });

  // ---- Public share links ----------------------------------------------
  const shareLinkSchema = z.object({
    path: z.string(),
    expiresInDays: z.number().int().min(0).max(3650).optional(),
    password: z.string().min(1).max(255).optional(),
  });

  app.post("/share-links", async (req, reply): Promise<ShareLinkResponse> => {
    const body = shareLinkSchema.parse(req.body);
    const path = normalizeVirtual(body.path);
    if (path === "/" || isShareRoot(path)) {
      return reply.code(400).send({ error: "bad_path", message: "Pick a file or folder to share." }) as never;
    }
    if (!pathAccess(req.auth!.user, path).read) {
      return reply.code(403).send({ error: "forbidden", message: "You don't have access to this item." }) as never;
    }
    const real = resolveSafe(path);
    const s = await lstat(real).catch(() => null);
    if (!s) return reply.code(404).send({ error: "not_found", message: "Not found." }) as never;
    const id = nanoid(24);
    const expiresAt = body.expiresInDays && body.expiresInDays > 0 ? new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString() : null;
    const passwordHash = body.password ? await hashPassword(body.password) : null;
    createLink({ id, userId: req.auth!.user.id, virtualPath: path, name: basename(real), isDir: s.isDirectory(), passwordHash, expiresAt });
    return { link: getLink(req.auth!.user.id, id)! };
  });

  app.get("/share-links", async (req): Promise<ShareLinkListResponse> => ({ links: listLinks(req.auth!.user.id) }));

  app.delete("/share-links/:id", async (req) => {
    removeLink(req.auth!.user.id, (req.params as { id: string }).id);
    return { ok: true };
  });

  // ---- Write text content (Text Editor) --------------------------------
  const writeSchema = z.object({ path: z.string(), content: z.string().max(8 * 1024 * 1024) });
  app.put("/write", async (req, reply) => {
    const body = writeSchema.parse(req.body);
    const path = normalizeVirtual(body.path);
    if (!pathAccess(req.auth!.user, path).write) {
      return reply.code(403).send({ error: "forbidden", message: "You don't have write access here." });
    }
    const real = resolveSafe(path);
    const existing = await lstat(real).catch(() => null);
    if (existing && !existing.isFile()) {
      return reply.code(400).send({ error: "not_file", message: "Target is not a file." });
    }
    await writeFile(real, body.content, "utf8");
    return { ok: true };
  });

  // ---- Upload (multipart) ----------------------------------------------
  app.post("/upload", async (req, reply) => {
    const path = normalizeVirtual((req.query as { path?: string }).path ?? "/");
    if (!pathAccess(req.auth!.user, path).write) {
      return reply.code(403).send({ error: "forbidden", message: "You don't have write access here." });
    }
    const dir = resolveSafe(path);
    const dirStat = await stat(dir).catch(() => null);
    if (!dirStat?.isDirectory()) {
      return reply.code(404).send({ error: "not_found", message: "Target folder not found." });
    }

    const saved: string[] = [];
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type !== "file") continue;
      const name = validateName(part.filename || "upload");
      const dest = join(dir, name);
      // Guard: the resolved destination must stay within the share root.
      resolveSafe(toVirtual(dest));
      await pipeline(part.file, createWriteStream(dest));
      if (part.file.truncated) {
        await rm(dest, { force: true });
        return reply.code(413).send({ error: "too_large", message: `"${name}" exceeds the upload size limit.` });
      }
      saved.push(name);
    }
    if (saved.length === 0) {
      return reply.code(400).send({ error: "no_files", message: "No files were uploaded." });
    }
    return { ok: true, saved };
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Pick "name (copy).ext" / "name (copy N).ext" that doesn't collide in dir. */
async function uniqueName(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? " (copy)" : ` (copy ${i})`;
    const candidate = `${stem}${suffix}${ext}`;
    if (!(await exists(join(dir, candidate)))) return join(dir, candidate);
  }
  return join(dir, `${stem} (copy ${Date.now()})${ext}`);
}

/** A directory path under `parent` that doesn't exist yet ("name", "name (2)", ...). */
async function uniqueDir(parent: string, name: string): Promise<string> {
  let candidate = join(parent, name);
  for (let i = 2; await exists(candidate); i++) candidate = join(parent, `${name} (${i})`);
  return candidate;
}

/** Recursive size of a directory subtree (best-effort; unreadable entries skipped). */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = join(dir, e.name);
    try {
      if (e.isDirectory()) total += await dirSize(full);
      else if (e.isFile()) total += (await lstat(full)).size;
    } catch {
      /* skip unreadable */
    }
  }
  return total;
}
