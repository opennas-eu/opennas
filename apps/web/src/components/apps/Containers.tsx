import { useCallback, useEffect, useState } from "react";
import { clsx } from "clsx";
import {
  Boxes,
  Container as ContainerIcon,
  Cpu,
  Download,
  Layers,
  MemoryStick,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { ContainerInfo, ContainerStats, ContainersResponse, DockerImage, DockerNetwork, ImagesResponse, NetworksResponse, StackInfo, StacksResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../lib/api.ts";
import { useNotifications } from "../../store/notifications.ts";
import { confirmDialog } from "../../store/dialogs.ts";
import { Button, Input, Select } from "../ui/controls.tsx";
import { StorageTargetField } from "../ui/StorageTargetField.tsx";
import { DockerNetworks } from "./vms/VirtNetworks.tsx";
import { Registries } from "./containers/Registries.tsx";

export function Containers() {
  const [data, setData] = useState<ContainersResponse["docker"] | null>(null);
  const [images, setImages] = useState<DockerImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<Record<string, ContainerStats>>({});
  const [logsFor, setLogsFor] = useState<ContainerInfo | null>(null);
  const [pullRef, setPullRef] = useState("");
  const [stacks, setStacks] = useState<StackInfo[]>([]);
  const [showStackForm, setShowStackForm] = useState(false);
  const [showRun, setShowRun] = useState(false);
  const push = useNotifications((s) => s.push);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<ContainersResponse>("/containers");
      setData(res.docker);
      if (res.docker.running) {
        const [img, stk] = await Promise.all([
          api.get<ImagesResponse>("/containers/images").catch(() => ({ images: [] })),
          api.get<StacksResponse>("/containers/stacks").catch(() => ({ stacks: [] })),
        ]);
        setImages(img.images);
        setStacks(stk.stacks);
        // Live stats for running containers (best-effort, in parallel).
        const running = res.docker.containers.filter((c) => c.state === "running");
        const entries = await Promise.all(
          running.map(async (c) => [c.id, (await api.get<{ stats: ContainerStats | null }>(`/containers/${c.id}/stats`).catch(() => ({ stats: null }))).stats] as const),
        );
        setStats(Object.fromEntries(entries.filter(([, s]) => s)) as Record<string, ContainerStats>);
      }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(c: ContainerInfo, action: "start" | "stop" | "restart" | "remove") {
    if (action === "remove" && !(await confirmDialog({ title: `Remove "${c.name}"?`, message: "The container is deleted (its image stays).", confirmLabel: "Remove", danger: true }))) return;
    try {
      await api.post(`/containers/${c.id}/${action}`);
      push({ level: "success", title: `Container ${action === "remove" ? "removed" : action + "ed"}`, body: c.name });
      await load();
    } catch (err) {
      push({ level: "warning", title: `Couldn't ${action}`, body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  async function startDaemon() {
    try {
      await api.post("/containers/start-daemon");
      push({ level: "info", title: "Starting Docker..." });
      setTimeout(() => void load(), 1500);
    } catch (err) {
      push({ level: "warning", title: "Couldn't start Docker", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  async function pull() {
    const ref = pullRef.trim();
    if (!ref) return;
    try {
      await api.post("/containers/images/pull", { ref });
      push({ level: "info", title: "Pulling image...", body: `${ref} will appear when the download finishes.` });
      setPullRef("");
    } catch (err) {
      push({ level: "warning", title: "Pull failed", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  async function stackAction(name: string, action: "up" | "down") {
    try {
      await api.post(`/containers/stacks/${name}/${action}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: `Couldn't bring stack ${action}`, body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  async function removeStack(s: StackInfo) {
    if (!(await confirmDialog({ title: `Remove stack "${s.name}"?`, message: "The stack is brought down and its compose file deleted.", confirmLabel: "Remove", danger: true }))) return;
    try {
      await api.del(`/containers/stacks/${s.name}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't remove stack", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex items-center gap-2 border-b border-slate-200 px-5 py-3">
        <Boxes size={20} className="text-ink-soft" />
        <h2 className="flex-1 font-semibold text-ink">Containers</h2>
        <button onClick={() => void load()} className="grid h-9 w-9 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100" title="Refresh">
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </header>

      <div className="opennas-scroll min-h-0 flex-1 overflow-auto p-5">
        {data === null ? (
          <p className="text-sm text-ink-faint">Loading...</p>
        ) : !data.available ? (
          <Notice title="Docker isn't installed" body="Needs Docker. The OpenNAS installer sets this up; on a manual install, add the opennas user to the docker group." />
        ) : !data.running ? (
          <Notice title="Docker isn't running" body="Docker is installed but the daemon isn't running.">
            <Button className="mt-3 h-9" onClick={startDaemon}><Play size={15} /> Start Docker</Button>
          </Notice>
        ) : (
          <div className="space-y-6">
            <section>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="flex-1 text-sm font-semibold text-ink-soft">Containers ({data.containers.length})</h3>
                <Button variant="secondary" className="h-8 px-2.5 text-xs" onClick={() => setShowRun((v) => !v)}><Plus size={14} /> Run container</Button>
              </div>
              {showRun && <RunContainerForm onDone={() => { setShowRun(false); void load(); }} onError={(m) => push({ level: "warning", title: "Couldn't run container", body: m })} />}
              {data.containers.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-ink-faint">No containers yet. Pull an image below, then run one from the host (or via Package Center services).</p>
              ) : (
                <div className="space-y-2">
                  {data.containers.map((c) => (
                    <ContainerCard key={c.id} c={c} stats={stats[c.id]} onAction={act} onLogs={() => setLogsFor(c)} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-ink-soft">Images</h3>
              <div className="mb-2 flex gap-2">
                <Input value={pullRef} onChange={(e) => setPullRef(e.target.value)} onKeyDown={(e) => e.key === "Enter" && pull()} placeholder="Pull an image, e.g. nginx:latest" />
                <Button className="h-[42px] shrink-0" onClick={pull} disabled={!pullRef.trim()}><Download size={15} /> Pull</Button>
              </div>
              {images.length === 0 ? (
                <p className="text-sm text-ink-faint">No images.</p>
              ) : (
                <div className="space-y-1">
                  {images.map((img) => (
                    <div key={img.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs ring-1 ring-slate-200/70">
                      <ContainerIcon size={13} className="shrink-0 text-ink-faint" />
                      <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{img.ref}</span>
                      <span className="shrink-0 text-ink-faint">{img.size} - {img.created}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft"><Layers size={15} /> Compose stacks</h3>
                <span className="flex-1" />
                <Button variant="secondary" className="h-8 px-2.5 text-xs" onClick={() => setShowStackForm((v) => !v)}><Plus size={14} /> New stack</Button>
              </div>
              {showStackForm && <StackForm onDone={() => { setShowStackForm(false); void load(); }} onError={(m) => push({ level: "warning", title: "Stack failed", body: m })} />}
              {stacks.length === 0 ? (
                <p className="text-sm text-ink-faint">No stacks. Import a <code className="rounded bg-slate-100 px-1 text-xs">docker-compose.yml</code> above.</p>
              ) : (
                <div className="space-y-1.5">
                  {stacks.map((s) => (
                    <div key={s.name} className="flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200/70">
                      <Layers size={15} className="shrink-0 text-ink-faint" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-ink-soft">{s.name}</div>
                        <div className="text-xs text-ink-faint">{s.running}/{s.services} running</div>
                      </div>
                      {s.running > 0 ? (
                        <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => void stackAction(s.name, "down")}><Square size={13} /> Down</Button>
                      ) : (
                        <Button variant="ghost" className="h-7 px-2 text-xs text-emerald-700" onClick={() => void stackAction(s.name, "up")}><Play size={13} /> Up</Button>
                      )}
                      <button onClick={() => void removeStack(s)} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition hover:bg-rose-500 hover:text-white" title="Remove stack"><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <DockerNetworks />

            <Registries />
          </div>
        )}
      </div>

      {logsFor && <LogsModal container={logsFor} onClose={() => setLogsFor(null)} />}
    </div>
  );
}

function ContainerCard({ c, stats, onAction, onLogs }: { c: ContainerInfo; stats?: ContainerStats; onAction: (c: ContainerInfo, a: "start" | "stop" | "restart" | "remove") => void; onLogs: () => void }) {
  const running = c.state === "running";
  return (
    <div className="rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
      <div className="flex items-center gap-3">
        <span className={clsx("h-2.5 w-2.5 shrink-0 rounded-full", running ? "bg-emerald-500" : c.state === "exited" ? "bg-slate-400" : "bg-amber-500")} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-ink-soft">{c.name}</span>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium capitalize text-ink-soft">{c.state}</span>
          </div>
          <div className="truncate text-xs text-ink-faint">{c.image} - {c.status}{c.ports ? ` - ${c.ports}` : ""}</div>
          {stats && (
            <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-ink-faint">
              <span className="inline-flex items-center gap-1"><Cpu size={11} /> {stats.cpu}</span>
              <span className="inline-flex items-center gap-1"><MemoryStick size={11} /> {stats.mem}</span>
              <span>net {stats.netIO}</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {running ? (
            <>
              <IconBtn label="Restart" onClick={() => onAction(c, "restart")}><RotateCcw size={15} /></IconBtn>
              <IconBtn label="Stop" onClick={() => onAction(c, "stop")}><Square size={15} /></IconBtn>
            </>
          ) : (
            <IconBtn label="Start" onClick={() => onAction(c, "start")}><Play size={15} /></IconBtn>
          )}
          <IconBtn label="Logs" onClick={onLogs}><ScrollText size={15} /></IconBtn>
          <IconBtn label="Remove" danger onClick={() => onAction(c, "remove")}><Trash2 size={15} /></IconBtn>
        </div>
      </div>
    </div>
  );
}

function IconBtn({ children, onClick, label, danger }: { children: React.ReactNode; onClick: () => void; label: string; danger?: boolean }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className={clsx("grid h-7 w-7 place-items-center rounded-md text-slate-400 transition", danger ? "hover:bg-rose-500 hover:text-white" : "hover:bg-slate-200 hover:text-ink-soft")}>
      {children}
    </button>
  );
}

function LogsModal({ container, onClose }: { container: ContainerInfo; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    void api.get<{ lines: string[] }>(`/containers/${container.id}/logs?tail=500`).then((r) => setLines(r.lines)).catch(() => setLines([]));
  }, [container.id]);
  return (
    <div className="animate-fade-in absolute inset-0 z-30 flex flex-col bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mx-auto flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10">
        <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3">
          <ScrollText size={18} className="text-ink-soft" />
          <h2 className="flex-1 truncate font-semibold text-ink">Logs - {container.name}</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-slate-100" title="Close"><X size={18} /></button>
        </div>
        <div className="opennas-scroll min-h-0 flex-1 overflow-auto bg-slate-900 p-3">
          {lines === null ? <p className="p-4 text-center text-sm text-slate-400">Loading...</p> : lines.length === 0 ? <p className="p-4 text-center text-sm text-slate-400">No log output.</p> : (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-100">{lines.join("\n")}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

function StackForm({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState("");
  const [yaml, setYaml] = useState("");
  const [volume, setVolume] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await api.post("/containers/stacks", { name: name.trim(), compose: yaml, volume: volume || null });
      onDone();
    } catch (err) {
      onError(err instanceof ApiRequestError ? err.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3 space-y-2 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Stack name (e.g. my-blog)" />
      <textarea
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        rows={8}
        placeholder={"services:\n  web:\n    image: nginx\n    ports:\n      - 8090:80"}
        className="opennas-scroll w-full resize-y rounded-lg bg-white p-3 font-mono text-xs text-ink shadow-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      <StorageTargetField
        value={volume}
        onChange={setVolume}
        label="Store the stack on"
        hint="Where the compose file and any relative bind-mounts live."
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" className="h-8 text-xs" onClick={onDone}>Cancel</Button>
        <Button className="h-8 text-xs" loading={busy} disabled={!name.trim() || !yaml.trim()} onClick={create}>Create &amp; start</Button>
      </div>
    </div>
  );
}

function parsePorts(s: string): { host: number; container: number; proto?: "udp" }[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean).map((tok) => {
    const [hostC = "", proto] = tok.split("/");
    const [h = "", c = ""] = hostC.split(":");
    return { host: Number(h), container: Number(c || h), proto: proto === "udp" ? ("udp" as const) : undefined };
  }).filter((p) => p.host > 0 && p.container > 0);
}
function parseVolumes(s: string): { host: string; container: string }[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean).map((tok) => {
    const i = tok.indexOf(":");
    return { host: tok.slice(0, i).trim(), container: tok.slice(i + 1).trim() };
  }).filter((v) => v.host && v.container);
}
function parseEnv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function RunContainerForm({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [ports, setPorts] = useState("");
  const [volumes, setVolumes] = useState("");
  const [env, setEnv] = useState("");
  const [restart, setRestart] = useState("unless-stopped");
  const [cpus, setCpus] = useState("");
  const [memory, setMemory] = useState("");
  const [network, setNetwork] = useState("");
  const [networks, setNetworks] = useState<DockerNetwork[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Only the user-defined ones: joining Docker's built-in bridge is the
    // default anyway, and "host" is a footgun to offer from a dropdown.
    void api
      .get<NetworksResponse>("/vms/networks")
      .then((r) => setNetworks(r.docker.filter((n) => !n.builtin)))
      .catch(() => setNetworks([]));
  }, []);

  async function run() {
    setBusy(true);
    try {
      await api.post("/containers/run", {
        name: name.trim(),
        image: image.trim(),
        ports: parsePorts(ports),
        volumes: parseVolumes(volumes),
        env: parseEnv(env),
        restart,
        cpus: cpus.trim() || undefined,
        memory: memory.trim() || undefined,
        network: network || undefined,
      });
      onDone();
    } catch (err) {
      onError(err instanceof ApiRequestError ? err.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full rounded-lg bg-white px-3 py-2 text-sm text-ink shadow-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500";

  return (
    <div className="mb-3 space-y-2.5 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-soft">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-soft">Image</label>
          <Input value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:latest" />
        </div>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-soft">Ports <span className="text-ink-faint">(host:container, comma-sep)</span></label>
          <Input value={ports} onChange={(e) => setPorts(e.target.value)} placeholder="8080:80, 53:53/udp" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-soft">Volumes <span className="text-ink-faint">(/host:/container)</span></label>
          <Input value={volumes} onChange={(e) => setVolumes(e.target.value)} placeholder="/srv/data:/data" />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-soft">Environment <span className="text-ink-faint">(KEY=value per line)</span></label>
        <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={2} placeholder={"TZ=UTC\nPUID=1000"} className={`${field} resize-y font-mono`} />
      </div>
      <div className="grid gap-2.5 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-soft">Restart policy</label>
          <Select value={restart} onChange={(e) => setRestart(e.target.value)} className="w-full">
            <option value="unless-stopped">unless-stopped</option>
            <option value="always">always</option>
            <option value="on-failure">on-failure</option>
            <option value="no">no</option>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-soft">CPU limit <span className="text-ink-faint">(cores)</span></label>
          <Input value={cpus} onChange={(e) => setCpus(e.target.value)} placeholder="1.5" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-soft">Memory limit</label>
          <Input value={memory} onChange={(e) => setMemory(e.target.value)} placeholder="512m" />
        </div>
      </div>
      {networks.length > 0 && (
        <div className="sm:max-w-xs">
          <label className="mb-1 block text-xs font-medium text-ink-soft">Network</label>
          <Select value={network} onChange={(e) => setNetwork(e.target.value)} className="w-full">
            <option value="">Default bridge</option>
            {networks.map((n) => <option key={n.id} value={n.name}>{n.name}</option>)}
          </Select>
          <p className="mt-1 text-[11px] text-ink-faint">
            Containers on the same network can connect to each other by name, for example when an app connects to its database.
          </p>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" className="h-8 text-xs" onClick={onDone}>Cancel</Button>
        <Button className="h-8 text-xs" loading={busy} disabled={!name.trim() || !image.trim()} onClick={run}>Run container</Button>
      </div>
    </div>
  );
}

function Notice({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md rounded-2xl bg-slate-50 p-8 text-center ring-1 ring-slate-200/70">
      <ContainerIcon size={32} className="mx-auto mb-3 text-slate-300" />
      <h3 className="font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-sm text-ink-faint">{body}</p>
      {children}
    </div>
  );
}
