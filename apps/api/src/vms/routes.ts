import { createWriteStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  NET_NAME_RE,
  createVirtNetwork,
  hostBridges,
  listDockerNetworks,
  listVirtNetworks,
  removeVirtNetwork,
} from "../system/netvirt.js";
import type {
  HostDevicesResponse,
  IsoFile,
  IsosResponse,
  NetworksResponse,
  VmDevicesResponse,
  VmSnapshotsResponse,
  VmsResponse,
} from "@opennas/shared";
import {
  attachDevice,
  attachedDevices,
  detachDevice,
  listPciDevices,
  listUsbDevices,
  passthroughStatus,
} from "../system/passthrough.js";
import { requireAdmin } from "../auth/plugin.js";
import { isoDir } from "../system/storage-paths.js";
import {
  VM_NAME_RE,
  createSnapshot,
  createVm,
  deleteSnapshot,
  deleteVm,
  getVirt,
  listSnapshots,
  revertSnapshot,
  setAutostart,
  vmAction,
} from "../system/virt.js";

const ACTIONS = ["start", "shutdown", "reboot", "destroy", "suspend", "resume"] as const;

const ISO_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,127}\.iso$/i;

const createSchema = z.object({
  name: z.string().regex(VM_NAME_RE, "letters, digits, '-' or '_' (max 40)"),
  vcpus: z.number().int().min(1).max(64),
  memoryMiB: z.number().int().min(256).max(512 * 1024),
  diskGiB: z.number().int().min(1).max(8192),
  iso: z.string().max(255).nullish(),
  volume: z.string().max(32).regex(/^[a-zA-Z0-9_-]*$/).nullish(),
  // A libvirt network name, or a host bridge when networkIsBridge is set.
  network: z.string().max(32).regex(/^[a-zA-Z0-9_-]*$/).nullish(),
  networkIsBridge: z.boolean().optional(),
});

async function listIsos(): Promise<IsoFile[]> {
  const dir = isoDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const isos: IsoFile[] = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".iso")) continue;
    try {
      const s = await stat(resolve(dir, name));
      if (s.isFile()) isos.push({ name, sizeBytes: s.size });
    } catch {
      /* skip unreadable entry */
    }
  }
  return isos.sort((a, b) => a.name.localeCompare(b.name));
}

