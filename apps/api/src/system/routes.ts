import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProcessListResponse } from "@opennas/shared";
import { requireAuth } from "../auth/plugin.js";
import { getDisks, getProcesses, getStaticInfo, sample } from "./collector.js";

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/info", async () => ({ info: await getStaticInfo() }));
  app.get("/sample", async () => ({ sample: await sample() }));
  app.get("/disks", async () => ({ disks: await getDisks() }));

  app.get("/processes", async (req): Promise<ProcessListResponse> => {
    const { list, total } = await getProcesses();
    return { processes: list, total, canKill: req.auth!.user.role === "admin" };
  });

  // Ending a process is admin-only and never permitted against PID 1 / self.
  const killSchema = z.object({ signal: z.enum(["SIGTERM", "SIGKILL"]).optional() });
  app.post("/processes/:pid/kill", async (req, reply) => {
    if (req.auth!.user.role !== "admin") {
      return reply.code(403).send({ error: "forbidden", message: "Administrator access required." });
    }
    const pid = Number.parseInt((req.params as { pid: string }).pid, 10);
    if (!Number.isInteger(pid) || pid <= 1) {
      return reply.code(400).send({ error: "bad_pid", message: "Invalid or protected PID." });
    }
    if (pid === process.pid) {
      return reply.code(400).send({ error: "self", message: "OpenNAS won't end its own process." });
    }
    const { signal } = killSchema.parse(req.body ?? {});
    try {
      process.kill(pid, signal ?? "SIGTERM");
      return { ok: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return reply.code(404).send({ error: "gone", message: "Process no longer exists." });
      if (code === "EPERM") return reply.code(403).send({ error: "eperm", message: "Not permitted to end this process." });
      return reply.code(500).send({ error: "kill_failed", message: "Could not end the process." });
    }
  });
}
