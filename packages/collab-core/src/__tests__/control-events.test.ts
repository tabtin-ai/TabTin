import { describe, expect, it } from "vitest";
import { isControlEvent, isInvalidationEvent } from "../controlEvents.js";

describe("collab control events", () => {
  it("recognizes invalidation events", () => {
    expect(isInvalidationEvent("table.view.invalidate")).toBe(true);
    expect(isInvalidationEvent("doc.outline.invalidate")).toBe(true);
    expect(isInvalidationEvent("table.events.delta")).toBe(false);
  });

  it("recognizes control events separately from domain delta events", () => {
    expect(isControlEvent("table.control.progress")).toBe(true);
    expect(isControlEvent("video.control.collab_status")).toBe(true);
    expect(isControlEvent("slide.thumbnail.invalidate")).toBe(true);
    expect(isControlEvent("table.events.delta")).toBe(false);
    expect(isControlEvent("canvas.records.patch")).toBe(false);
  });
});
