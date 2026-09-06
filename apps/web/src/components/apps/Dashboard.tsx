import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Clock3,
  Cpu,
  HardDrive,
  Network,
  Server,
  Thermometer,
} from "lucide-react";
import type { DiskVolume } from "@opennas/shared";
import { useT } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { useSystem } from "../../store/system.ts";
import { useAuth } from "../../store/auth.ts";
import { useWindows } from "../../store/windows.ts";
import { useApps } from "../../store/apps.ts";
import { AreaChart, RadialGauge } from "../ui/Charts.tsx";
import { formatBitrate, formatBytes, formatUptime } from "../../lib/format.ts";

export function Dashboard() {
  const t = useT();
  const { connect, disconnect, latest, history, info } = useSystem();
  const displayName = useAuth((s) => s.session?.user.displayName ?? "");
  const openApp = useWindows((s) => s.openApp);
  const byId = useApps((s) => s.byId);
  const [disks, setDisks] = useState<DiskVolume[]>([]);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  useEffect(() => {
    void api.get<{ disks: DiskVolume[] }>("/system/disks").then((r) => setDisks(r.disks));
  }, []);

  const cpuSeries = useMemo(() => history.map((s) => s.cpu.total), [history]);
  const memPct = latest ? (latest.memory.usedBytes / latest.memory.totalBytes) * 100 : 0;
  const net = useMemo(() => pickNet(latest?.network ?? []), [latest]);

  const greeting = t(greetingKey());

  function open(id: string) {
    const app = byId(id);
    if (app) openApp(app);
  }

  return (
    <div className="opennas-scroll h-full overflow-auto bg-slate-50 p-6">
      <header className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">
            {greeting}{displayName ? `, ${displayName.split(" ")[0]}` : ""}
          </h1>
          <p className="text-sm text-ink-faint">
            {info ? `${info.hostname} - ${info.os.distro} ${info.os.arch}` : t("dash.loading")}
          </p>
        </div>
        <button
          onClick={() => open("system-monitor")}
          className="hidden items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm font-medium text-ink-soft ring-1 ring-slate-200 transition hover:bg-slate-100 sm:flex"
        >
          <Activity size={15} /> Resource Monitor
        </button>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {/* CPU */}
        <Widget className="row-span-2 flex flex-col items-center justify-center" onClick={() => open("system-monitor")}>
          <RadialGauge value={latest?.cpu.total ?? 0} label={t("dash.cpu")} sublabel={info ? t("dash.threads", { count: info.cpu.cores }) : ""} color="#10b981" />
          <div className="mt-3 w-full">
            <AreaChart values={cpuSeries.length ? cpuSeries : [0]} max={100} color="#10b981" height={56} className="text-emerald-900" />
          </div>
        </Widget>

        {/* Memory */}
        <Widget className="row-span-2 flex flex-col items-center justify-center" onClick={() => open("system-monitor")}>
          <RadialGauge value={memPct} label={t("dash.memory")} sublabel={latest ? formatBytes(latest.memory.usedBytes) : ""} color="#3b82f6" />
          <div className="mt-3 text-center text-xs text-ink-faint">
            {latest ? `${formatBytes(latest.memory.freeBytes)} free of ${formatBytes(latest.memory.totalBytes)}` : ""}
          </div>
        </Widget>

        <StatWidget icon={<Network size={16} />} label={t("dash.network")} accent="text-emerald-600">
          {net ? (
            <div className="space-y-0.5">
              <div className="text-sm font-semibold text-emerald-600">↓ {formatBitrate(net.rxBytesPerSec)}</div>
              <div className="text-sm font-semibold text-brand-600">↑ {formatBitrate(net.txBytesPerSec)}</div>
              <div className="text-[11px] text-ink-faint">{net.iface}</div>
            </div>
          ) : <Dim />}
        </StatWidget>

        <StatWidget icon={<Clock3 size={16} />} label={t("dash.uptime")}>
          <div className="text-lg font-semibold text-ink">{latest ? formatUptime(latest.uptimeSeconds) : info ? formatUptime(info.uptimeSeconds) : <Dim />}</div>
        </StatWidget>

        <StatWidget icon={<Cpu size={16} />} label={t("dash.processes")} onClick={() => open("task-manager")}>
          <div className="text-lg font-semibold text-ink">{latest ? `${latest.processes.running} / ${latest.processes.total}` : <Dim />}</div>
          <div className="text-[11px] text-ink-faint">running / total</div>
        </StatWidget>

        <StatWidget icon={<Thermometer size={16} />} label={t("dash.temperature")}>
          <div className="text-lg font-semibold text-ink">
            {latest?.temperature.mainC != null ? `${latest.temperature.mainC} °C` : <span className="text-sm text-ink-faint">n/a</span>}
          </div>
        </StatWidget>
      </div>

      {/* Storage */}
      <section className="mt-4">
        <Widget onClick={() => open("file-station")}>
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-soft">
            <HardDrive size={16} /> {t("dash.storage")}
          </div>
          {disks.length === 0 ? (
            <p className="text-sm text-ink-faint">{t("dash.noVolumes")}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {disks.map((d) => (
                <div key={d.mount}>
                  <div className="mb-1 flex items-baseline justify-between text-xs">
                    <span className="truncate font-medium text-ink-soft">{d.mount}</span>
                    <span className="text-ink-faint">{Math.round(d.usePercent)}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className={`h-full rounded-full ${d.usePercent > 90 ? "bg-rose-500" : d.usePercent > 75 ? "bg-amber-500" : "bg-brand-500"}`}
                      style={{ width: `${d.usePercent}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[11px] text-ink-faint">
                    {formatBytes(d.usedBytes)} / {formatBytes(d.sizeBytes)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Widget>
      </section>

      {info && (
        <section className="mt-4">
          <Widget>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-soft">
              <Server size={16} /> System
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              <Fact label={t("dash.processor")} value={info.cpu.brand} />
              <Fact label="Cores" value={`${info.cpu.physicalCores} / ${info.cpu.cores} threads`} />
              <Fact label={t("dash.memory")} value={formatBytes(info.memoryTotalBytes)} />
              <Fact label="OS" value={`${info.os.distro} ${info.os.release}`} />
              <Fact label={t("dash.architecture")} value={info.os.arch} />
              <Fact label="OpenNAS" value={`v${info.opennasVersion}`} />
            </dl>
          </Widget>
        </section>
      )}
    </div>
  );
}

function Widget({ children, className, onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 ${onClick ? "cursor-pointer transition hover:ring-brand-300" : ""} ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

function StatWidget({ icon, label, accent, children, onClick }: { icon: React.ReactNode; label: string; accent?: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <Widget onClick={onClick}>
      <div className={`mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-faint ${accent ?? ""}`}>
        {icon} {label}
      </div>
      {children}
    </Widget>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="truncate font-medium text-ink-soft">{value}</dd>
    </div>
  );
}

function Dim() {
  return <span className="text-sm text-ink-faint">-</span>;
}

function pickNet(nets: { iface: string; rxBytesPerSec: number; txBytesPerSec: number; rxTotalBytes: number; txTotalBytes: number }[]) {
  const real = nets.filter((n) => n.iface !== "lo" && (n.rxTotalBytes > 0 || n.txTotalBytes > 0));
  if (real.length === 0) return null;
  return real.reduce((a, b) => (a.rxBytesPerSec + a.txBytesPerSec >= b.rxBytesPerSec + b.txBytesPerSec ? a : b));
}

/**
 * Which greeting, as a message key rather than a sentence.
 *
 * Returning the key lets the caller translate it. Returning the English and
 * translating afterwards would need a lookup from text back to key, which is
 * exactly the sort of thing that quietly stops working the first time somebody
 * rewords a greeting.
 */
function greetingKey(): "dash.goodNight" | "dash.goodMorning" | "dash.goodAfternoon" | "dash.goodEvening" {
  const h = new Date().getHours();
  if (h < 5) return "dash.goodNight";
  if (h < 12) return "dash.goodMorning";
  if (h < 18) return "dash.goodAfternoon";
  return "dash.goodEvening";
}
