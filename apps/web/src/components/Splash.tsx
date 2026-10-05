import { Logo } from "./Logo.tsx";
import { useT } from "../i18n/index.ts";

export function Splash() {
  const t = useT();
  return (
    <div className="opennas-wallpaper flex h-full w-full flex-col items-center justify-center gap-6">
      <div className="animate-pop">
        <Logo size={64} />
      </div>
      <div className="flex items-center gap-2 text-sm text-white/60">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white/80" />
        {t("ui.splash.starting")}
      </div>
    </div>
  );
}
