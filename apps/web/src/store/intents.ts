import { create } from "zustand";

/**
 * One-shot "open this app *at* that place" hand-offs.
 *
 * Global search needs to open Control Panel on the Users page, or File Station
 * in a particular folder. The window manager deliberately knows nothing about
 * what apps contain, so rather than threading payloads through it, the opener
 * leaves an intent here and the app claims it when it mounts or regains focus.
 *
 * Intents are single-use: claiming one clears it, so re-focusing a window later
 * doesn't teleport the user somewhere unexpected.
 */
interface IntentStore {
  intents: Record<string, string>;
  /** Leave an intent for `appId`, to be claimed once. */
  set: (appId: string, value: string) => void;
  /** Claim and clear the pending intent for `appId`, if any. */
  take: (appId: string) => string | null;
}

export const useIntents = create<IntentStore>((set, get) => ({
  intents: {},
  set(appId, value) {
    set((s) => ({ intents: { ...s.intents, [appId]: value } }));
  },
  take(appId) {
    const value = get().intents[appId];
    if (value === undefined) return null;
    set((s) => {
      const next = { ...s.intents };
      delete next[appId];
      return { intents: next };
    });
    return value;
  },
}));
