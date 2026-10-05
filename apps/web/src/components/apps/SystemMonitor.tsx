import { useEffect, useMemo, useState } from "react";
import { Activity, Cpu, MemoryStick, Network, Wifi, WifiOff } from "lucide-react";
import { useT } from "../../i18n/index.ts";
import { useSystem } from "../../store/system.ts";
import { AreaChart, RadialGauge } from "../ui/Charts.tsx";
import { formatBitrate, formatBytes } from "../../lib/format.ts";

type Tab = "overview" | "cpu" | "network";

export function SystemMonitor() {
  const t = useT();
  const { connect, disconnect, connected, latest, history } = useSystem();
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  const cpuSeries = useMemo(() => history.map((s) => s.cpu.total), [history]);
  const memSeries = useMemo(
    () => history.map((s) => (s.memory.usedBytes / s.memory.totalBytes) * 100),
    [history],
  );

  const memPct = latest ? (latest.memory.usedBytes / latest.memory.totalBytes) * 100 : 0;
  const primaryNet = pickPrimaryIface(latest?.network ?? []);

  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex items-center gap-3 border-b border-slate-200 px-5 py-3">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-emerald-400 to-teal-600 text-white">
          <Activity size={18} />
        </span>
        <h2 className="text-sm font-semibold text-ink">{t("app.monitor.title")}</h2>
        <span
          className={`ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            connected ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-ink-faint"
          }`}
        >
          {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
          {connected ? t("app.monitor.live") : t("app.monitor.connecting")}
        </span>
      </header>

      <nav className="flex gap-1 border-b border-slate-200 px-3 py-2">
        {(["overview", "cpu", "network"] as Tab[]).map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              tab === id ? "bg-brand-50 text-brand-700" : "text-ink-faint hover:bg-slate-100"
            }`}
          >
            {id === "overview" ? t("app.monitor.tabOverview") : id === "cpu" ? t("dash.cpu") : t("dash.network")}
          </button>
        ))}
      </nav>

      <div className="opennas-scroll min-h-0 flex-1 overflow-auto p-5">
        {!latest ? (
          <div className="grid h-full place-items-center text-sm text-ink-faint">
            <span className="flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500" />
              {t("app.monitor.readingSensors")}
            </span>
          </div>
        ) : tab === "overview" ? (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-around gap-6 text-emerald-600">
              <RadialGauge value={latest.cpu.total} label={t("dash.cpu")} sublabel={t("app.monitor.load")} color="#10b981" />
              <div className="text-brand-600">
                <RadialGauge value={memPct} label={t("dash.memory")} sublabel={formatBytes(latest.memory.usedBytes)} color="#3b82f6" />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Stat icon={<Cpu size={16} />} label={t("dash.processes")} value={`${latest.processes.running} / ${latest.processes.total}`} hint={t("app.monitor.runningTotal")} />
              <Stat
                icon={<MemoryStick size={16} />}
                label={t("app.monitor.swap")}
                value={latest.memory.swapTotalBytes ? formatBytes(latest.memory.swapUsedBytes) : "-"}
                hint={latest.memory.swapTotalBytes ? t("app.monitor.swapOf", { total: formatBytes(latest.memory.swapTotalBytes) }) : t("app.monitor.noSwap")}
              />
              <Stat
                icon={<Network size={16} />}
                label={primaryNet?.iface ?? t("dash.network")}
                value={primaryNet ? `↓ ${formatBitrate(primaryNet.rxBytesPerSec)}` : "-"}
                hint={primaryNet ? `↑ ${formatBitrate(primaryNet.txBytesPerSec)}` : ""}
              />
            </div>

            <ChartCard title={t("app.monitor.cpuLoad")} color="text-emerald-600" value={`${latest.cpu.total}%`}>
              <AreaChart values={cpuSeries} max={100} color="#10b981" className="text-emerald-900" />
            </ChartCard>
            <ChartCard title={t("app.monitor.memoryUsage")} color="text-brand-600" value={`${Math.round(memPct)}%`}>
              <AreaChart values={memSeries} max={100} color="#3b82f6" className="text-blue-900" />
            </ChartCard>
          </div>
        ) : tab === "cpu" ? (
          <div className="space-y-5">
            <ChartCard title={t("app.monitor.overallLoad")} color="text-emerald-600" value={`${latest.cpu.total}%`}>
              <AreaChart values={cpuSeries} max={100} color="#10b981" className="text-emerald-900" />
            </ChartCard>
            <div>
              <h3 className="mb-3 text-sm font-semibold text-ink-soft">{t("app.monitor.perCoreLoad")}</h3>
              <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
                {latest.cpu.perCore.map((load, i) => (
                  <div key={i}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-ink-faint">{t("app.monitor.core", { index: i })}</span>
                      <span className="tabular-nums font-medium text-ink-soft">{Math.round(load)}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                      <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${load}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {latest.temperature.mainC != null && (
              <Stat icon={<Activity size={16} />} label={t("app.monitor.cpuTemperature")} value={`${latest.temperature.mainC} °C`} hint={t("app.monitor.package")} />
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {(latest.network ?? []).filter((n) => n.rxTotalBytes > 0 || n.txTotalBytes > 0).map((n) => (
              <div key={n.iface} className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium text-ink-soft">{n.iface}</span>
                  <span className="text-xs text-ink-faint">
                    Σ ↓ {formatBytes(n.rxTotalBytes)} - ↑ {formatBytes(n.txTotalBytes)}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
                    <div className="text-xs text-ink-faint">{t("app.monitor.download")}</div>
                    <div className="text-lg font-semibold text-emerald-600">{formatBitrate(n.rxBytesPerSec)}</div>
                  </div>
                  <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
                    <div className="text-xs text-ink-faint">{t("app.monitor.upload")}</div>
                    <div className="text-lg font-semibold text-brand-600">{formatBitrate(n.txBytesPerSec)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function pickPrimaryIface(nets: { iface: string; rxBytesPerSec: number; txBytesPerSec: number; rxTotalBytes: number; txTotalBytes: number }[]) {
  const real = nets.filter((n) => n.iface !== "lo" && (n.rxTotalBytes > 0 || n.txTotalBytes > 0));
  if (real.length === 0) return nets[0] ?? null;
  return real.reduce((a, b) => (a.rxBytesPerSec + a.txBytesPerSec >= b.rxBytesPerSec + b.txBytesPerSec ? a : b));
}

function Stat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-faint">
        {icon} {label}
      </div>
      <div className="text-lg font-semibold text-ink">{value}</div>
      {hint && <div className="text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

function ChartCard({ title, value, color, children }: { title: string; value: string; color: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium text-ink-soft">{title}</span>
        <span className={`text-lg font-semibold tabular-nums ${color}`}>{value}</span>
      </div>
      {children}
    </div>
  );
}
