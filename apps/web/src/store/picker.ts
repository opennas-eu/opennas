import { create } from "zustand";
import type { AppManifest } from "@opennas/shared";
import type { PickerChoice, PickerRequest } from "../components/apps/AppFilePicker.tsx";

/**
 * The queue behind the host-drawn file picker.
 *
 * Mirrors `dialogs.ts`: a request is pushed with a resolver, the host renders
 * the head of the queue, and the awaiting caller gets whatever the user chose.
 * Keeping it a queue matters because two apps can ask at once and a dropped
 * request would leave an app waiting forever.
 */

interface Queued extends PickerRequest {
  id: string;
  resolve: (choice: PickerChoice | null) => void;
}

interface PickerStore {
  queue: Queued[];
  push: (req: Queued) => void;
  resolveTop: (choice: PickerChoice | null) => void;
}

export const usePicker = create<PickerStore>((set, get) => ({
  queue: [],
  push: (req) => set((s) => ({ queue: [...s.queue, req] })),
  resolveTop: (choice) => {
    const [top, ...rest] = get().queue;
    if (top) top.resolve(choice);
    set({ queue: rest });
  },
}));

let counter = 0;

/**
 * Ask the user to pick a file or folder on the app's behalf.
 *
 * Resolves null when they cancel - apps must handle that, since "no" is a
 * perfectly ordinary answer to being asked for access.
 */
export function pickForApp(
  app: AppManifest,
  options: { select?: "file" | "dir"; mode?: "read" | "readwrite"; title?: string } = {},
): Promise<PickerChoice | null> {
  return new Promise((resolve) => {
    usePicker.getState().push({
      id: `pick-${Date.now().toString(36)}-${counter++}`,
      app,
      select: options.select ?? "dir",
      mode: options.mode ?? "read",
      title: options.title?.slice(0, 120),
      resolve,
    });
  });
}
