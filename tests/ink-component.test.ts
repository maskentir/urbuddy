import { StartupMessage } from "@presentation/ink-smoke";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

describe("ink component", () => {
  it("renders the startup frame and unmounts cleanly", () => {
    const rendered = render(StartupMessage({ version: "9.9.9", sessionId: "s-7" }));
    expect(rendered.lastFrame()).toContain("urbuddy 9.9.9 ready (session s-7)");
    rendered.unmount();
    expect(rendered.frames.length).toBeGreaterThan(0);
  });
});
