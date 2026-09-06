import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  MAX_REGISTRIES,
  dockerLogin,
  dockerLogout,
  isValidRegistryHost,
  listRegistries,
  refreshStatus,
  removeRegistry,
  upsertRegistry,
} from "../system/registries.js";
import { NET_NAME_RE, createDockerNetwork, removeDockerNetwork } from "../system/netvirt.js";
import type {
  ContainerStatsResponse,
  ContainersResponse,
  ImagesResponse,
  RegistriesResponse,
  StackComposeResponse,
  StacksResponse,
} from "@opennas/shared";
import { requireAdmin } from "../auth/plugin.js";
import {
  containerAction,
  containerLogs,
  containerStats,
  dockerRunning,
  getContainerByName,
  getDocker,
  listImages,
  pullImage,
  runContainer,
  type ContainerAction,
} from "../system/docker.js";
import { composeDown, composeUp, createStack, getStackCompose, listStacks, removeStack } from "../system/compose.js";
import { startDockerDaemon } from "../system/integration.js";

const ACTIONS: ContainerAction[] = ["start", "stop", "restart", "remove"];

export async function containerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  app.get("/", async (): Promise<ContainersResponse> => ({ docker: await getDocker() }));

  // Start the docker daemon if it's installed but not running.
  app.post("/start-daemon", async (req, reply) => {
    const res = await startDockerDaemon(req.log);
    if (!res.ok) return reply.code(500).send({ error: "failed", message: res.error ?? "Could not start Docker." });
    return { ok: true };
  });

  app.get("/images", async (): Promise<ImagesResponse> => ({ images: await listImages() }));

  // Run a new container from a user-defined spec (image, ports, volumes, env,
  // restart policy + CPU/RAM limits).
  const runSchema = z.object({
    name: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "letters, digits, '_', '.', '-'"),
    image: z.string().trim().min(1).max(255).regex(/^[a-zA-Z0-9._:/@-]+$/),
    ports: z.array(z.object({ host: z.number().int().min(1).max(65535), container: z.number().int().min(1).max(65535), proto: z.enum(["tcp", "udp"]).optional() })).max(40).optional(),
    volumes: z.array(z.object({ host: z.string().min(1).max(1024), container: z.string().min(1).max(1024) })).max(40).optional(),
    env: z.record(z.string().max(256), z.string().max(4096)).optional(),
    restart: z.enum(["no", "unless-stopped", "always", "on-failure"]).optional(),
    cpus: z.string().regex(/^\d+(\.\d+)?$/).optional(),
    memory: z.string().regex(/^\d+[bkmg]?$/i).optional(),
    network: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/).optional(),
  });

  app.post("/run", async (req, reply) => {
    const parsed = runSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Provide at least a valid name and image; check ports, limits and mounts." });
    }
    if (!(await getDocker()).running) {
      return reply.code(409).send({ error: "no_docker", message: "Docker isn't running." });
    }
    if (await getContainerByName(parsed.data.name)) {
      return reply.code(409).send({ error: "name_taken", message: "A container with that name already exists." });
    }
    // Bind-mount host paths must be absolute (no relative/handle-style mounts).
    for (const v of parsed.data.volumes ?? []) {
      if (!v.host.startsWith("/")) {
        return reply.code(400).send({ error: "bad_mount", message: `Volume host path must be absolute: ${v.host}` });
      }
    }
    const res = await runContainer(parsed.data);
    if (!res.ok) return reply.code(502).send({ error: "run_failed", message: res.error ?? "Could not start the container." });
    return reply.code(201).send({ ok: true });
  });

  app.post("/images/pull", async (req, reply) => {
    const parsed = z.object({ ref: z.string().trim().min(1).max(255).regex(/^[a-zA-Z0-9._:/@-]+$/) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Enter a valid image reference (e.g. nginx:latest)." });
    pullImage(parsed.data.ref);
    return { ok: true };
  });

  // ---- Networks -------------------------------------------------------------

  // Reading the list lives on /vms/networks, which returns libvirt's and
  // Docker's together; creating and removing is per-daemon and belongs here.

  app.post("/networks", async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().trim().regex(NET_NAME_RE),
        subnet: z.string().trim().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Use a simple name (letters, digits, dash, underscore)." });
    }
    req.audit({ network: parsed.data.name });
    const res = await createDockerNetwork(parsed.data.name, parsed.data.subnet);
    if (!res.ok) {
      return reply
        .code(res.invalid ? 400 : 502)
        .send({ error: res.invalid ? "invalid" : "failed", message: res.error ?? "Could not create the network." });
    }
    return reply.code(201).send({ ok: true });
  });

  app.delete("/networks/:name", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!NET_NAME_RE.test(name)) return reply.code(400).send({ error: "invalid", message: "Invalid network name." });
    req.audit({ network: name });
    const res = await removeDockerNetwork(name);
    if (!res.ok) {
      return reply
        .code(res.invalid ? 400 : 502)
        .send({ error: res.invalid ? "invalid" : "failed", message: res.error ?? "Could not remove the network." });
    }
    return { ok: true };
  });

  // ---- Private registries -------------------------------------------------
  //
  // OpenNAS keeps the host and username; the password goes straight to
  // `docker login`, which owns the credential store. Nothing here can replay a
  // password, because nothing here has one.

  app.get("/registries", async (): Promise<RegistriesResponse> => ({
    registries: await refreshStatus(),
    dockerAvailable: await dockerRunning(),
  }));

  app.post("/registries", async (req, reply): Promise<RegistriesResponse | undefined> => {
    const parsed = z
      .object({
        host: z.string().trim().min(1).max(253),
        username: z.string().trim().min(1).max(128),
        password: z.string().min(1).max(1024),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide a registry host, username and password." }) as never;
    if (!isValidRegistryHost(parsed.data.host)) {
      return reply.code(400).send({
        error: "bad_host",
        message: 'Use a registry hostname such as "registry.example.com:5000", or "docker.io" for Docker Hub - not a URL.',
      }) as never;
    }
    if (!(await dockerRunning())) {
      return reply.code(400).send({ error: "no_docker", message: "Docker isn't running, so there's nothing to sign in with." }) as never;
    }
    if (listRegistries().length >= MAX_REGISTRIES && !listRegistries().some((r) => r.host === parsed.data.host)) {
      return reply.code(400).send({ error: "too_many", message: `At most ${MAX_REGISTRIES} registries.` }) as never;
    }

    // Audited without the body: the password is in it, and this route's shape
    // is fixed so there is nothing else worth recording from it.
    req.audit({ host: parsed.data.host, username: parsed.data.username });
    const res = await dockerLogin(parsed.data.host, parsed.data.username, parsed.data.password);
    if (!res.ok) return reply.code(401).send({ error: "login_failed", message: res.error ?? "Sign-in failed." }) as never;

    upsertRegistry({
      host: parsed.data.host,
      username: parsed.data.username,
      loggedIn: true,
      lastLoginAt: new Date().toISOString(),
    });
    return { registries: await refreshStatus(), dockerAvailable: true };
  });

  app.delete("/registries/:host", async (req, reply): Promise<RegistriesResponse | undefined> => {
    const host = decodeURIComponent((req.params as { host: string }).host);
    if (!isValidRegistryHost(host)) return reply.code(400).send({ error: "invalid", message: "Invalid registry host." }) as never;
    req.audit({ host });
    await dockerLogout(host);
    removeRegistry(host);
    return { registries: await refreshStatus(), dockerAvailable: await dockerRunning() };
  });

  app.get("/:id/logs", async (req): Promise<{ lines: string[] }> => {
    const id = (req.params as { id: string }).id;
    const tail = Number((req.query as { tail?: string }).tail) || 200;
    return { lines: await containerLogs(id, tail) };
  });

  app.get("/:id/stats", async (req): Promise<ContainerStatsResponse> => {
    const id = (req.params as { id: string }).id;
    return { stats: await containerStats(id) };
  });

  // ---- Compose stacks --------------------------------------------------
  app.get("/stacks", async (): Promise<StacksResponse> => ({ stacks: await listStacks() }));

  app.get("/stacks/:name", async (req, reply): Promise<StackComposeResponse> => {
    const compose = await getStackCompose((req.params as { name: string }).name);
    if (compose == null) return reply.code(404).send({ error: "not_found", message: "Stack not found." }) as never;
    return { compose };
  });

  app.post("/stacks", async (req, reply) => {
    const parsed = z.object({
      name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "use lowercase letters, digits, '-' or '_'"),
      compose: z.string().min(1).max(256 * 1024),
      volume: z.string().max(32).regex(/^[a-zA-Z0-9_-]*$/).nullish(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide a valid stack name (lowercase letters, digits, '-' '_') and a compose file." });
    const res = await createStack(parsed.data.name, parsed.data.compose, parsed.data.volume);
    if (!res.ok) return reply.code(502).send({ error: "compose_failed", message: res.error ?? "Could not start the stack." });
    return { ok: true };
  });

  app.post("/stacks/:name/:action", async (req, reply) => {
    const { name, action } = req.params as { name: string; action: string };
    if (action !== "up" && action !== "down") return reply.code(400).send({ error: "invalid", message: "Use up or down." });
    const res = await (action === "up" ? composeUp(name) : composeDown(name));
    if (!res.ok) return reply.code(502).send({ error: "failed", message: res.error ?? "Action failed." });
    return { ok: true };
  });

  app.delete("/stacks/:name", async (req) => {
    await removeStack((req.params as { name: string }).name);
    return { ok: true };
  });

  // NOTE: keep the parametric container action LAST so /stacks/... matches first.
  app.post("/:id/:action", async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!ACTIONS.includes(action as ContainerAction)) {
      return reply.code(400).send({ error: "invalid", message: "Unknown action." });
    }
    const res = await containerAction(id, action as ContainerAction);
    if (!res.ok) return reply.code(500).send({ error: "failed", message: res.error ?? "Action failed." });
    return { ok: true };
  });
}
