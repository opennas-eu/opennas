import { useEffect, useState } from "react";
import { RefreshCw, Package } from "lucide-react";
import type { UpdateInfo, UpdateResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { formatUptime } from "../../../lib/format.ts";
import { Button } from "../../ui/controls.tsx";
import { SelfUpdate } from "./SelfUpdate.tsx";

export function Update() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const push = useNotifications((s) => s.push);

  async function load() {
    const res = await api.get<UpdateResponse>("/admin/update");
    setInfo(res.update);
  }
  useEffect(() => { void load(); }, []);

  async function update() {
    if (!(await confirmDialog({
      title: "Update the base system packages?",
      message:
        "This updates Alpine's packages - the kernel, Samba, Docker and so on - not OpenNAS itself. A reboot may be " +
        "needed afterwards for a kernel update to take effect.",
      confirmLabel: "Update packages",
    }))) return;
    setBusy(true);
    try {
      await api.post("/admin/update/system-packages");
      push({ level: "success", title: "Updates installed", body: "Reboot to finish applying kernel/service updates." });
      await load();
    } catch (err) {
      push({ level: "warning", title: "Update failed", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-ink">Update &amp; Information</h2>
        <p className="text-sm text-ink-faint">System version and software updates.</p>
      </div>

      <div className="mb-5 flex items-center gap-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-600 text-white"><Package size={22} /></span>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-ink-faint">OpenNAS</dt><dd className="font-medium text-ink-soft">v{info?.opennasVersion ?? "..."}</dd>
          <dt className="text-ink-faint">Base (Alpine)</dt><dd className="text-ink-soft">{info?.alpineVersion ?? "..."}</dd>
          <dt className="text-ink-faint">Kernel</dt><dd className="text-ink-soft">{info?.kernel || "..."}</dd>
          <dt className="text-ink-faint">Uptime</dt><dd className="text-ink-soft">{info ? formatUptime(info.uptimeSeconds) : "..."}</dd>
          <dt className="text-ink-faint">Licence</dt><dd className="text-ink-soft">GPL-3.0-or-later</dd>
        </dl>
      </div>

      <SelfUpdate />

      <section>
        <h3 className="mb-1 text-sm font-semibold text-ink-soft">Base system packages</h3>
        <p className="mb-2 text-xs text-ink-faint">
          Alpine's own packages - the kernel, Samba, Docker and the rest. Separate from OpenNAS itself, which updates
          above.
        </p>
        <Button loading={busy} onClick={update}><RefreshCw size={15} /> Update system packages</Button>
        <p className="mt-2 text-xs text-ink-faint">
          Runs <code className="rounded bg-slate-100 px-1 py-0.5">apk upgrade</code>. A reboot may be needed afterwards
          for a kernel update to take effect.
        </p>
      </section>

      {/*
        The licence notice lives here because this panel is, in practice, the
        About screen - it is where someone looks to find out what they are
        running. GPLv3 asks that the terms reach the person operating the
        machine, and on a headless appliance nobody is going to go reading
        /usr/lib/opennas/LICENSE to find them.
      */}
      <p className="mt-6 border-t border-slate-200/70 pt-3 text-xs text-ink-faint">
        OpenNAS is free software under the{" "}
        <a
          className="text-brand-600 underline underline-offset-2 hover:text-brand-700"
          href="https://www.gnu.org/licenses/gpl-3.0.html"
          target="_blank"
          rel="noreferrer noopener"
        >
          GNU GPL, version 3 or later
        </a>
        , with absolutely no warranty. The full terms and the source this build came from are on the machine, in{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5">/usr/lib/opennas/LICENSE</code>.
      </p>
    </div>
  );
}
