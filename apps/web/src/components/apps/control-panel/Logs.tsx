import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ScrollText } from "lucide-react";
import type { LogSourceId, LogsResponse } from "@opennas/shared";
import { api } from "../../../lib/api.ts";
import { Select } from "../../ui/controls.tsx";

export function Logs() {
  const [source, setSource] = useState<LogSourceId>("opennas");
  const [lines, setLines] = useState(200);
  const [data, setData] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (src: LogSourceId, n: number) => {
    setLoading(true);
    try {
      setData(await api.get<LogsResponse>(`/admin/logs?source=${src}&lines=${n}`));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(source, lines); }, [load, source, lines]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-ink"><ScrollText size={20} /> Logs</h2>
          <p className="text-sm text-ink-faint">System and service logs.</p>
        </div>
        <Select value={source} onChange={(e) => setSource(e.target.value as LogSourceId)} className="h-9">
          {(data?.sources ?? [{ id: "opennas", label: "OpenNAS", available: true }]).map((s) => (
            <option key={s.id} value={s.id} disabled={!s.available}>
              {s.label}{s.available ? "" : " (n/a)"}
            </option>
          ))}
        </Select>
        <Select value={lines} onChange={(e) => setLines(Number(e.target.value))} className="h-9">
          <option value={100}>100 lines</option>
          <option value={200}>200 lines</option>
          <option value={500}>500 lines</option>
          <option value={1000}>1000 lines</option>
        </Select>
        <button onClick={() => void load(source, lines)} className="grid h-9 w-9 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100" title="Refresh">
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="opennas-scroll min-h-0 flex-1 overflow-auto rounded-xl bg-slate-900 p-3 ring-1 ring-slate-700">
        {data && data.lines.length === 0 ? (
          <p className="p-4 text-center text-sm text-slate-400">No log entries{data.sources.find((s) => s.id === source)?.available ? "" : " - this log isn't available here"}.</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-100">
            {data?.lines.join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}
