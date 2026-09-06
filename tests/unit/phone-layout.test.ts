import test from "node:test";
import assert from "node:assert/strict";

/**
 * Phone mode is a behaviour switch, not a stylesheet.
 *
 * The window geometry helpers decide where an app *goes*, and on a phone the
 * answer has to be "the whole screen" - a cascaded 460px window on a 390px
 * viewport is clipped on two sides and then cannot be dragged back, because
 * dragging is one of the things phone mode removes.
 *
 * `matchMedia` and `window` are stubbed here because the module reads them at
 * call time; the browser half (that the bar is reachable, that the switcher
 * lists open apps) was checked in an actual browser at 412px instead.
 */

interface FakeWindow {
  innerWidth: number;
  innerHeight: number;
  matchMedia: (q: string) => { matches: boolean; addEventListener(): void; removeEventListener(): void };
}

function withViewport<T>(width: number, height: number, fn: () => T): T {
  const fake: FakeWindow = {
    innerWidth: width,
    innerHeight: height,
    matchMedia: (q: string) => ({
      // The one query the app asks, answered the way a real browser would.
      matches: /max-width:\s*767px/.test(q) && width <= 767,
      addEventListener() {},
      removeEventListener() {},
    }),
  };
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = fake;
  try {
    return fn();
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
}

const load = async () => await import("../../apps/web/src/store/windows.ts");

test("a phone viewport is recognised at the same breakpoint the CSS uses", async () => {
  const { isPhoneViewport } = await import("../../apps/web/src/lib/viewport.ts");
  assert.equal(withViewport(390, 844, isPhoneViewport), true);
  assert.equal(withViewport(767, 1024, isPhoneViewport), true, "767 is the last phone width");
  assert.equal(withViewport(768, 1024, isPhoneViewport), false, "768 is a tablet and gets windows");
  assert.equal(withViewport(1920, 1080, isPhoneViewport), false);
});

test("on a phone every snap zone is the whole screen", async () => {
  const { snapRect } = await load();
  withViewport(390, 844, () => {
    for (const zone of ["left", "right", "top-left", "bottom-right", "maximize"] as const) {
      const r = snapRect(zone);
      assert.equal(r.x, 0, `${zone} was not full width`);
      assert.equal(r.width, 390, `${zone} was not full width`);
      assert.equal(r.y, 0, `${zone} did not start at the top`);
    }
  });
});

test("on a desktop the snap zones are still halves and quarters", async () => {
  const { snapRect } = await load();
  withViewport(1600, 900, () => {
    const left = snapRect("left");
    assert.equal(left.width, 800, "a left snap should be half the screen");
    const quarter = snapRect("top-right");
    assert.equal(quarter.width, 800);
    assert.ok(quarter.height < left.height, "a quarter should be shorter than a half");
    assert.equal(snapRect("maximize").width, 1600);
  });
});

test("a phone window leaves room for the bottom bar and nothing else", async () => {
  const { phoneRect } = await load();
  withViewport(390, 844, () => {
    const r = phoneRect();
    assert.equal(r.x, 0);
    assert.equal(r.y, 0);
    assert.equal(r.width, 390);
    // 844 minus the 48px bar.
    assert.equal(r.height, 796);
    assert.ok(r.height < 844, "the window must not sit under the bar");
  });
});

test("leaving phone mode never strands a window under the taskbar", async () => {
  // The reported bug: a phone sheet sits at y=0 and fills the screen. On a
  // desktop, y=0 puts the window's own title bar - and its close button -
  // underneath the taskbar, so the window is visible and completely unusable.
  const { useWindows, TASKBAR_HEIGHT } = await load();
  const app = {
    id: "dashboard",
    name: "Dashboard",
    icon: "gauge",
    iconGradient: "from-a to-b",
    category: "system",
    description: "",
    kind: "builtin",
    minRole: "user",
    window: { defaultWidth: 900, defaultHeight: 600, minWidth: 400, minHeight: 300, resizable: true },
    showOnDesktop: true,
  } as never;

  withViewport(390, 844, () => {
    useWindows.setState({ windows: [], focusedId: null, nextZ: 1 });
    useWindows.getState().openApp(app);
    const w = useWindows.getState().windows[0]!;
    assert.equal(w.rect.y, 0, "a phone sheet starts at the very top");
    assert.equal(w.rect.width, 390);
  });

  withViewport(1600, 900, () => {
    useWindows.getState().reflow(true);
    const w = useWindows.getState().windows[0]!;
    assert.ok(w.rect.y >= TASKBAR_HEIGHT, `window left at y=${w.rect.y}, under the taskbar`);
    assert.ok(w.rect.width <= 1600);
    assert.ok(w.rect.x >= 0);
  });
});

test("an ordinary resize keeps a hand-arranged layout, just reachable", async () => {
  const { useWindows, TASKBAR_HEIGHT } = await load();
  const app = {
    id: "files",
    name: "Files",
    icon: "folder",
    iconGradient: "from-a to-b",
    category: "utilities",
    description: "",
    kind: "builtin",
    minRole: "user",
    window: { defaultWidth: 800, defaultHeight: 500, minWidth: 300, minHeight: 200, resizable: true },
    showOnDesktop: true,
  } as never;

  withViewport(1600, 900, () => {
    useWindows.setState({ windows: [], focusedId: null, nextZ: 1 });
    useWindows.getState().openApp(app);
    // Somewhere the user put it.
    useWindows.getState().setRect(useWindows.getState().windows[0]!.id, { x: 1200, y: 400, width: 380, height: 300 });
  });

  // 900 wide, not 700: below 768 the app is in phone mode and reflow correctly
  // does nothing, so a narrower viewport would test the early return instead of
  // the clamp. (The first version of this test picked 700 and duly "failed".)
  withViewport(900, 500, () => {
    useWindows.getState().reflow(false);
    const w = useWindows.getState().windows[0]!;
    assert.ok(w.rect.x <= 900 - 80, `window left at x=${w.rect.x}, off the right edge`);
    assert.ok(w.rect.y >= TASKBAR_HEIGHT);
    assert.ok(w.rect.y <= 500 - 40);
    assert.ok(w.rect.height <= 500 - TASKBAR_HEIGHT);
  });

  // Growing again must not move it back on its own - the layout is the user's.
  withViewport(1600, 900, () => {
    const before = useWindows.getState().windows[0]!.rect;
    useWindows.getState().reflow(false);
    assert.deepEqual(useWindows.getState().windows[0]!.rect, before, "a resize re-arranged windows it should have left alone");
  });
});

test("reflow does nothing while still on a phone", async () => {
  const { useWindows } = await load();
  withViewport(390, 844, () => {
    useWindows.setState({
      windows: [{ id: "x", rect: { x: 0, y: 0, width: 390, height: 796 } } as never],
      focusedId: null,
      nextZ: 1,
    });
    useWindows.getState().reflow(false);
    assert.equal(useWindows.getState().windows[0]!.rect.y, 0, "a phone sheet must stay full-screen");
  });
});
