import { useEffect, useState } from "react";
import { RefreshCw, Package } from "lucide-react";
import type { UpdateInfo, UpdateResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { formatUptime } from "../../../lib/format.ts";
import { Button } from "../../ui/controls.tsx";
import { useT } from "../../../i18n/index.ts";
import { fillElements } from "./fillElements.tsx";
import { SelfUpdate } from "./SelfUpdate.tsx";

export function Update() {
  const t = useT();
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
      title: t("cp.update.confirmTitle"),
      message: t("cp.update.confirmMessage"),
      confirmLabel: t("cp.update.confirmLabel"),
    }))) return;
    setBusy(true);
    try {
      await api.post("/admin/update/system-packages");
      push({ level: "success", title: t("cp.update.installed"), body: t("cp.update.installedBody") });
      await load();
    } catch (err) {
      push({ level: "warning", title: t("cp.update.failed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-ink">{t("cp.update.title")}</h2>
        <p className="text-sm text-ink-faint">{t("cp.update.subtitle")}</p>
      </div>

      <div className="mb-5 flex items-center gap-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-600 text-white"><Package size={22} /></span>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-ink-faint">OpenNAS</dt><dd className="font-medium text-ink-soft">v{info?.opennasVersion ?? "..."}</dd>
          <dt className="text-ink-faint">{t("cp.update.base")}</dt><dd className="text-ink-soft">{info?.alpineVersion ?? "..."}</dd>
          <dt className="text-ink-faint">{t("cp.update.kernel")}</dt><dd className="text-ink-soft">{info?.kernel || "..."}</dd>
          <dt className="text-ink-faint">{t("dash.uptime")}</dt><dd className="text-ink-soft">{info ? formatUptime(info.uptimeSeconds) : "..."}</dd>
          <dt className="text-ink-faint">{t("cp.update.licence")}</dt><dd className="text-ink-soft">GPL-3.0-or-later</dd>
        </dl>
      </div>

      <SelfUpdate />

      <section>
        <h3 className="mb-1 text-sm font-semibold text-ink-soft">{t("cp.update.basePackages")}</h3>
        <p className="mb-2 text-xs text-ink-faint">
          {t("cp.update.basePackagesHint")}
        </p>
        <Button loading={busy} onClick={update}><RefreshCw size={15} /> {t("cp.update.updatePackages")}</Button>
        <p className="mt-2 text-xs text-ink-faint">
          {fillElements(t("cp.update.runsApk"), { cmd: <code className="rounded bg-slate-100 px-1 py-0.5">apk upgrade</code> })}
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
        {fillElements(t("cp.update.licenceNotice"), {
          link: (
        <a
          className="text-brand-600 underline underline-offset-2 hover:text-brand-700"
          href="https://www.gnu.org/licenses/gpl-3.0.html"
          target="_blank"
          rel="noreferrer noopener"
        >
          {t("cp.update.gplLink")}
        </a>
          ),
          path: <code className="rounded bg-slate-100 px-1 py-0.5">/usr/lib/opennas/LICENSE</code>,
        })}
      </p>
    </div>
  );
}
