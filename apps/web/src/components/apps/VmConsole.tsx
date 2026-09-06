import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import { clsx } from "clsx";
import { Keyboard, MonitorPlay, RefreshCw, X } from "lucide-react";
import type { VmInfo } from "@opennas/shared";
import { apiWsUrl } from "../../lib/api.ts";
import { Button } from "../ui/controls.tsx";

type Status = "connecting" | "connected" | "disconnected";

/**
 * In-browser VNC console for a running VM, via noVNC. Connects to the admin-gated
 * WebSocket proxy (`/api/vms/:name/console`), which bridges to the guest's
 * loopback VNC port. Mounting opens the session; unmounting (or Reconnect)
 * tears it down cleanly.
 */
export function VmConsole({ vm, onClose }: { vm: VmInfo; onClose: () => void }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    setStatus("connecting");
    setError(null);

    let rfb: RFB;
    try {
      rfb = new RFB(el, apiWsUrl(`/vms/${encodeURIComponent(vm.name)}/console`), { shared: true });
    } catch {
      setStatus("disconnected");
      setError("Couldn't start the console.");
      return;
    }
    rfb.scaleViewport = true;
    rfb.background = "#0f172a";
    rfb.focusOnClick = true;

    const onConnect = () => setStatus("connected");
    const onDisconnect = (e: Event) => {
      setStatus("disconnected");
      const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
      setError(clean ? null : "The console connection dropped. The VM may have stopped.");
    };
    const onSecurityFailure = () => {
      setStatus("disconnected");
      setError("The VNC server rejected the connection.");
    };
    rfb.addEventListener("connect", onConnect);
    rfb.addEventListener("disconnect", onDisconnect);
    rfb.addEventListener("securityfailure", onSecurityFailure);
    rfbRef.current = rfb;

    return () => {
      rfb.removeEventListener("connect", onConnect);
      rfb.removeEventListener("disconnect", onDisconnect);
      rfb.removeEventListener("securityfailure", onSecurityFailure);
      try {
        rfb.disconnect();
      } catch {
        /* already gone */
      }
      rfbRef.current = null;
    };
  }, [vm.name, attempt]);

  const statusDot =
    status === "connected" ? "bg-emerald-400" : status === "connecting" ? "bg-amber-400 animate-pulse" : "bg-rose-400";

  return (
    <div
      className="animate-fade-in absolute inset-0 z-30 flex flex-col bg-slate-950/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mx-auto flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-slate-900 shadow-2xl ring-1 ring-slate-900/40">
        <div className="flex items-center gap-2 border-b border-slate-700/60 px-4 py-2.5">
          <MonitorPlay size={18} className="text-slate-300" />
          <h2 className="flex-1 truncate font-semibold text-slate-100">Console - {vm.name}</h2>
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className={clsx("h-2 w-2 rounded-full", statusDot)} />
            {status}
          </span>
          <button
            onClick={() => rfbRef.current?.sendCtrlAltDel()}
            disabled={status !== "connected"}
            className="ml-2 flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700/60 disabled:opacity-40"
            title="Send Ctrl+Alt+Delete"
          >
            <Keyboard size={14} /> Ctrl+Alt+Del
          </button>
          <button
            onClick={() => setAttempt((a) => a + 1)}
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-300 transition hover:bg-slate-700/60"
            title="Reconnect"
          >
            <RefreshCw size={15} />
          </button>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-300 transition hover:bg-slate-700/60" title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="relative min-h-0 flex-1">
          <div ref={screenRef} className="h-full w-full" style={{ minHeight: "55vh" }} />
          {status !== "connected" && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="rounded-xl bg-slate-800/80 px-5 py-4 text-center">
                <p className="text-sm font-medium text-slate-200">
                  {status === "connecting" ? "Connecting to console..." : "Disconnected"}
                </p>
                {error && <p className="mt-1 max-w-xs text-xs text-slate-400">{error}</p>}
                {status === "disconnected" && (
                  <Button className="pointer-events-auto mt-3 h-8 text-xs" onClick={() => setAttempt((a) => a + 1)}>
                    <RefreshCw size={14} /> Reconnect
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
