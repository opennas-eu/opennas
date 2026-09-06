import { useEffect, useRef } from "react";
import type { DiskVolume } from "@opennas/shared";
import { api } from "../../lib/api.ts";
import { useAuth } from "../../store/auth.ts";
import { useSystem } from "../../store/system.ts";
import { useNotifications } from "../../store/notifications.ts";
import { formatBytes } from "../../lib/format.ts";

/**
 * Headless component: watches live telemetry and emits notifications for
 * noteworthy system events (sustained high load, full disks). Renders nothing.
 */
export function NotificationWatchers() {
  const latest = useSystem((s) => s.latest);
  const connected = useSystem((s) => s.connected);
  const push = useNotifications((s) => s.push);
  const hydrate = useNotifications((s) => s.hydrate);
  const userId = useAuth((s) => s.session?.user.id);
  const displayName = useAuth((s) => s.session?.user.displayName ?? "there");
  const wasConnected = useRef(false);
  const everConnected = useRef(false);

  // Restore persisted notifications (incl. read state) for this user before any
  // watcher pushes - so messages already seen don't reappear on reload/login.
  useEffect(() => {
    if (userId) hydrate(userId);
  }, [userId, hydrate]);

  // One-time welcome (deduped so StrictMode's double-mount doesn't repeat it).
  useEffect(() => {
    push(
      {
        level: "success",
        title: `Welcome back, ${displayName.split(" ")[0]}`,
        body: "Your OpenNAS desktop is ready.",
        appId: "dashboard",
      },
      "welcome",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // CPU / memory thresholds (deduped with a cooldown inside the store).
  useEffect(() => {
    if (!latest) return;
    if (latest.cpu.total >= 92) {
      push({ level: "warning", title: "High CPU load", body: `CPU at ${Math.round(latest.cpu.total)}%`, appId: "task-manager" }, "cpu-high");
    }
    const memPct = (latest.memory.usedBytes / latest.memory.totalBytes) * 100;
    if (memPct >= 92) {
      push({ level: "warning", title: "Memory almost full", body: `${Math.round(memPct)}% of RAM in use`, appId: "task-manager" }, "mem-high");
    }
  }, [latest, push]);

  // Connection lost/restored - only after we've connected at least once.
  useEffect(() => {
    if (connected) {
      if (everConnected.current && !wasConnected.current) {
        push({ level: "success", title: "Reconnected", body: "Live telemetry restored." }, "ws-reconnect");
      }
      wasConnected.current = true;
      everConnected.current = true;
    } else if (everConnected.current && wasConnected.current) {
      wasConnected.current = false;
      push({ level: "warning", title: "Connection lost", body: "Trying to reconnect to the server..." }, "ws-lost");
    }
  }, [connected, push]);

  // Disk fullness - checked on mount and every few minutes.
  useEffect(() => {
    let active = true;
    async function check() {
      try {
        const { disks } = await api.get<{ disks: DiskVolume[] }>("/system/disks");
        if (!active) return;
        for (const d of disks) {
          if (d.usePercent >= 90) {
            push(
              {
                level: d.usePercent >= 96 ? "critical" : "warning",
                title: `Volume ${d.mount} is ${Math.round(d.usePercent)}% full`,
                body: `${formatBytes(d.sizeBytes - d.usedBytes)} free of ${formatBytes(d.sizeBytes)}`,
                appId: "dashboard",
              },
              `disk-${d.mount}`,
            );
          }
        }
      } catch {
        /* ignore */
      }
    }
    void check();
    const t = setInterval(check, 5 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [push]);

  return null;
}
