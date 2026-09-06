import { useCallback, useEffect, useState } from "react";
import { clsx } from "clsx";
import { ChevronDown, ChevronRight, LockOpen, RefreshCw, ShieldCheck, Unlock } from "lucide-react";
import type { AuditEntry, AuditOutcome, AuditResponse, LockoutsResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Input, Select } from "../../ui/controls.tsx";
import { formatRelative } from "../../../lib/format.ts";

const PAGE = 100;

const OUTCOME_STYLE: Record<AuditOutcome, string> = {
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  denied: "bg-amber-50 text-amber-700 ring-amber-200",
  error: "bg-rose-50 text-rose-700 ring-rose-200",
};

export function Audit() {
  const push = useNotifications((s) => s.push);
  const [data, setData] = useState<AuditResponse | null>(null);
  const [lockouts, setLockouts] = useState<LockoutsResponse["lockouts"]>([]);
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState<"" | AuditOutcome>("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
      if (search.trim()) params.set("search", search.trim());
      if (action) params.set("action", action);
      if (outcome) params.set("outcome", outcome);
      setData(await api.get<AuditResponse>(`/admin/audit?${params}`));
      setLockouts((await api.get<LockoutsResponse>("/admin/lockouts")).lockouts);
    } finally {
      setLoading(false);
    }
  }, [search, action, outcome, page]);

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  async function unlock(username: string) {
    try {
      await api.del(`/admin/lockouts/${encodeURIComponent(username)}`);
      push({ level: "success", title: `${username} unlocked` });
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't unlock", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-ink"><ShieldCheck size={20} /> Audit log</h2>
        <p className="text-sm text-ink-faint">Every change made through OpenNAS - who did it, when, and from where.</p>
      </div>

      {/* Locked accounts sit above the log: they're the thing needing action. */}
      {lockouts.length > 0 && (
        <div className="mb-3 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-amber-800">
            <LockOpen size={15} /> Locked out after repeated failed sign-ins
          </h3>
          <div className="space-y-1.5">
            {lockouts.map((l) => (
              <div key={l.username} className="flex items-center gap-2 text-xs text-amber-900">
                <span className="font-medium">{l.username}</span>
                <span className="text-amber-700">
                  {l.failures} failures - unlocks {formatRelative(l.lockedUntil)}
                </span>
                <span className="flex-1" />
                <Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => void unlock(l.username)}>
                  <Unlock size={12} /> Unlock now
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          placeholder="Search action, target or user"
          className="h-9 max-w-xs"
        />
        <Select value={action} onChange={(e) => { setAction(e.target.value); setPage(0); }} className="h-9">
          <option value="">All actions</option>
          {(data?.actions ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
        </Select>
        <Select value={outcome} onChange={(e) => { setOutcome(e.target.value as AuditOutcome | ""); setPage(0); }} className="h-9">
          <option value="">Any outcome</option>
          <option value="ok">Succeeded</option>
          <option value="denied">Denied</option>
          <option value="error">Failed</option>
        </Select>
        <span className="text-xs text-ink-faint">{total} entries</span>
        <span className="flex-1" />
        <button onClick={() => void load()} className="grid h-9 w-9 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100" title="Refresh">
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="opennas-scroll min-h-0 flex-1 overflow-auto rounded-xl ring-1 ring-slate-200">
        {data === null ? (
          <p className="p-6 text-sm text-ink-faint">Loading...</p>
        ) : data.entries.length === 0 ? (
          <p className="p-6 text-center text-sm text-ink-faint">Nothing matches.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-slate-50 text-ink-faint">
              <tr>
                <th className="w-6" />
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <AuditRow key={e.id} entry={e} open={expanded === e.id} onToggle={() => setExpanded(expanded === e.id ? null : e.id)} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pages > 1 && (
        <div className="mt-3 flex items-center justify-center gap-2 text-xs">
          <Button variant="secondary" className="h-8 px-3 text-xs" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-ink-faint">Page {page + 1} of {pages}</span>
          <Button variant="secondary" className="h-8 px-3 text-xs" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function AuditRow({ entry, open, onToggle }: { entry: AuditEntry; open: boolean; onToggle: () => void }) {
  const hasDetail = entry.detail && Object.keys(entry.detail).length > 0;
  return (
    <>
      <tr
        onClick={hasDetail ? onToggle : undefined}
        className={clsx("border-t border-slate-100", hasDetail && "cursor-pointer hover:bg-slate-50")}
      >
        <td className="pl-2 text-ink-faint">
          {hasDetail ? (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-ink-faint" title={entry.at}>{formatRelative(entry.at)}</td>
        <td className="px-3 py-2 font-mono text-ink-soft">{entry.action}</td>
        <td className="px-3 py-2 text-ink-soft">
          {entry.actorName}
          {entry.actorIp && <span className="ml-1 text-ink-faint">({entry.actorIp})</span>}
        </td>
        <td className="max-w-[14rem] truncate px-3 py-2 font-mono text-ink-faint" title={entry.target ?? ""}>
          {entry.target ?? "-"}
        </td>
        <td className="px-3 py-2">
          <span className={clsx("rounded-full px-2 py-0.5 text-[10px] font-medium ring-1", OUTCOME_STYLE[entry.outcome])}>
            {entry.outcome === "ok" ? "ok" : `${entry.outcome} ${entry.status}`}
          </span>
        </td>
      </tr>
      {open && hasDetail && (
        <tr className="border-t border-slate-100 bg-slate-50/60">
          <td />
          <td colSpan={5} className="px-3 py-2">
            <pre className="opennas-scroll overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-ink-soft">
              {JSON.stringify(entry.detail, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