export async function vmRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  app.get("/", async (): Promise<VmsResponse> => ({ virt: await getVirt() }));

  app.post("/", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Provide a valid VM name, CPU, memory and disk size." });
    }
    const res = await createVm({
      ...parsed.data,
      iso: parsed.data.iso ?? null,
      volume: parsed.data.volume ?? null,
      network: parsed.data.network ?? null,
      networkIsBridge: parsed.data.networkIsBridge === true,
    });
    if (!res.ok) return reply.code(502).send({ error: "create_failed", message: res.error ?? "Could not create the VM." });
    return reply.code(201).send({ ok: true, warning: res.error });
  });

  // ---- Virtual networks ---------------------------------------------------
  //
  // NAT and isolated networks are created here; host bridges are only ever
  // *listed*. Building a bridge re-plumbs the host's own NIC, and getting that
  // wrong takes the NAS off the network with no web UI left to fix it from -
  // so an admin who wants one makes it themselves, and OpenNAS will attach
  // guests to it.

  app.get("/networks", async (): Promise<NetworksResponse> => {
    const [virt, docker, bridges] = await Promise.all([
      listVirtNetworks(),
      listDockerNetworks(),
      hostBridges(),
    ]);
    return {
      virt,
      docker,
      hostBridges: bridges,
      virtAvailable: (await getVirt()).running,
      dockerAvailable: docker.length > 0,
    };
  });

  app.post("/networks", async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().trim().regex(NET_NAME_RE),
        mode: z.enum(["nat", "isolated"]),
        subnet: z.string().trim().min(9).max(18),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Give the network a simple name, a mode and a /24 subnet." });
    }
    req.audit({ name: parsed.data.name, mode: parsed.data.mode, subnet: parsed.data.subnet });
    const res = await createVirtNetwork(parsed.data);
    if (!res.ok) {
      // A rejected subnet or a duplicate name is the caller's to fix; only a
      // genuine libvirt failure is a 502.
      return reply
        .code(res.invalid ? 400 : 502)
        .send({ error: res.invalid ? "invalid" : "create_failed", message: res.error ?? "Could not create the network." });
    }
    return reply.code(201).send({ ok: true, warning: res.error });
  });

  app.delete("/networks/:name", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!NET_NAME_RE.test(name)) return reply.code(400).send({ error: "invalid", message: "Invalid network name." });
    req.audit({ name });
    const res = await removeVirtNetwork(name);
    if (!res.ok) {
      return reply
        .code(res.invalid ? 400 : 502)
        .send({ error: res.invalid ? "invalid" : "failed", message: res.error ?? "Could not remove the network." });
    }
    return { ok: true };
  });

  // ---- Snapshots ------------------------------------------------------------

  app.get("/:name/snapshots", async (req, reply): Promise<VmSnapshotsResponse | undefined> => {
    const name = (req.params as { name: string }).name;
    if (!VM_NAME_RE.test(name)) return reply.code(400).send({ error: "invalid", message: "Invalid VM name." }) as never;
    return { snapshots: await listSnapshots(name) };
  });

  app.post("/:name/snapshots", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!VM_NAME_RE.test(name)) return reply.code(400).send({ error: "invalid", message: "Invalid VM name." });
    const parsed = z
      .object({ snapshot: z.string().trim().regex(VM_NAME_RE), description: z.string().trim().max(200).optional() })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Give the snapshot a simple name (letters, digits, dash, underscore)." });
    }
    req.audit({ vm: name, snapshot: parsed.data.snapshot });
    const res = await createSnapshot(name, parsed.data.snapshot, parsed.data.description ?? "");
    if (!res.ok) return reply.code(502).send({ error: "failed", message: res.error ?? "Could not take the snapshot." });
    return reply.code(201).send({ ok: true });
  });

  app.post("/:name/snapshots/:snapshot/revert", async (req, reply) => {
    const { name, snapshot } = req.params as { name: string; snapshot: string };
    if (!VM_NAME_RE.test(name) || !VM_NAME_RE.test(snapshot)) {
      return reply.code(400).send({ error: "invalid", message: "Invalid name." });
    }
    req.audit({ vm: name, snapshot });
    const res = await revertSnapshot(name, snapshot);
    if (!res.ok) return reply.code(502).send({ error: "failed", message: res.error ?? "Could not revert." });
    return { ok: true };
  });

  app.delete("/:name/snapshots/:snapshot", async (req, reply) => {
    const { name, snapshot } = req.params as { name: string; snapshot: string };
    if (!VM_NAME_RE.test(name) || !VM_NAME_RE.test(snapshot)) {
      return reply.code(400).send({ error: "invalid", message: "Invalid name." });
    }
    req.audit({ vm: name, snapshot });
    const res = await deleteSnapshot(name, snapshot);
    if (!res.ok) return reply.code(502).send({ error: "failed", message: res.error ?? "Could not delete the snapshot." });
    return { ok: true };
  });

  // ---- Device passthrough ---------------------------------------------------

  // Listing is split from attaching on purpose: the list is what tells an admin
  // which devices are safe, and it refuses to mark the host's own disk
  // controller or live NIC eligible no matter what is asked for afterwards.

  app.get("/host-devices", async (): Promise<HostDevicesResponse> => {
    const [status, pci, usb] = await Promise.all([passthroughStatus(), listPciDevices(), listUsbDevices()]);
    return { status, pci, usb };
  });

  app.get("/:name/devices", async (req, reply): Promise<VmDevicesResponse | undefined> => {
    const name = (req.params as { name: string }).name;
    if (!VM_NAME_RE.test(name)) return reply.code(400).send({ error: "invalid", message: "Invalid VM name." }) as never;
    return { attached: await attachedDevices(name) };
  });

  app.post("/:name/devices", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!VM_NAME_RE.test(name)) return reply.code(400).send({ error: "invalid", message: "Invalid VM name." });
    const parsed = z
      .object({ kind: z.enum(["pci", "usb"]), id: z.string().trim().min(1).max(64) })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Pick a device to pass through." });

    // The device is re-resolved from the live host list rather than trusted from
    // the request, so eligibility is decided here and not by the caller.
    const devices = parsed.data.kind === "pci" ? await listPciDevices() : await listUsbDevices();
    const device = devices.find((d) => d.id.toLowerCase() === parsed.data.id.toLowerCase());
    if (!device) return reply.code(404).send({ error: "not_found", message: "No such device on this host." });
    if (!device.eligible) {
      return reply.code(409).send({ error: "ineligible", message: device.reason || "That device can't be passed through." });
    }

    req.audit({ vm: name, device: device.id, kind: device.kind });
    const res = await attachDevice(name, device);
    if (!res.ok) return reply.code(502).send({ error: "failed", message: res.error ?? "Could not attach the device." });
    return reply.code(201).send({ ok: true });
  });

  app.delete("/:name/devices/:kind/:id", async (req, reply) => {
    const { name, kind, id } = req.params as { name: string; kind: string; id: string };
    if (!VM_NAME_RE.test(name)) return reply.code(400).send({ error: "invalid", message: "Invalid VM name." });
    if (kind !== "pci" && kind !== "usb") return reply.code(400).send({ error: "invalid", message: "Unknown device kind." });

    // Detaching is always allowed, whatever the device is: an admin must be able
    // to undo a passthrough that is keeping a VM from starting.
    const attached = (await attachedDevices(name)).find(
      (d) => d.kind === kind && d.id.toLowerCase() === decodeURIComponent(id).toLowerCase(),
    );
    if (!attached) return reply.code(404).send({ error: "not_found", message: "That device isn't attached to this VM." });

    req.audit({ vm: name, device: attached.id, kind });
    const res = await detachDevice(name, attached);
    if (!res.ok) return reply.code(502).send({ error: "failed", message: res.error ?? "Could not detach the device." });
    return { ok: true };
  });

  // ---- ISO library -------------------------------------------------------
  app.get("/isos", async (): Promise<IsosResponse> => ({ isos: await listIsos() }));

  app.post("/isos", async (req, reply) => {
    const part = await req.file({ limits: { fileSize: 12 * 1024 * 1024 * 1024 } }).catch(() => null);
    if (!part) return reply.code(400).send({ error: "no_file", message: "Upload an .iso image." });
    const name = part.filename ?? "";
    if (!ISO_NAME_RE.test(name)) {
      part.file.resume(); // drain so the request completes
      return reply.code(400).send({ error: "bad_name", message: "File must be a .iso with a simple name." });
    }
    const dest = resolve(isoDir(), name);
    try {
      await pipeline(part.file, createWriteStream(dest));
    } catch {
      await rm(dest, { force: true });
      return reply.code(500).send({ error: "write_failed", message: "Could not save the ISO." });
    }
    if (part.file.truncated) {
      await rm(dest, { force: true });
      return reply.code(413).send({ error: "too_large", message: "That ISO is too large." });
    }
    return reply.code(201).send({ ok: true });
  });

  app.delete("/isos/:name", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!ISO_NAME_RE.test(name)) return reply.code(400).send({ error: "invalid", message: "Invalid ISO name." });
    await rm(resolve(isoDir(), name), { force: true });
    return { ok: true };
  });

  app.patch("/:name/autostart", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide enabled: true|false." });
    const res = await setAutostart(name, parsed.data.enabled);
    if (!res.ok) return reply.code(502).send({ error: "failed", message: res.error ?? "Could not update autostart." });
    return { ok: true };
  });

  app.delete("/:name", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!VM_NAME_RE.test(name)) return reply.code(400).send({ error: "invalid", message: "Invalid VM name." });
    const removeDisk = (req.query as { disk?: string }).disk === "1";
    const res = await deleteVm(name, removeDisk);
    if (!res.ok) return reply.code(502).send({ error: "failed", message: res.error ?? "Could not delete the VM." });
    return { ok: true };
  });

  // NOTE: keep the parametric action route LAST so /isos and /:name/autostart
  // (static + more-specific segments) win against /:name/:action.
  app.post("/:name/:action", async (req, reply) => {
    const { name, action } = req.params as { name: string; action: string };
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
      return reply.code(400).send({ error: "invalid", message: "Unknown action." });
    }
    const res = await vmAction(name, action as (typeof ACTIONS)[number]);
    if (!res.ok) return reply.code(502).send({ error: "failed", message: res.error ?? "Action failed." });
    return { ok: true };
  });
}
