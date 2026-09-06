import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { clsx } from "clsx";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a separator above this item. */
  separator?: boolean;
}

/**
 * A lightweight right-click menu, portaled to <body> so it escapes the window's
 * overflow clipping. Closes on outside click, Escape, scroll, or resize.
 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Keep the menu fully on-screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const nx = Math.min(x, window.innerWidth - width - 8);
    const ny = Math.min(y, window.innerHeight - height - 8);
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny) });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className="animate-pop fixed z-[10000] min-w-52 overflow-hidden rounded-xl bg-white p-1 text-ink shadow-2xl ring-1 ring-black/5"
    >
      {items.map((it, i) => (
        <div key={i}>
          {it.separator && <div className="my-1 h-px bg-slate-100" />}
          <button
            disabled={it.disabled}
            onClick={() => { if (!it.disabled) { it.onClick(); onClose(); } }}
            className={clsx(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
              it.disabled
                ? "cursor-not-allowed text-ink-faint opacity-60"
                : it.danger
                  ? "text-rose-600 hover:bg-rose-50"
                  : "text-ink-soft hover:bg-slate-100",
            )}
          >
            {it.icon && <span className="grid h-4 w-4 shrink-0 place-items-center">{it.icon}</span>}
            <span className="truncate">{it.label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
