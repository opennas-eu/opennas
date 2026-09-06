import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { servicesDirFor } from "../system/storage-paths.js";
import { containerAction, getContainerByName, runContainer } from "../system/docker.js";
import type { ServiceSpec } from "./catalog.js";

const PREFIX = "opennas-svc-";

/** The container name OpenNAS uses for a service package. */
export function serviceContainerName(id: string): string {
  return PREFIX + id;
}

/**
 * Create + run a service package's container (one-click).
 *
 * `volume` picks which data volume the service's persistent data lands on. It's
 * only needed here: the resulting host paths are baked into the container, so
 * start/stop/remove don't have to know where it went - Docker remembers.
 */
export async function installService(
  id: string,
  spec: ServiceSpec,
  volume?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const name = serviceContainerName(id);
  const volumes: { host: string; container: string }[] = [];
  for (const v of spec.volumes ?? []) {
    const host = join(servicesDirFor(volume), id, v.name);
    await mkdir(host, { recursive: true });
    volumes.push({ host, container: v.container });
  }
  for (const m of spec.hostMounts ?? []) {
    volumes.push({ host: m.host, container: m.container + (m.readOnly ? ":ro" : "") });
  }
  // Clear any stale container with the same name first (best-effort).
  await containerAction(name, "remove").catch(() => {});
  return runContainer({ name, image: spec.image, ports: spec.ports, volumes, env: spec.env, args: spec.args });
}

export const startService = (id: string) => containerAction(serviceContainerName(id), "start");
export const stopService = (id: string) => containerAction(serviceContainerName(id), "stop");
export const removeService = (id: string) => containerAction(serviceContainerName(id), "remove");

/** "running" | "stopped" from the container, or null if it doesn't exist. */
export async function serviceState(id: string): Promise<"running" | "stopped" | null> {
  const c = await getContainerByName(serviceContainerName(id));
  if (!c) return null;
  return c.state === "running" ? "running" : "stopped";
}
