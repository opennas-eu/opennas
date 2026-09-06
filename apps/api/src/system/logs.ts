import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { LogSourceId, LogSourceInfo } from "@opennas/shared";
import { config } from "../config.js";

const exec = promisify(execFile);

/** Whitelisted log files. `priv` ones are root-owned → read via the doas helper. */
const LOGS: { id: LogSourceId; label: string; path: string; priv: boolean }[] = [
  { id: "opennas", label: "OpenNAS", path: "/var/log/opennas.log", priv: false },
  { id: "system", label: "System (messages)", path: "/var/log/messages", priv: true },
  { id: "nginx", label: "Web server (nginx)", path: "/var/log/nginx/error.log", priv: true },
  { id: "auth", label: "Authentication", path: "/var/log/auth.log", priv: true },
];

export function logSources(): LogSourceInfo[] {
  return LOGS.map((l) => ({ id: l.id, label: l.label, available: existsSync(l.path) }));
}

/** Most-recent `lines` of a log (oldest first). Empty if missing/unreadable. */
export async function readLog(id: LogSourceId, lines: number): Promise<string[]> {
  const log = LOGS.find((l) => l.id === id);
  if (!log || !existsSync(log.path)) return [];
  const n = Math.max(10, Math.min(2000, lines || 200));
  try {
    if (log.priv && config.systemMode === "linux") {
      const r = await exec("doas", ["/usr/lib/opennas/opennas-logs", id, String(n)], {
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return r.stdout.split("\n").filter(Boolean).slice(-n);
    }
    // Directly readable (opennas.log is owned by the service user).
    const content = await readFile(log.path, "utf8");
    return content.split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}
