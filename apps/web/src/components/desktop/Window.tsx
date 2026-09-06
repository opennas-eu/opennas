import { useRef, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { ChevronLeft, Maximize2, Minus, X } from "lucide-react";
import { AppIcon } from "../ui/Icon.tsx";
import { TASKBAR_HEIGHT, snapRect, useWindows, type SnapZone, type WindowInstance } from "../../store/windows.ts";
import { useT } from "../../i18n/index.ts";
import { useIsPhone } from "../../lib/viewport.ts";
import { requestWindowClose } from "../../lib/app-bridge.ts";

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export function Window({ win, focused, children }: { win: WindowInstance; focused: boolean; children: ReactNode }) {
  const t = useT();
  const phone = useIsPhone();
  const { focus, close, minimize, toggleMaximize, setRect, snap } = useWindows();
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  /** Snap zone the pointer is currently over while dragging, if any. */
  const [snapHint, setSnapHint] = useState<SnapZone | null>(null);

  /**
   * Which screen edge the pointer is in, if any. Corners are checked before
   * edges so a pointer in the top-left reads as a quarter, not "maximize".
   */
  function zoneForPointer(x: number, y: number): SnapZone | null {
    if (!win.app.window.resizable) return null;
    const edge = 12;
    const corner = 80;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nearLeft = x <= edge;
    const nearRight = x >= vw - edge;
    const nearTop = y <= TASKBAR_HEIGHT + edge;
    const nearBottom = y >= vh - edge;
    if (nearLeft && y <= TASKBAR_HEIGHT + corner) return "top-left";
    if (nearRight && y <= TASKBAR_HEIGHT + corner) return "top-right";
    if (nearLeft && y >= vh - corner) return "bottom-left";
    if (nearRight && y >= vh - corner) return "bottom-right";
    if (nearLeft) return "left";
    if (nearRight) return "right";
    if (nearTop) return "maximize";
    if (nearBottom) return null;
    return null;
  }

  function onTitlePointerDown(e: React.PointerEvent) {
    if (win.maximized) return;
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    focus(win.id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: win.rect.x, origY: win.rect.y };
  }

  function onTitlePointerMove(e: React.PointerEvent) {
    const d = dragState.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const maxX = window.innerWidth - 80;
    const maxY = window.innerHeight - 40;
    setRect(win.id, {
      x: Math.min(maxX, d.origX + dx),
      y: Math.max(TASKBAR_HEIGHT, Math.min(maxY, d.origY + dy)),
    });
    setSnapHint(zoneForPointer(e.clientX, e.clientY));
  }

  function onTitlePointerUp(e: React.PointerEvent) {
    const wasDragging = dragState.current !== null;
    dragState.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    // Commit the snap the preview was showing, so what you saw is what you get.
    if (wasDragging && snapHint) snap(win.id, snapHint);
    setSnapHint(null);
  }

  function startResize(dir: ResizeDir, e: React.PointerEvent) {
    if (win.maximized || !win.app.window.resizable) return;
    e.preventDefault();
    e.stopPropagation();
    focus(win.id);
    const start = { px: e.clientX, py: e.clientY, ...win.rect };
    const minW = win.app.window.minWidth;
    const minH = win.app.window.minHeight;

    function move(ev: PointerEvent) {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      let { x, y, width, height } = start;
      if (dir.includes("e")) width = Math.max(minW, start.width + dx);
      if (dir.includes("s")) height = Math.max(minH, start.height + dy);
      if (dir.includes("w")) {
        width = Math.max(minW, start.width - dx);
        x = start.x + (start.width - width);
      }
      if (dir.includes("n")) {
        height = Math.max(minH, start.height - dy);
        y = Math.max(TASKBAR_HEIGHT, start.y + (start.height - height));
      }
      setRect(win.id, { x, y, width, height });
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  if (win.minimized) return null;

  /**
   * On a phone an app is a full-screen page, not a window.
   *
   * Everything a window *is* - a frame you move, resize, snap and stack - needs
   * a canvas bigger than the thing inside it. A phone has no such canvas, so the
   * chrome is reduced to the one control that still means something (go back)
   * and the app gets the whole screen. Switching between open apps moves to the
   * bottom bar, where a thumb can reach it.
   */
  if (phone) {
    return (
      <div
        className={clsx(
          "absolute inset-x-0 top-0 flex flex-col overflow-hidden bg-white",
          win.closing ? "window-exit" : "window-enter",
        )}
        style={{ height: `calc(100% - ${TASKBAR_HEIGHT}px)`, zIndex: win.zIndex }}
        onPointerDown={() => focus(win.id)}
      >
        <div
          className="flex h-12 shrink-0 select-none items-center gap-2 border-b border-slate-200 bg-slate-50/80 px-2"
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <button
            aria-label={t("desktop.close")}
            onClick={() => {
              void requestWindowClose(win.id).then((allow) => {
                if (allow) close(win.id);
              });
            }}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-soft active:bg-slate-200"
          >
            <ChevronLeft size={20} />
          </button>
          <span
            className={clsx(
              "grid h-6 w-6 shrink-0 place-items-center rounded-md bg-gradient-to-br text-white",
              win.app.iconGradient,
            )}
          >
            <AppIcon app={win.app} className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-soft">{win.title}</span>
        </div>
        <div className="opennas-scroll min-h-0 flex-1 overflow-auto overscroll-contain bg-white">{children}</div>
      </div>
    );
  }

  const preview = snapHint ? snapRect(snapHint) : null;

  return (
    <>
      {/* Where the window will land if you let go here. */}
      {preview && (
        <div
          className="pointer-events-none fixed rounded-xl border-2 border-brand-400/80 bg-brand-400/20 transition-all duration-100"
          style={{
            left: preview.x,
            top: preview.y,
            width: preview.width,
            height: preview.height,
            zIndex: win.zIndex - 1,
          }}
          aria-hidden
        />
      )}
    <div
      className={clsx(
        "absolute flex flex-col overflow-hidden rounded-xl bg-white",
        win.closing ? "window-exit" : "window-enter",
        win.animating && "window-animate",
        focused ? "ring-1 ring-black/10" : "ring-1 ring-black/5",
      )}
      style={{
        left: win.rect.x,
        top: win.rect.y,
        width: win.rect.width,
        height: win.rect.height,
        zIndex: win.zIndex,
        boxShadow: focused
          ? "var(--shadow-window)"
          : "0 6px 24px -8px rgb(2 6 23 / 0.3)",
      }}
      onPointerDown={() => focus(win.id)}
    >
      {/* Title bar */}
      <div
        className={clsx(
          "flex h-10 shrink-0 select-none items-center gap-2 border-b px-3",
          focused ? "border-slate-200 bg-slate-50/80" : "border-slate-100 bg-white",
        )}
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
        onDoubleClick={() => toggleMaximize(win.id)}
        style={{ cursor: win.maximized ? "default" : "grab" }}
      >
        <span
          className={clsx(
            "grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br text-white",
            win.app.iconGradient,
          )}
        >
          <AppIcon app={win.app} className="h-3.5 w-3.5" />
        </span>
        <span className="truncate text-sm font-medium text-ink-soft">{win.title}</span>

        <div className="ml-auto flex items-center gap-1" data-no-drag>
          <TitleButton label={t("desktop.minimize")} onClick={() => minimize(win.id)}>
            <Minus size={14} />
          </TitleButton>
          {win.app.window.resizable && (
            <TitleButton label={win.maximized ? t("desktop.restore") : t("desktop.maximize")} onClick={() => toggleMaximize(win.id)}>
              <Maximize2 size={12} />
            </TitleButton>
          )}
          <TitleButton
            label={t("desktop.close")}
            danger
            onClick={() => {
              // An app may ask to be consulted first (unsaved work). It gets a
              // brief moment to answer and the close proceeds regardless if it
              // doesn't - the guard is a courtesy, not a veto.
              void requestWindowClose(win.id).then((allow) => { if (allow) close(win.id); });
            }}
          >
            <X size={14} />
          </TitleButton>
        </div>
      </div>

      {/* Content */}
      <div className="opennas-scroll min-h-0 flex-1 overflow-auto bg-white">{children}</div>

      {/* Resize handles */}
      {!win.maximized && win.app.window.resizable && (
        <>
          <Handle dir="n" onDown={startResize} className="left-2 right-2 top-0 h-1.5 cursor-ns-resize" />
          <Handle dir="s" onDown={startResize} className="bottom-0 left-2 right-2 h-1.5 cursor-ns-resize" />
          <Handle dir="e" onDown={startResize} className="bottom-2 right-0 top-2 w-1.5 cursor-ew-resize" />
          <Handle dir="w" onDown={startResize} className="bottom-2 left-0 top-2 w-1.5 cursor-ew-resize" />
          <Handle dir="ne" onDown={startResize} className="right-0 top-0 h-3 w-3 cursor-nesw-resize" />
          <Handle dir="nw" onDown={startResize} className="left-0 top-0 h-3 w-3 cursor-nwse-resize" />
          <Handle dir="se" onDown={startResize} className="bottom-0 right-0 h-3 w-3 cursor-nwse-resize" />
          <Handle dir="sw" onDown={startResize} className="bottom-0 left-0 h-3 w-3 cursor-nesw-resize" />
        </>
      )}
    </div>
    </>
  );
}

function TitleButton({
  children,
  onClick,
  label,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={clsx(
        "grid h-7 w-7 place-items-center rounded-md text-ink-faint transition-colors",
        danger ? "hover:bg-rose-500 hover:text-white" : "hover:bg-slate-500/12 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function Handle({
  dir,
  onDown,
  className,
}: {
  dir: ResizeDir;
  onDown: (dir: ResizeDir, e: React.PointerEvent) => void;
  className: string;
}) {
  return (
    <div
      onPointerDown={(e) => onDown(dir, e)}
      className={clsx("absolute z-10 touch-none", className)}
    />
  );
}
