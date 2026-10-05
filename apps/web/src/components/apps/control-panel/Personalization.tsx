import { useEffect, useRef, useState } from "react";
import { Check, Monitor, Moon, Palette, Sun, Trash2, Upload } from "lucide-react";
import { clsx } from "clsx";
import type { InstalledTheme, ThemeMode } from "@opennas/shared";
import { api, apiUrl, ApiRequestError } from "../../../lib/api.ts";
import { usePrefs } from "../../../store/prefs.ts";
import { useThemes } from "../../../store/themes.ts";
import { useAuth } from "../../../store/auth.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { WALLPAPERS } from "../../../lib/wallpapers.ts";
import { ACCENTS } from "../../../lib/accents.ts";
import { useT, type MessageKey } from "../../../i18n/index.ts";

const MODES: { id: ThemeMode; name: MessageKey; icon: typeof Sun }[] = [
  { id: "light", name: "cp.personalization.light", icon: Sun },
  { id: "dark", name: "cp.personalization.dark", icon: Moon },
  { id: "system", name: "cp.system", icon: Monitor },
];

export function Personalization() {
  const t = useT();
  const wallpaper = usePrefs((s) => s.preferences.wallpaper);
  const accent = usePrefs((s) => s.preferences.accent);
  const theme = usePrefs((s) => s.preferences.theme);
  const themeId = usePrefs((s) => s.preferences.themeId);
  const update = usePrefs((s) => s.update);

  const themes = useThemes((s) => s.themes);
  const loadThemes = useThemes((s) => s.load);
  const isAdmin = useAuth((s) => s.session?.user.role === "admin");
  const push = useNotifications((s) => s.push);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void loadThemes(); }, [loadThemes]);

  const usingCustom = themeId !== "";

  // Selecting a built-in option clears any active custom theme.
  const pickBuiltin = (partial: Parameters<typeof update>[0]) => void update({ ...partial, themeId: "" });

  async function installTheme(file: File) {
    if (!/\.onthm$|\.zip$/i.test(file.name)) {
      push({ level: "warning", title: t("cp.personalization.notATheme"), body: t("cp.personalization.chooseOnthm") });
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const res = await fetch(apiUrl("/themes/install"), { method: "POST", body: fd, credentials: "include" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body as { message?: string })?.message ?? t("cp.personalization.installFailedBody"));
      await loadThemes();
      push({ level: "success", title: t("cp.personalization.installed"), body: t("cp.personalization.readyToApply", { name: (body as { theme: InstalledTheme }).theme.name }) });
    } catch (err) {
      push({ level: "warning", title: t("cp.personalization.installFailed"), body: err instanceof Error ? err.message : t("cp.failed") });
    } finally {
      setBusy(false);
    }
  }

  async function uninstallTheme(th: InstalledTheme) {
    if (!(await confirmDialog({ title: t("cp.personalization.removeConfirm", { name: th.name }), message: t("cp.personalization.removeMessage"), confirmLabel: t("common.remove"), danger: true }))) return;
    try {
      await api.del(`/themes/${th.id}`);
      if (themeId === th.id) await update({ themeId: "" });
      await loadThemes();
      push({ level: "success", title: t("cp.personalization.removed"), body: th.name });
    } catch (err) {
      push({ level: "warning", title: t("cp.personalization.removeFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    }
  }

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-ink">{t("cp.personalization")}</h2>
        <p className="text-sm text-ink-faint">{t("cp.personalization.subtitle")}</p>
      </div>

      {/* Custom themes */}
      <section className="mb-7">
        <div className="mb-3 flex items-center gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft"><Palette size={15} /> {t("cp.personalization.themes")}</h3>
          <span className="flex-1" />
          {isAdmin && (
            <button onClick={() => fileInput.current?.click()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-ink-soft transition hover:bg-slate-200 disabled:opacity-50">
              <Upload size={13} /> {busy ? t("cp.personalization.installing") : t("cp.personalization.install")}
            </button>
          )}
          <input ref={fileInput} type="file" accept=".onthm,.zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void installTheme(f); e.target.value = ""; }} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {/* Default (no custom theme) */}
          <button
            onClick={() => void update({ themeId: "" })}
            className={clsx("group relative aspect-video overflow-hidden rounded-xl ring-2 transition", !usingCustom ? "ring-brand-500" : "ring-transparent hover:ring-slate-300")}
            style={{ background: WALLPAPERS[0]?.background }}
            title={t("cp.personalization.defaultLook")}
          >
            {!usingCustom && <Badge />}
            <Label>{t("cp.personalization.default")}</Label>
          </button>
          {themes.map((th) => (
            <button
              key={th.id}
              onClick={() => void update({ themeId: th.id, theme: th.mode })}
              className={clsx("group relative aspect-video overflow-hidden rounded-xl ring-2 transition", themeId === th.id ? "ring-brand-500" : "ring-transparent hover:ring-slate-300")}
              style={{ background: th.wallpaper }}
              title={th.description || th.name}
            >
              {themeId === th.id && <Badge />}
              <span className="absolute left-1.5 top-1.5 h-4 w-4 rounded-full ring-2 ring-white/70" style={{ backgroundColor: th.accent["600"] }} />
              {isAdmin && (
                <span
                  role="button"
                  onClick={(e) => { e.stopPropagation(); void uninstallTheme(th); }}
                  className="absolute right-1.5 top-1.5 hidden h-5 w-5 place-items-center rounded-full bg-black/50 text-white group-hover:grid hover:bg-rose-500"
                  title={t("cp.personalization.removeTheme")}
                >
                  <Trash2 size={11} />
                </span>
              )}
              <Label>{th.name}</Label>
            </button>
          ))}
        </div>
        {themes.length === 0 && (
          <p className="mt-2 text-xs text-ink-faint">{isAdmin ? t("cp.personalization.noThemesAdmin") : t("cp.personalization.noThemes")}</p>
        )}
      </section>

      {/* Mode */}
      <section className="mb-7">
        <h3 className="mb-3 text-sm font-semibold text-ink-soft">{t("cp.personalization.mode")}</h3>
        <div className="flex flex-wrap gap-2.5">
          {MODES.map((m) => {
            const TIcon = m.icon;
            const active = theme === m.id;
            return (
              <button
                key={m.id}
                onClick={() => void update({ theme: m.id })}
                className={clsx("flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium ring-1 transition", active ? "bg-brand-600 text-white ring-brand-600" : "bg-slate-50 text-ink-soft ring-slate-200 hover:bg-slate-100")}
              >
                <TIcon size={16} /> {t(m.name)}
              </button>
            );
          })}
        </div>
      </section>

      {/* Wallpaper */}
      <section className="mb-7">
        <h3 className="mb-3 text-sm font-semibold text-ink-soft">{t("cp.personalization.wallpaper")} {usingCustom && <span className="font-normal text-ink-faint">- {t("cp.personalization.overridden")}</span>}</h3>
        <div className={clsx("grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4", usingCustom && "opacity-50")}>
          {WALLPAPERS.map((w) => (
            <button
              key={w.id}
              onClick={() => pickBuiltin({ wallpaper: w.id })}
              className={clsx("group relative aspect-video overflow-hidden rounded-xl ring-2 transition", !usingCustom && wallpaper === w.id ? "ring-brand-500" : "ring-transparent hover:ring-slate-300")}
              style={{ background: w.background }}
              title={w.name}
            >
              {!usingCustom && wallpaper === w.id && <Badge />}
              <Label>{w.name}</Label>
            </button>
          ))}
        </div>
      </section>

      {/* Accent */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-ink-soft">{t("cp.personalization.accent")} {usingCustom && <span className="font-normal text-ink-faint">- {t("cp.personalization.overridden")}</span>}</h3>
        <div className={clsx("flex flex-wrap gap-2.5", usingCustom && "opacity-50")}>
          {ACCENTS.map((a) => {
            const on = !usingCustom && accent.toLowerCase() === a.value.toLowerCase();
            return (
              <button
                key={a.id}
                onClick={() => pickBuiltin({ accent: a.value })}
                className={clsx("grid h-9 w-9 place-items-center rounded-full ring-2 ring-offset-2 transition", on ? "ring-slate-400" : "ring-transparent hover:ring-slate-200")}
                style={{ backgroundColor: a.value }}
                title={a.name}
                aria-label={a.name}
              >
                {on && <Check size={15} className="text-white" />}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Badge() {
  return (
    <span className="absolute bottom-1.5 right-1.5 grid h-5 w-5 place-items-center rounded-full bg-brand-600 text-white shadow">
      <Check size={13} />
    </span>
  );
}
function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/50 to-transparent px-2 py-1 text-left text-[11px] font-medium text-white">
      {children}
    </span>
  );
}
