/** Small formatting helpers shared across the system apps. */

import { tr, useI18n } from "../i18n/index.ts";

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
}

export function formatBitrate(bytesPerSec: number): string {
  // Networking convention: show per-second throughput in bytes/s.
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

export function formatRelative(iso: string | null): string {
  if (!iso) return tr("ui.time.never");
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return tr("ui.time.justNow");
  if (mins < 60) return tr("ui.time.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return tr("ui.time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return tr("ui.time.daysAgo", { n: days });
  return new Date(iso).toLocaleDateString(useI18n.getState().locale);
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}
