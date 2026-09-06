import { useEffect, useState } from "react";
import { Cpu, HardDrive, MemoryStick, Network, Server, Thermometer } from "lucide-react";
import type { DiskVolume, SystemStaticInfo } from "@opennas/shared";
import { api } from "../../lib/api.ts";
import { useSystem } from "../../store/system.ts";
import { formatBytes, formatUptime } from "../../lib/format.ts";

export function InfoCenter() {
  const liveInfo = useSystem((s) => s.info);
  const latest = useSystem((s) => s.latest);
  const [info, setInfo] = useState<SystemStaticInfo | null>(liveInfo);
  const [disks, setDisks] = useState<DiskVolume[]>([]);

  useEffect(() => {
    if (!info) void api.get<{ info: SystemStaticInfo }>("/system/info").then((r) => setInfo(r.info));
    void api.get<{ disks: DiskVolume[] }>("/system/disks").then((r) => setDisks(r.disks));
  }, [info]);

  const temp = latest?.temperature.mainC;

  return (
    <div className="space-y-5 p-6">
      <header className="flex items-center gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 text-white">
          <Server size={24} />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-ink">{info?.hostname ?? "This server"}</h2>
          <p className="text-sm text-ink-faint">
            {info ? `${info.os.distro} ${info.os.release} - ${info.os.arch}` : "Loading..."}
          </p>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <InfoCard icon={<Cpu size={18} />} title="Processor">
          <div className="font-medium text-ink-soft">{info?.cpu.brand ?? "-"}</div>
          <div className="text-ink-faint">
            {info ? `${info.cpu.physicalCores} cores / ${info.cpu.cores} threads - ${info.cpu.speedGHz} GHz` : ""}
          </div>
        </InfoCard>

        <InfoCard icon={<MemoryStick size={18} />} title="Memory">
          <div className="font-medium text-ink-soft">{info ? formatBytes(info.memoryTotalBytes) : "-"}</div>
          <div className="text-ink-faint">
            {latest ? `${formatBytes(latest.memory.usedBytes)} in use` : "installed"}
          </div>
        </InfoCard>

        <InfoCard icon={<Thermometer size={18} />} title="Temperature">
          <div className="font-medium text-ink-soft">{temp != null ? `${temp} °C` : "Not available"}</div>
          <div className="text-ink-faint">CPU package</div>
        </InfoCard>

        <InfoCard icon={<Network size={18} />} title="Uptime">
          <div className="font-medium text-ink-soft">
            {latest ? formatUptime(latest.uptimeSeconds) : info ? formatUptime(info.uptimeSeconds) : "-"}
          </div>
          <div className="text-ink-faint">since last boot</div>
        </InfoCard>
      </div>

      <section>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink-soft">
          <HardDrive size={16} /> Storage volumes
        </h3>
        <div className="space-y-2.5">
          {disks.length === 0 && <p className="text-sm text-ink-faint">No volumes reported.</p>}
          {disks.map((d) => (
            <div key={d.mount} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="font-medium text-ink-soft">{d.mount}</span>
                <span className="text-xs text-ink-faint">
                  {formatBytes(d.usedBytes)} / {formatBytes(d.sizeBytes)} - {d.type}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div
                  className={`h-full rounded-full ${d.usePercent > 90 ? "bg-rose-500" : d.usePercent > 75 ? "bg-amber-500" : "bg-brand-500"}`}
                  style={{ width: `${d.usePercent}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function InfoCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        {icon} {title}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
