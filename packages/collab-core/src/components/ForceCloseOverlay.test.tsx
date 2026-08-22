import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ForceCloseOverlay } from "./ForceCloseOverlay.js";
import { CloseCode } from "../types.js";

describe("ForceCloseOverlay", () => {
  it("is positioned inside its application pane instead of the window viewport", () => {
    render(
      <section className="relative" data-testid="application-pane">
        <ForceCloseOverlay
          message={{
            type: "force_close",
            reason: "permission_denied",
            code: CloseCode.PERMISSION_DENIED,
            message: "You do not have permission to access this collaborative resource",
            timestamp: "2026-08-15T00:00:00.000Z",
          }}
        />
      </section>,
    );

    const heading = screen.getByRole("heading", { name: "Disconnected" });
    const overlay = heading.parentElement?.parentElement;

    expect(screen.getByTestId("application-pane").contains(overlay ?? null)).toBe(true);
    expect(overlay?.classList.contains("absolute")).toBe(true);
    expect(overlay?.classList.contains("inset-0")).toBe(true);
    expect(overlay?.classList.contains("fixed")).toBe(false);
  });
});
