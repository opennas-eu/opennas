import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { ArrowDown, ArrowUp, Ban, RefreshCw, Search } from "lucide-react";
import type { ProcessInfo, ProcessListResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../lib/api.ts";
import { useNotifications } from "../../store/notifications.ts";
import { confirmDialog } from "../../store/dialogs.ts";
import { formatBytes } from "../../lib/format.ts";
import { Input } from "../ui/controls.tsx";

type SortKey = "cpu" | "memBytes" | "name" | "pid";

export function TaskManager() {
  const [data, setData] = useState<ProcessListResponse | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [asc, setAsc] = useState(false);
  const [query, setQuery] = useState("");
  const [killing, setKilling] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const push = useNotifications((s) => s.push);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const load = useCallback(async () => {
    try {
      setData(await api.get<ProcessListResponse>("/system/processes"));
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (!pausedRef.current) void load();
    }, 2000);
    return () => clearInterval(t);
  }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    const filtered = query
      ? data.processes.filter((p) => `${p.name} ${p.pid} ${p.user}`.toLowerCase().includes(query.toLowerCase()))
      : data.processes;
    const dir = asc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name) * dir;
      return ((a[sortKey] as number) - (b[sortKey] as number)) * dir;
    });
  }, [data, query, sortKey, asc]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setAsc((a) => !a);
    else {
      setSortKey(key);
      setAsc(key === "name"); // names default A→Z, numbers default high→low
    }
  }

  async function kill(p: ProcessInfo) {
    if (!(await confirmDialog({
      title: `End process "${p.name}" (PID ${p.pid})?`,
      message: "Unsaved data in this process may be lost.",
      confirmLabel: "End process",
      danger: true,
    }))) return;
    setKilling(p.pid);
    try {
      await api.post(`/system/processes/${p.pid}/kill`);
      push({ level: "info", title: `Ended ${p.name}`, body: `PID ${p.pid} was sent SIGTERM.` });
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't end process", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setKilling(null);
    }
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-2.5">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter processes" className="h-9 py-0 pl-9 text-sm" />
        </div>
        <button
          onClick={() => setPaused((p) => !p)}
          className={clsx("rounded-lg px-3 py-2 text-xs font-medium ring-1 transition", paused ? "bg-amber-50 text-amber-700 ring-amber-200" : "text-ink-soft ring-slate-200 hover:bg-slate-50")}
        >
          {paused ? "Paused" : "Live"}
        </button>
        <button onClick={() => void load()} className="grid h-9 w-9 place-items-center rounded-lg text-ink-soft ring-1 ring-slate-200 transition hover:bg-slate-50" title="Refresh now">
          <RefreshCw size={15} />
        </button>
      </header>

      <div className="opennas-scroll min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs text-ink-faint">
            <tr>
              <Th onClick={() => toggleSort("name")} active={sortKey === "name"} asc={asc}>Process</Th>
              <Th onClick={() => toggleSort("pid")} active={sortKey === "pid"} asc={asc} className="w-20">PID</Th>
              <th className="px-3 py-2 font-medium">User</th>
              <Th onClick={() => toggleSort("cpu")} active={sortKey === "cpu"} asc={asc} className="w-24 text-right">CPU</Th>
              <Th onClick={() => toggleSort("memBytes")} active={sortKey === "memBytes"} asc={asc} className="w-28 text-right">Memory</Th>
              <th className="w-12 px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.pid} className="border-b border-slate-50 hover:bg-slate-50/70">
                <td className="max-w-0 px-3 py-1.5">
                  <div className="truncate font-medium text-ink-soft" title={p.command}>{p.name}</div>
                </td>
                <td className="px-3 py-1.5 tabular-nums text-ink-faint">{p.pid}</td>
                <td className="px-3 py-1.5 text-ink-faint">{p.user}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  <CpuBadge value={p.cpu} />
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink-soft">{formatBytes(p.memBytes)}</td>
                <td className="px-2 py-1.5 text-center">
                  {data?.canKill && (
                    <button
                      onClick={() => void kill(p)}
                      disabled={killing === p.pid}
                      className="grid h-7 w-7 place-items-center rounded-md text-slate-300 transition hover:bg-rose-500 hover:text-white disabled:opacity-50"
                      title="End process"
                      aria-label={`End ${p.name}`}
                    >
                      <Ban size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="py-10 text-center text-sm text-ink-faint">{data ? "No matching processes." : "Loading processes..."}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-xs text-ink-faint">
        <span>{data ? `${rows.length} shown - ${data.total} total` : "-"}</span>
        {!data?.canKill && <span>Ending processes requires admin</span>}
      </footer>
    </div>
  );
}

function Th({ children, onClick, active, asc, className }: { children: React.ReactNode; onClick: () => void; active: boolean; asc: boolean; className?: string }) {
  return (
    <th className={clsx("px-3 py-2 font-medium", className)}>
      <button onClick={onClick} className={clsx("inline-flex items-center gap-1 hover:text-ink", active && "text-ink", className?.includes("text-right") && "flex-row-reverse")}>
        {children}
        {active && (asc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  );
}

function CpuBadge({ value }: { value: number }) {
  const hot = value >= 50;
  const warm = value >= 15;
  return (
    <span className={clsx("font-medium", hot ? "text-rose-600" : warm ? "text-amber-600" : "text-ink-soft")}>
      {value.toFixed(1)}%
    </span>
  );
}
