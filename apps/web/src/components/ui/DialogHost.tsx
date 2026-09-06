import { useEffect, useRef, useState } from "react";
import { AlertTriangle, HelpCircle } from "lucide-react";
import { clsx } from "clsx";
import type { DialogRequest } from "../../store/dialogs.ts";
import { useDialogs } from "../../store/dialogs.ts";
import { Button, Input } from "./controls.tsx";

/**
 * Renders the active in-app dialog (see store/dialogs.ts). Mounted once near the
 * root so any component can `await confirmDialog(...)` / `promptDialog(...)`.
 */
export function DialogHost() {
  const current = useDialogs((s) => s.queue[0] ?? null);
  if (!current) return null;
  // Key by id so each dialog gets a fresh input/state.
  return <DialogCard key={current.id} request={current} />;
}

function DialogCard({ request }: { request: DialogRequest }) {
  const resolveTop = useDialogs((s) => s.resolveTop);
  const [value, setValue] = useState(request.defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const isPrompt = request.kind === "prompt";
  const accept = () => resolveTop(isPrompt ? value : true);
  const cancel = () => resolveTop(isPrompt ? null : false);

  // Focus the input (prompt) or the confirm button (confirm) on open, and wire
  // Escape to cancel everywhere.
  useEffect(() => {
    (isPrompt ? inputRef.current : confirmRef.current)?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="animate-fade-in fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-slate-900/10"
      >
        <div className="flex gap-3.5">
          <span
            className={clsx(
              "grid h-10 w-10 shrink-0 place-items-center rounded-full",
              request.danger ? "bg-rose-100 text-rose-600" : "bg-brand-100 text-brand-600",
            )}
          >
            {request.danger ? <AlertTriangle size={20} /> : <HelpCircle size={20} />}
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 className="text-base font-semibold text-ink">{request.title}</h2>
            {request.message && (
              <p className="mt-1 whitespace-pre-line text-sm text-ink-faint">{request.message}</p>
            )}
            {isPrompt && (
              <form
                className="mt-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  accept();
                }}
              >
                <Input
                  ref={inputRef}
                  type={request.inputType}
                  value={value}
                  placeholder={request.placeholder}
                  onChange={(e) => setValue(e.target.value)}
                />
              </form>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" className="h-9" onClick={cancel}>
            {request.cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={request.danger ? "danger" : "primary"}
            className="h-9"
            onClick={accept}
          >
            {request.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
