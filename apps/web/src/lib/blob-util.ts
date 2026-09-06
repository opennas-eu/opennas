/**
 * Turning what an app hands over into something uploadable.
 *
 * Its own module, with no imports, so it can be tested outside a browser - the
 * bridge it belongs to pulls in the API client, which reads `import.meta.env`
 * and therefore only exists under Vite. These two functions decide what an app
 * is allowed to hand over and what the resulting file is called, which is worth
 * covering without standing up a browser to do it.
 */

/** Coerce whatever an app sent into a Blob, or throw with something readable. */
export function asBlob(value: unknown): Blob {
  if (value instanceof Blob) return value;
  if (value instanceof ArrayBuffer) return new Blob([value]);
  if (ArrayBuffer.isView(value)) return new Blob([value as unknown as BlobPart]);
  throw new Error("Pass a Blob, File, ArrayBuffer or typed array.");
}

/**
 * The filename to put in the multipart part.
 *
 * Never empty: a part with no filename isn't a file upload as far as the parser
 * on the other end is concerned, so an app writing to "/" still gets something.
 */
export function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || "download";
}
