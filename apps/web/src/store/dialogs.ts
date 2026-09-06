import { create } from "zustand";

/**
 * In-app confirm/prompt dialogs - a drop-in, promise-based replacement for the
 * browser's `window.confirm` / `window.prompt`, so destructive actions (wipe a
 * disk, delete a user, end a process...) use the OpenNAS look instead of the bare
 * OS dialog. Call `confirmDialog(...)` / `promptDialog(...)` from anywhere and
 * `await` the result; `<DialogHost />` (mounted once in App) renders them.
 */

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  defaultValue?: string;
  placeholder?: string;
  inputType?: "text" | "password";
}

export interface DialogRequest {
  id: string;
  kind: "confirm" | "prompt";
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  defaultValue: string;
  placeholder?: string;
  inputType: "text" | "password";
  /** Resolves the awaiting caller. boolean for confirm, string|null for prompt. */
  resolve: (value: boolean | string | null) => void;
}

interface DialogStore {
  /** FIFO queue; the head is the one currently shown. */
  queue: DialogRequest[];
  push: (request: DialogRequest) => void;
  /** Resolve the head dialog and advance the queue. */
  resolveTop: (value: boolean | string | null) => void;
}

export const useDialogs = create<DialogStore>((set, get) => ({
  queue: [],
  push: (request) => set((s) => ({ queue: [...s.queue, request] })),
  resolveTop: (value) => {
    const [top, ...rest] = get().queue;
    if (top) top.resolve(value);
    set({ queue: rest });
  },
}));

let counter = 0;
function nextId(): string {
  return `dlg-${Date.now().toString(36)}-${counter++}`;
}

/** Ask the user to confirm. Resolves true if they confirm, false otherwise. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogs.getState().push({
      id: nextId(),
      kind: "confirm",
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? "Confirm",
      cancelLabel: options.cancelLabel ?? "Cancel",
      danger: options.danger ?? false,
      defaultValue: "",
      inputType: "text",
      resolve: (v) => resolve(v === true),
    });
  });
}

/** Ask the user for a value. Resolves the string, or null if cancelled. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.getState().push({
      id: nextId(),
      kind: "prompt",
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? "OK",
      cancelLabel: options.cancelLabel ?? "Cancel",
      danger: false,
      defaultValue: options.defaultValue ?? "",
      placeholder: options.placeholder,
      inputType: options.inputType ?? "text",
      resolve: (v) => resolve(typeof v === "string" ? v : null),
    });
  });
}
