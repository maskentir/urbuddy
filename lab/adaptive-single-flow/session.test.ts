import { describe, expect, test } from "vitest";

import { act, advance, citedIds, initial, lifecycle, noteFlagged } from "./session.js";

describe("adaptive single flow lifecycle", () => {
  test("go-question suggestion is pending before readiness and ready after", () => {
    expect(lifecycle("go-question", 305)).toBe("pending");
    expect(lifecycle("go-question", 315)).toBe("ready");
  });

  test("watermark invalidates the ready suggestion without deleting it", () => {
    expect(lifecycle("go-question", 340)).toBe("invalidated");
    expect(lifecycle("window-question", 340)).toBe("invalidated");
  });

  test("non-invalidating clarification marks the suggestion changed, still valid", () => {
    expect(lifecycle("window-question", 280)).toBe("changed");
  });

  test("question without authored suggestion reports insufficient evidence", () => {
    expect(lifecycle("cursor-probe", 400)).toBe("insufficient");
  });

  test("opening the drawer never switches the retained question automatically", () => {
    let state = act(advance(initial(300, true), 315, false), "r");
    expect(state.question).toBe("go-question");
    state = advance(state, 380, false);
    expect(state.question).toBe("go-question");
    expect(state.view).toBe("respond");
  });

  test("user note survives invalidation and is flagged for review", () => {
    let state = act(advance(initial(300, true), 315, false), "r");
    state = act(state, "x");
    state = act(state, "input:H");
    state = act(state, "input:i");
    state = act(state, "enter");
    state = advance(state, 340, false);
    expect(state.text).toBe("Hi");
    expect(noteFlagged(state)).toBe(true);
    expect(state.view).toBe("respond");
  });

  test("context browsing stays inside the cited set and clamps at the ends", () => {
    let state = act(advance(initial(150, true), 350, false), "c");
    const cited = citedIds(state);
    expect(cited).toEqual(["opening-1", "opening-2", "join"]);
    expect(state.contextSel).toBe("opening-1");
    state = act(state, "left");
    expect(state.contextSel).toBe("opening-1");
    for (let i = 0; i < cited.length; i += 1) state = act(state, "right");
    expect(state.contextSel).toBe("join");
    state = act(state, "right");
    expect(state.contextSel).toBe("join");
  });

  test("advancing past a recap boundary resyncs the cited selection", () => {
    let state = act(advance(initial(150, true), 350, false), "c");
    expect(state.contextSel).toBe("opening-1");
    state = advance(state, 385, false);
    expect(state.contextSel).toBe("go-question");
    expect(citedIds(state)).toEqual(["go-question", "watermark"]);
  });

  test("escape returns to live from every view in one action", () => {
    for (const key of ["c", "r"] as const) {
      const opened = act(advance(initial(300, true), 315, false), key);
      expect(act(opened, "esc").view).toBe("live");
    }
    const closed = initial(480);
    expect(act(closed, "esc").view).toBe("closed");
  });

  test("transport keys are inert outside replay mode", () => {
    const state = initial(300, false);
    expect(act(state, " ").running).toBe(false);
    expect(act(state, ".").at).toBe(300);
    const replaying = initial(300, true);
    expect(act(replaying, " ").running).toBe(true);
    expect(act(replaying, ".").at).toBeGreaterThan(300);
  });
});
