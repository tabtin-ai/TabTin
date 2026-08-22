import { describe, it, expect, vi } from "vitest";

import { withRetry, extractHttpStatusCode } from "./retry.js";

describe("extractHttpStatusCode", () => {
  it("extracts status code from Django API error format", () => {
    expect(extractHttpStatusCode("Django API error 409: conflict")).toBe(409);
    expect(extractHttpStatusCode("Django API error 500: internal")).toBe(500);
    expect(extractHttpStatusCode("Django API error 404: not found")).toBe(404);
  });

  it("returns null for non-matching messages", () => {
    expect(extractHttpStatusCode("timeout")).toBeNull();
    expect(extractHttpStatusCode("network error")).toBeNull();
  });

  it("does not match status codes embedded in paths or body text", () => {
    expect(extractHttpStatusCode("request to /api/v404/resource failed")).toBeNull();
  });
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { label: "test" });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient failure then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, {
      label: "test",
      baseDelay: 1,
      maxDelay: 2,
    });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries exceeded", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("persistent failure"));

    await expect(
      withRetry(fn, { label: "test", maxRetries: 1, baseDelay: 1, maxDelay: 2 })
    ).rejects.toThrow("persistent failure");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 404 error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Django API error 404: Not Found"));

    await expect(
      withRetry(fn, { label: "test", baseDelay: 1 })
    ).rejects.toThrow("404");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 403 error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Django API error 403: Forbidden"));

    await expect(
      withRetry(fn, { label: "test", baseDelay: 1 })
    ).rejects.toThrow("403");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 413 error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Django API error 413: Payload Too Large"));

    await expect(
      withRetry(fn, { label: "test", baseDelay: 1 })
    ).rejects.toThrow("413");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 409 Conflict (CO-1 fix)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Django API error 409: version conflict"));

    await expect(
      withRetry(fn, { label: "test", baseDelay: 1 })
    ).rejects.toThrow("409");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 422 error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Django API error 422: Unprocessable"));

    await expect(
      withRetry(fn, { label: "test", baseDelay: 1 })
    ).rejects.toThrow("422");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 500 error (server transient)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Django API error 500: Internal Server Error"))
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, { label: "test", baseDelay: 1, maxDelay: 2 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects maxRetries=0 (no retries)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail once"));

    await expect(
      withRetry(fn, { label: "test", maxRetries: 0, baseDelay: 1 })
    ).rejects.toThrow("fail once");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
