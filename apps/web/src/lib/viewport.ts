import { useSyncExternalStore } from "react";

/**
 * Is this a phone?
 *
 * A windowed desktop does not survive being made narrow. Dragging, resizing,
 * snapping to half the screen and a row of taskbar buttons all assume a pointer
 * and a canvas bigger than the window you are working in - on a 390px screen
 * every one of them is either impossible or actively in the way. So OpenNAS
 * answers this question once and then behaves *differently*, rather than
 * shrinking a desktop until it technically fits.
 *
 * ## Why width alone
 *
 * The obvious refinement is to test `pointer: coarse` too, and it is wrong here.
 * A touchscreen laptop is a desktop; a phone plugged into a monitor is not a
 * phone. The thing that decides whether a floating window is usable is how much
 * room there is to float it in - so that is what gets asked. 768px is Tailwind's
 * `md`, which the rest of the app already breaks at, and keeping one boundary
 * means the layout and the behaviour can never disagree about which mode they
 * are in.
 *
 * Reactive on purpose: rotating a phone, or dragging a desktop browser narrow,
 * switches modes live rather than leaving a half-applied layout behind.
 */

const QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  // Orientation changes on iOS have historically fired resize but not the media
  // query listener, so both are watched.
  window.addEventListener("resize", onChange);
  return () => {
    mq.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
  };
}

function snapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

export function useIsPhone(): boolean {
  // Server snapshot is `false`: the desktop is the safe assumption, because
  // rendering a desktop briefly on a phone is a flicker while rendering a phone
  // UI on a desktop looks broken.
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/**
 * The same question, outside React.
 *
 * The window store needs it to place a window, and a store is not a component.
 * Reading `matchMedia` directly is fine there because the store only ever asks
 * at the moment it acts.
 */
export function isPhoneViewport(): boolean {
  return snapshot();
}
