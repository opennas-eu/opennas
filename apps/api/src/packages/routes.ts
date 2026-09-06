import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { PackageInfo, PackagesResponse } from "@opennas/shared";
import { requireAdmin, requireAuth } from "../auth/plugin.js";
import { CATALOG, getPackageDef } from "./catalog.js";
import { install, isInstalled, listInstalled, uninstall } from "../db/packages.js";
import { dockerRunning } from "../system/docker.js";
import { installService, removeService, serviceState, startService, stopService } from "./services.js";

export async function packageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/", async (): Promise<PackagesResponse> => {
    const running = await dockerRunning();
    const installed = new Map(listInstalled().map((p) => [p.id, p]));
    const packages: PackageInfo[] = await Promise.all(
      CATALOG.map(async (def) => {
        const rec = installed.get(def.info.id);
        let status = rec ? (rec.status as PackageInfo["status"]) : null;
        // For installed Docker services, reflect the live container state.
        if (rec && def.info.type === "service" && def.service && running) {
          status = (await serviceState(def.info.id)) ?? "stopped";
        }
        return {
          ...def.info,
          installed: rec !== undefined,
          status,
          webPort: status === "running" ? def.service?.webPort ?? null : null,
        };
      }),
    );
    return { packages, dockerRunning: running };
  });

  app.post("/:id/install", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    // Optional: which data volume a service package's persistent data goes on.
    const body = z.object({ volume: z.string().max(32).regex(/^[a-zA-Z0-9_-]*$/).nullish() }).safeParse(req.body ?? {});
    const volume = body.success ? body.data.volume : null;
    const def = getPackageDef(id);
    if (!def) return reply.code(404).send({ error: "not_found", message: "Unknown package." });
    if (isInstalled(id)) return reply.code(409).send({ error: "installed", message: "Already installed." });

    if (def.info.type === "app") {
      install(id, def.info.version, "running");
      return { ok: true, status: "running" };
    }

    // Service package: run it as a container if we have a spec + Docker.
    if (def.service && (await dockerRunning())) {
      const res = await installService(id, def.service, volume);
      if (!res.ok) return reply.code(502).send({ error: "run_failed", message: res.error ?? "Could not start the container." });
      install(id, def.info.version, "running");
      return { ok: true, status: "running" };
    }
    // No spec / no Docker - just track it (the workload lives outside OpenNAS).
    install(id, def.info.version, "external");
    return { ok: true, status: "external" };
  });

  app.post("/:id/uninstall", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const def = getPackageDef(id);
    if (!def) return reply.code(404).send({ error: "not_found", message: "Unknown package." });
    if (!isInstalled(id)) return reply.code(404).send({ error: "not_installed", message: "Not installed." });
    if (def.info.type === "service" && def.service) await removeService(id); // stop + remove the container
    uninstall(id);
    return { ok: true };
  });

  app.post("/:id/:action", { preHandler: requireAdmin }, async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (action !== "start" && action !== "stop") {
      return reply.code(400).send({ error: "invalid", message: "Use start or stop." });
    }
    const def = getPackageDef(id);
    if (!def?.service || !isInstalled(id)) return reply.code(404).send({ error: "not_found", message: "No such running service." });
    const res = await (action === "start" ? startService(id) : stopService(id));
    if (!res.ok) return reply.code(502).send({ error: "failed", message: res.error ?? "Action failed." });
    return { ok: true };
  });
}
