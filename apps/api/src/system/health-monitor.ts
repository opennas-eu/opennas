import { hostname } from "node:os";
import type { FastifyBaseLogger } from "fastify";
import type { StorageDisk } from "@opennas/shared";
import { config } from "../config.js";
import { getSetting, setSetting } from "../db/settings.js";
import { listStorageWithHealth } from "./storage.js";
import { getSmtpConfig, sendMail } from "./smtp.js";
import { notifyAdmins } from "../notifications/hub.js";

/**
 * Background disk-health monitor.
 *
 * The Storage dashboard raises an in-app alert for a failing disk, but only
 * while an admin has that page open - which is exactly not when a disk dies.
 * This polls S.M.A.R.T. on a timer and reports through two channels: a durable
 * notification to every admin (always), and email (when SMTP is configured).
 *
 * Email is edge-triggered: one message when a disk first becomes unhealthy (or
 * gets worse), then at most one reminder a week while it stays that way. A disk
 * that recovers is dropped from the state, so a later relapse alerts again. The
 * notification is deduped per disk-and-severity, which achieves the same thing
 * without a second bookkeeping table.
 */

const STATE_SETTING = "disk_alert_state";
const FIRST_CHECK_MS = 2 * 60 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REMINDER_MS = 7 * 24 * 60 * 60 * 1000;
/** Any reallocated sector is worth flagging - it's growth over time that kills a disk. */
const REALLOC_WARN = 1;
/** Drive temperature (°C) above which we warn. */
const TEMP_WARN_C = 60;

type Health = "ok" | "warning" | "failed";

const RANK: Record<Health, number> = { ok: 0, warning: 1, failed: 2 };

interface DiskAlertState {
  health: Health;
  /** ISO timestamp of the last email sent about this disk. */
  notifiedAt: string;
}

type AlertState = Record<string, DiskAlertState>;

function readState(): AlertState {
  try {
    return JSON.parse(getSetting(STATE_SETTING) || "{}") as AlertState;
  } catch {
    return {};
  }
}

function writeState(state: AlertState): void {
  setSetting(STATE_SETTING, JSON.stringify(state));
}

/** Assess one disk's S.M.A.R.T. data. Returns "ok" when there's nothing to report. */
export function assessDisk(disk: StorageDisk): { health: Health; reasons: string[] } {
  const smart = disk.smart;
  if (!smart) return { health: "ok", reasons: [] };
  const reasons: string[] = [];
  let health: Health = "ok";

  if (smart.status === "failed") {
    health = "failed";
    reasons.push("S.M.A.R.T. self-assessment reports FAILED");
  }
  if (smart.reallocatedSectors != null && smart.reallocatedSectors >= REALLOC_WARN) {
    if (health === "ok") health = "warning";
    reasons.push(`${smart.reallocatedSectors} reallocated sector(s)`);
  }
  if (smart.temperatureC != null && smart.temperatureC >= TEMP_WARN_C) {
    if (health === "ok") health = "warning";
    reasons.push(`running hot at ${smart.temperatureC}°C`);
  }
  return { health, reasons };
}

function describe(disk: StorageDisk, reasons: string[]): string {
  const lines = [`${disk.name}${disk.model ? ` - ${disk.model}` : ""}`];
  if (disk.serial) lines.push(`  Serial: ${disk.serial}`);
  if (disk.smart?.powerOnHours != null) lines.push(`  Powered on: ${disk.smart.powerOnHours} hours`);
  if (disk.smart?.temperatureC != null) lines.push(`  Temperature: ${disk.smart.temperatureC}°C`);
  for (const r of reasons) lines.push(`  ! ${r}`);
  return lines.join("\n");
}

/**
 * Run one health scan. Exported so it can be triggered on demand (and so the
 * timer stays a thin wrapper). Returns the number of disks alerted about.
 */
export async function runDiskHealthCheck(log: FastifyBaseLogger): Promise<number> {
  if (config.systemMode !== "linux") return 0; // no smartctl → nothing to read

  const disks = await listStorageWithHealth();
  const assessed = disks
    .map((disk) => ({ disk, ...assessDisk(disk) }))
    .filter((a) => a.health !== "ok");

  for (const a of assessed) {
    log.warn({ disk: a.disk.name, health: a.health, reasons: a.reasons }, "disk health problem");
    // Raise it in the notification centre regardless of whether email is set up.
    // Deduped per disk, so an ongoing fault doesn't pile up every six hours.
    notifyAdmins({
      level: a.health === "failed" ? "critical" : "warning",
      title: a.health === "failed" ? `Disk failing: ${a.disk.name}` : `Disk health warning: ${a.disk.name}`,
      body: `${a.disk.model ?? a.disk.name} - ${a.reasons.join("; ")}.`,
      dedupeKey: `disk-health:${a.disk.serial || a.disk.name}:${a.health}`,
    });
  }

  const smtp = getSmtpConfig();
  // Don't record "notified" bookkeeping when we can't actually notify - otherwise
  // enabling email later would stay silent until the weekly reminder came due.
  if (!smtp.enabled || !smtp.alertDiskHealth || !smtp.host) return 0;

  const prev = readState();
  const next: AlertState = {};
  const now = Date.now();
  const toSend: { disk: StorageDisk; health: Health; reasons: string[] }[] = [];

  for (const { disk, health, reasons } of assessed) {
    const key = disk.serial || disk.name;
    const before = prev[key];
    const escalated = !before || RANK[health] > RANK[before.health];
    const due = before ? now - Date.parse(before.notifiedAt) > REMINDER_MS : false;
    if (escalated || due) {
      toSend.push({ disk, health, reasons });
      next[key] = { health, notifiedAt: new Date(now).toISOString() };
    } else {
      next[key] = before!; // still bad, already reported - keep the original timestamp
    }
  }
  // Disks that recovered simply aren't in `next`, which re-arms them.
  writeState(next);

  if (toSend.length === 0) return 0;

  const failing = toSend.filter((a) => a.health === "failed").length;
  const subject = failing > 0
    ? `[OpenNAS] Disk failure on ${hostname()} - ${failing} disk${failing === 1 ? "" : "s"} reporting SMART FAILED`
    : `[OpenNAS] Disk health warning on ${hostname()}`;
  const body = [
    failing > 0
      ? "One or more disks are reporting a S.M.A.R.T. failure. Back up anything important and replace the disk."
      : "One or more disks reported a S.M.A.R.T. warning.",
    "",
    ...toSend.map((a) => describe(a.disk, a.reasons)),
    "",
    "Open Control Panel → Storage in OpenNAS for the full report.",
  ].join("\n");

  try {
    await sendMail(subject, body);
    log.info({ disks: toSend.map((a) => a.disk.name) }, "sent disk health alert email");
  } catch (err) {
    log.error({ err }, "could not send disk health alert email");
    // Roll the notification bookkeeping back so the next scan retries the email.
    writeState(prev);
    return 0;
  }
  return toSend.length;
}

/**
 * Start the periodic disk-health scan. Returns a stop function for the server's
 * onClose hook.
 */
export function startDiskHealthMonitor(log: FastifyBaseLogger): () => void {
  const safeRun = () =>
    void runDiskHealthCheck(log).catch((err: unknown) => log.warn({ err }, "disk health check failed"));

  const first = setTimeout(safeRun, FIRST_CHECK_MS);
  const timer = setInterval(safeRun, CHECK_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
