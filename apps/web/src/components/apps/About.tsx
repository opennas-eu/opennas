import { useT } from "../../i18n/index.ts";
import { useSystem } from "../../store/system.ts";
import { Logo } from "../Logo.tsx";

export function About() {
  const t = useT();
  const info = useSystem((s) => s.info);
  // The licence name is a link, so the sentence is split around its placeholder.
  const [licenseBefore, licenseAfter] = t("app.about.license").split("{license}");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-gradient-to-b from-slate-50 to-white px-8 text-center dark:from-slate-800 dark:to-slate-900">
      <Logo size={72} />
      <div>
        <h2 className="text-xl font-bold text-ink">OpenNAS</h2>
        <p className="text-sm text-ink-faint">{t("app.about.tagline")}</p>
      </div>
      <dl className="w-full max-w-xs space-y-1.5 text-sm">
        <Row label={t("app.about.version")} value={info?.opennasVersion ?? "-"} />
        <Row label={t("app.about.host")} value={info?.hostname ?? "-"} />
        <Row label={t("app.about.platform")} value={info ? `${info.os.distro} (${info.os.arch})` : "-"} />
      </dl>
      <p className="max-w-xs text-xs text-ink-faint">
        {t("app.about.body")}
      </p>
      <p className="max-w-xs text-xs text-ink-faint">
        {licenseBefore}
        <a
          className="text-brand-600 underline underline-offset-2 hover:text-brand-700"
          href="https://www.gnu.org/licenses/gpl-3.0.html"
          target="_blank"
          rel="noreferrer noopener"
        >
          GNU GPL v3
        </a>
        {licenseAfter}
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-slate-100 py-1.5">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="font-medium text-ink-soft">{value}</dd>
    </div>
  );
}
