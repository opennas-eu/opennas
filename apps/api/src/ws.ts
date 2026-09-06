import { connect } from "node:net";
import type { FastifyInstance } from "fastify";
import type { ServerMessage, SystemSample } from "@opennas/shared";
import { getStaticInfo, sample } from "./system/collector.js";
import { getVm, VM_NAME_RE } from "./system/virt.js";
import { subscribeUser } from "./notifications/hub.js";

/**
 * One sampling loop shared by all connected clients. It only runs while at
 * least one subscriber is listening, so an idle desktop costs nothing.
 */
class SystemBroadcaster {
  private listeners = new Set<(s: SystemSample) => void>();
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs = 1000;
  private sampling = false;

  subscribe(fn: (s: SystemSample) => void): () => void {
    this.listeners.add(fn);
    this.ensureRunning();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private ensureRunning(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Don't let this loop keep the process alive on shutdown.
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.sampling || this.listeners.size === 0) return;
    this.sampling = true;
    try {
      const s = await sample();
      for (const fn of this.listeners) fn(s);
    } catch {
      /* transient sampling error - skip this tick */
    } finally {
      this.sampling = false;
    }
  }
}

const broadcaster = new SystemBroadcaster();

export async function websocketRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, (socket, req) => {
    // The auth onRequest hook runs for the upgrade request too.
    if (!req.auth) {
      send(socket, { type: "error", message: "Authentication required." });
      socket.close(1008, "unauthorized");
      return;
    }

    let unsubscribe: (() => void) | null = null;

    // Live notification delivery for this user, independent of the telemetry
    // subscription - the desktop should hear about a failing disk whether or not
    // it happens to be watching the system charts.
    const unsubscribeNotifications = subscribeUser(req.auth.user.id, (msg) => send(socket, msg));

    const startStreaming = async () => {
      if (unsubscribe) return;
      try {
        send(socket, { type: "hello", info: await getStaticInfo() });
      } catch {
        /* ignore - client may have closed */
      }
      unsubscribe = broadcaster.subscribe((s) => send(socket, { type: "sample", sample: s }));
    };

    socket.on("message", (raw: Buffer) => {
      let msg: { type?: string; channel?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "subscribe" && msg.channel === "system") void startStreaming();
      else if (msg.type === "unsubscribe" && msg.channel === "system") {
        unsubscribe?.();
        unsubscribe = null;
      }
    });

    // Auto-start so the simple client doesn't even need to send subscribe.
    void startStreaming();

    const teardown = () => {
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeNotifications();
    };
    socket.on("close", teardown);
    socket.on("error", teardown);
  });

  // ---- VM console: WebSocket ⇄ VNC TCP proxy (noVNC) ----------------------
  // noVNC speaks the raw RFB protocol over a binary WebSocket; this route is a
  // websockify-style byte bridge between the browser and the VM's VNC server.
  // The VNC port is bound to 127.0.0.1 (see the libvirt domain XML), so the
  // console is only reachable through this admin-gated, loopback proxy - never
  // exposed on the network. Admin-only (a VM console is full control of the guest).
  app.get("/vms/:name/console", { websocket: true }, async (socket, req) => {
    if (!req.auth || req.auth.user.role !== "admin") {
      socket.close(1008, "unauthorized");
      return;
    }
    const name = (req.params as { name: string }).name;
    if (!VM_NAME_RE.test(name)) {
      socket.close(1008, "invalid vm");
      return;
    }

    const vm = await getVm(name);
    if (socket.readyState !== 1) return; // client gave up during the lookup
    if (!vm || vm.state !== "running" || !vm.vncPort) {
      socket.close(1011, "no console available");
      return;
    }

    // Connect to the guest's loopback VNC port. Writes before 'connect' are
    // queued by Node, so we can wire the bridge immediately.
    const tcp = connect(vm.vncPort, "127.0.0.1");
    const closeAll = () => {
      tcp.destroy();
      try {
        if (socket.readyState === 1) socket.close();
      } catch {
        /* already closing */
      }
    };

    tcp.on("data", (chunk: Buffer) => {
      if (socket.readyState === 1) socket.send(chunk);
    });
    tcp.on("error", () => {
      if (socket.readyState === 1) socket.close(1011, "vnc unreachable");
    });
    tcp.on("close", closeAll);

    socket.on("message", (data: Buffer) => tcp.write(data));
    socket.on("close", () => tcp.destroy());
    socket.on("error", closeAll);
  });
}

function send(socket: { readyState: number; send: (data: string) => void }, msg: ServerMessage): void {
  // 1 === OPEN
  if (socket.readyState === 1) socket.send(JSON.stringify(msg));
}
