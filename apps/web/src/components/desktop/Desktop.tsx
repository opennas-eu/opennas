import { useEffect, useRef, useState } from "react";
import { Taskbar } from "./Taskbar.tsx";
import { DesktopIcons } from "./DesktopIcons.tsx";
import { AppLauncher } from "./AppLauncher.tsx";
import { GlobalSearch } from "./GlobalSearch.tsx";
import { Onboarding } from "./Onboarding.tsx";
import { NotificationWatchers } from "./NotificationWatchers.tsx";
import { Window } from "./Window.tsx";
import { useApps } from "../../store/apps.ts";
import { useSystem } from "../../store/system.ts";
import { useWindows } from "../../store/windows.ts";
import { usePrefs } from "../../store/prefs.ts";
import { useAuth } from "../../store/auth.ts";
import { useThemes } from "../../store/themes.ts";
import { resolveWallpaper } from "../../lib/appearance.ts";
import { APP_COMPONENTS, UnknownApp } from "../apps/registry.tsx";
import { AppFrame } from "../apps/AppFrame.tsx";
import { startAppBridge } from "../../lib/app-bridge.ts";
import { useGlobalShortcuts } from "../../lib/shortcuts.ts";
import { useIsPhone } from "../../lib/viewport.ts";

export function Desktop() {
  const loadApps = useApps((s) => s.load);
  const windows = useWindows((s) => s.windows);
  const focusedId = useWindows((s) => s.focusedId);
  const connect = useSystem((s) => s.connect);
  const disconnect = useSystem((s) => s.disconnect);
  const loadPrefs = usePrefs((s) => s.load);
  const preferences = usePrefs((s) => s.preferences);
  const loadThemes = useThemes((s) => s.load);
  const themes = useThemes((s) => s.themes);
  const searchOpen = useWindows((s) => s.searchOpen);
  const setSearch = useWindows((s) => s.setSearch);

  useGlobalShortcuts();
  const phone = useIsPhone();
  const reflow = useWindows((s) => s.reflow);

  /**
   * Keep every window reachable when the viewport changes.
   *
   * Leaving phone mode is the case that bit: a phone sheet sits at y=0 and fills
   * the screen, and on a desktop y=0 puts the window's own title bar - with its
   * close button - underneath the taskbar. The window is then visible and
   * completely unusable. Those windows are re-placed at their normal size.
   *
   * An ordinary resize gets a clamp instead, because a layout somebody arranged
   * by hand should survive a browser window being nudged. Without either, a
   * desktop dragged narrow strands windows off the right-hand edge with no way
   * back - there was no resize handling here at all.
   */
  const wasPhone = useRef(phone);
  useEffect(() => {
    const leavingPhone = wasPhone.current && !phone;
    wasPhone.current = phone;
    reflow(leavingPhone);
  }, [phone, reflow]);

  useEffect(() => {
    if (phone) return;
    const onResize = () => reflow(false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [phone, reflow]);

  // First-run wizard: admins only (a regular user can't create shares or turn on
  // services, so there'd be nothing in it for them), and only once prefs have
  // actually loaded - otherwise it flashes up before we know it's been dismissed.
  const prefsLoaded = usePrefs((s) => s.loaded);
  const isAdmin = useAuth((s) => s.session?.user.role === "admin");
  const [onboardingDone, setOnboardingDone] = useState(false);
  const showOnboarding = prefsLoaded && isAdmin && !preferences.onboarded && !onboardingDone;

  useEffect(() => {
    void loadApps();
    void loadPrefs();
    void loadThemes();
    startAppBridge(); // host bridge for installed third-party apps
  }, [loadApps, loadPrefs, loadThemes]);

  // Keep a live telemetry connection for the taskbar widgets while logged in.
  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return (
    <div
      className="opennas-wallpaper relative h-full w-full overflow-hidden"
      style={{ background: resolveWallpaper(preferences, themes) }}
    >
      {/*
        Desktop icons are a mouse idea: a scatter of shortcuts on a canvas you
        can see all of at once. On a phone the app grid *is* the home screen, so
        showing both would be two ways to do the same thing, one of them cramped.
      */}
      {!phone && <DesktopIcons />}

      {windows.map((win) => {
        const Body = APP_COMPONENTS[win.app.id] ?? UnknownApp;
        return (
          <Window key={win.id} win={win} focused={focusedId === win.id}>
            {win.app.kind === "external" ? <AppFrame win={win} /> : <Body win={win} />}
          </Window>
        );
      })}

      {/*
        With nothing open, a phone shows the app grid rather than an empty
        wallpaper - the same decision every phone OS makes, and the alternative
        here is a blank screen with a bar at the bottom.
      */}
      <AppLauncher alwaysOpen={phone && windows.length === 0} />
      {searchOpen && <GlobalSearch onClose={() => setSearch(false)} />}
      {showOnboarding && <Onboarding onClose={() => setOnboardingDone(true)} />}
      <Taskbar />
      <NotificationWatchers />
    </div>
  );
}
