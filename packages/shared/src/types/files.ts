/** Files app contracts. All paths are POSIX-style, rooted at the share root
 *  ("/" = the configured OpenNAS files root). The server never exposes real
 *  absolute paths or anything outside the root. */

export type FileType = "file" | "dir";

export interface FileEntry {
  name: string;
  type: FileType;
  /** Size in bytes (0 for directories). */
  sizeBytes: number;
  modifiedAt: string;
  /** Best-effort MIME type for files, null for directories/unknown. */
  mime: string | null;
}

export interface FileListResponse {
  /** Normalized virtual path, always starts with "/". */
  path: string;
  entries: FileEntry[];
  /** Whether the user may modify this directory. */
  writable: boolean;
}

export interface MkdirRequest {
  /** Parent directory (virtual path). */
  path: string;
  name: string;
}

export interface RenameRequest {
  /** Virtual path of the existing item. */
  path: string;
  newName: string;
}

export interface DeleteRequest {
  path: string;
}

/** Copy or move an item into a destination directory. */
export interface TransferRequest {
  /** Virtual path of the source item. */
  path: string;
  /** Virtual path of the destination directory. */
  toDir: string;
}

/** Detailed info for the Properties panel. */
export interface FileInfo {
  name: string;
  path: string;
  type: FileType;
  /** Total size in bytes (recursively summed for directories). */
  sizeBytes: number;
  modifiedAt: string;
  createdAt: string;
  /** Number of immediate children (directories only; 0 for files). */
  itemCount: number;
  mime: string | null;
}

export interface FileInfoResponse {
  info: FileInfo;
}

// ---- Recycle bin ----------------------------------------------------------

export interface TrashItem {
  id: string;
  /** Original virtual path (incl. share) it will be restored to. */
  originalPath: string;
  name: string;
  isDir: boolean;
  sizeBytes: number;
  deletedAt: string;
}

export interface TrashListResponse {
  items: TrashItem[];
}

// ---- Public share links ---------------------------------------------------

export interface ShareLink {
  /** The public token (also the link id). */
  id: string;
  path: string;
  name: string;
  isDir: boolean;
  hasPassword: boolean;
  /** ISO expiry, or null for no expiry. */
  expiresAt: string | null;
  createdAt: string;
  /** Public URL relative to the site root, e.g. "/s/abc123". */
  url: string;
}

export interface ShareLinkListResponse {
  links: ShareLink[];
}

export interface ShareLinkResponse {
  link: ShareLink;
}

// ---- Search ----------------------------------------------------------------

/** One filename match from a search across the user's readable shares. */
export interface FileSearchHit {
  name: string;
  /** Virtual path of the match itself. */
  path: string;
  /** Virtual path of the containing folder - what File Station opens to reveal it. */
  parent: string;
  type: "file" | "dir";
  sizeBytes: number;
  modifiedAt: string | null;
  mime: string | null;
}

/** GET /api/files/search?q=... */
export interface FileSearchResponse {
  hits: FileSearchHit[];
  /**
   * True when a result/time cap stopped the walk. There's no index behind this,
   * so a search of a large tree is best-effort by design.
   */
  truncated: boolean;
}
