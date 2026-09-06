import { useEffect, useState } from "react";
import { Clock, Save } from "lucide-react";
import type { TimeInfo, TimeResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Field, Input, Select } from "../../ui/controls.tsx";
import { LOCALES, detectLocale, useI18n, useT } from "../../../i18n/index.ts";
import { en } from "../../../i18n/locales/en.ts";

const COMMON_ZONES = [
  "UTC", "Europe/Berlin", "Europe/London", "Europe/Paris", "America/New_York",
  "America/Chicago", "America/Los_Angeles", "Asia/Tokyo", "Asia/Shanghai", "Australia/Sydney",
];

/**
 * The language this person sees OpenNAS in.
 *
 * Per browser rather than per account: the choice is stored locally, so the
 * language follows the device rather than being pushed to every session at once
 * - and it takes effect immediately, with no reload and no round trip.
 */
function LanguagePicker() {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const setLocale = useI18n((s) => s.setLocale);
  const busy = useI18n((s) => !s.ready);

  const current = LOCALES.find((l) => l.id === locale);
  // English is the source catalogue, so it is complete by definition; anything
  // else may be behind it, and saying so beats leaving people to wonder why one
  // screen is half in English.
  const total = Object.keys(en).length;

  return (
    <section className="mb-6 max-w-md">
      <Field label={t("regional.language")} hint={t("regional.languageHint")}>
        <Select value={locale} onChange={(e) => void setLocale(e.target.value)} disabled={busy} className="w-full">
          {LOCALES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.nativeName}
              {l.nativeName !== l.englishName ? ` - ${l.englishName}` : ""}
            </option>
          ))}
        </Select>
      </Field>
      {locale !== detectLocale() && (
        <button
          type="button"
          onClick={() => void setLocale(detectLocale())}
          className="mt-1.5 text-[11px] text-brand-600 underline-offset-2 hover:underline"
        >
          {t("regional.languageFollowBrowser")}
        </button>
      )}
      {current && current.id !== "en" && (
        <p className="mt-2 text-[11px] text-ink-faint">
          {t("regional.partial", { name: current.nativeName })} ({total} phrases in total.)
        </p>
      )}
    </section>
  );
}

export function Regional() {
  const [info, setInfo] = useState<TimeInfo | null>(null);
  const [tz, setTz] = useState("");
  const [ntp, setNtp] = useState("");
  const [busy, setBusy] = useState(false);
  const push = useNotifications((s) => s.push);

  async function load() {
    const res = await api.get<TimeResponse>("/admin/time");
    setInfo(res.time);
    setTz(res.time.timezone);
    setNtp(res.time.ntpServer ?? "pool.ntp.org");
  }
  useEffect(() => { void load(); }, []);

  async function save() {
    setBusy(true);
    try {
      const res = await api.post<TimeResponse>("/admin/time", { timezone: tz, ntpServer: ntp });
      setInfo(res.time);
      push({ level: "success", title: "Time settings saved" });
    } catch (err) {
      push({ level: "warning", title: "Couldn't save", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-ink">Time &amp; Region</h2>
        <p className="text-sm text-ink-faint">Language, timezone and time synchronization.</p>
      </div>

      <LanguagePicker />

      <div className="mb-5 flex items-center gap-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-400 to-violet-600 text-white"><Clock size={20} /></span>
        <div className="text-sm">
          <div className="font-semibold text-ink">{info ? new Date(info.now).toLocaleString() : "..."}</div>
          <div className="text-ink-faint">{info?.timezone}</div>
        </div>
      </div>

      <div className="max-w-md space-y-4">
        <Field label="Timezone" hint="e.g. Europe/Berlin">
          <Input list="tzlist" value={tz} onChange={(e) => setTz(e.target.value)} />
          <datalist id="tzlist">{COMMON_ZONES.map((z) => <option key={z} value={z} />)}</datalist>
        </Field>
        <Field label="NTP server">
          <Input value={ntp} onChange={(e) => setNtp(e.target.value)} placeholder="pool.ntp.org" />
        </Field>
        <Button loading={busy} onClick={save}><Save size={15} /> Save</Button>
      </div>
    </div>
  );
}
