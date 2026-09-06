/**
 * @opennas/shared - the API contract shared between the OpenNAS web UI and API.
 * Keep this dependency-free so both Vite and Node can consume it as raw TS.
 */

export * from "./types/auth.js";
export * from "./types/system.js";
export * from "./types/apps.js";
export * from "./types/vms.js";
export * from "./types/files.js";
export * from "./types/admin.js";
export * from "./types/prefs.js";
export * from "./types/themes.js";
export * from "./types/notes.js";
export * from "./types/notifications.js";
export * from "./types/audit.js";
export * from "./types/ws.js";
