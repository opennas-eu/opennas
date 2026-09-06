import { useEffect, useRef } from "react";
import { appContentUrl } from "../../lib/api.ts";
import { postThemeToApp, registerApp, registerCloseGuard } from "../../lib/app-bridge.ts";
import { TASKBAR_HEIGHT, useWindows, type WindowInstance } from "../../store/windows.ts";

/**
 * Renders an installed third-party app inside a sandboxed iframe (opaque origin -
 * no access to OpenNAS cookies/DOM/other apps) and wires it to the host bridge so
 * it can use its granted SDK capabilities. Theme changes are pushed in; window
 * title, badge, size and close requests come back out.
 *
 * Everything the app can ask of its window is a *request*, never a command: a
 * size is clamped to the screen, and a close guard is asked rather than obeyed,
 * so an app can't pin itself open or grow past the desktop.
 */
export function AppFrame({ win }: { win: WindowInstance }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const setTitle = useWindows((s) => s.setTitle);
  const setBadge = useWindows((s) => s.setBadge);
  const setRect = useWindows((s) => s.setRect);
  const toggleMaximize = useWindows((s) => s.toggleMaximize);
  const close = useWindows((s) => s.close);
  const app = win.app;

  useEffect(() => {
    const source = ref.current?.contentWindow;
    if (!source) return;
    const unregister = registerApp({
      manifest: app,
      source,
      onSetTitle: (t) => setTitle(win.id, t || app.name),
      onClose: () => close(win.id),
      onBadge: (count) => setBadge(win.id, count),
      onRequestSize: ({ width, height }) => {
        // Clamped to what actually fits: an app asking for 10000px would
        // otherwise put its own controls off-screen.
        setRect(win.id, {
          width: Math.max(280, Math.min(Math.round(width), window.innerWidth)),
          height: Math.max(180, Math.min(Math.round(height), window.innerHeight - TASKBAR_HEIGHT)),
        });
      },
      onFullscreen: (on) => {
        if (on !== useWindows.getState().windows.find((w) => w.id === win.id)?.maximized) toggleMaximize(win.id);
      },
    });
    const unguard = registerCloseGuard(win.id, source);
    // The initial theme arrives in the SDK's ready() handshake; push later changes.
    const theme = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");
    const observer = new MutationObserver(() => postThemeToApp(source, theme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      unregister();
      unguard();
      observer.disconnect();
    };
  }, [app, win.id, setTitle, setBadge, setRect, toggleMaximize, close]);

  // A development app is loaded from its own dev server instead of from the
  // packaged content. The sandbox is deliberately identical: no
  // allow-same-origin, so it still gets an opaque origin, and the postMessage
  // broker still identifies it by this iframe's window rather than by origin.
  // The only thing that differs is where the bytes come from.
  const src = app.devUrl ? app.devUrl : appContentUrl(app.id, app.entry || "index.html");

  return (
    <iframe
      ref={ref}
      title={app.name}
      src={src}
      className="h-full w-full border-0 bg-white"
      sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
      allow="clipboard-write; fullscreen"
    />
  );
}
