/**
 * S-04 回归测试：logStoreSuccess 监控字段 persisted/created/deleted 正确填充
 *
 * 验证 SlideDatabase.logStoreSuccess 使用 Django 返回的统计字段，
 * undefined 时有合理的 fallback（0）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("S-04: SlideDB logStoreSuccess 监控字段", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("Django 返回完整统计时日志正确输出", async () => {
    const { SlideDatabase } = await import("../slide-database.js");
    const db = new SlideDatabase();

    (db as any).logStoreSuccess("slide-123", {
      version: 5,
      persisted: 3,
      created: 1,
      deleted: 2,
    }, 42);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("changed=3"),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("created=1"),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("deleted=2"),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("version=5"),
    );
  });

  it("Django 返回值缺少统计字段时 fallback 为 0", async () => {
    const { SlideDatabase } = await import("../slide-database.js");
    const db = new SlideDatabase();

    (db as any).logStoreSuccess("slide-456", { version: 10 }, 33);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("changed=0"),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("created=0"),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("deleted=0"),
    );
  });
});

describe("S-04: VideoDB logStoreSuccess 监控字段", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("日志输出包含 version 字段", async () => {
    const { VideoDatabase } = await import("../video-database.js");
    const db = new VideoDatabase();

    (db as any).logStoreSuccess("video-789", { version: 7 }, 55);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("version=7"),
    );
  });
});

describe("S-04: CanvasDB logStoreSuccess 监控字段", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("日志输出包含 version 字段", async () => {
    const { CanvasDatabase } = await import("../canvas-database.js");
    const db = new CanvasDatabase();

    (db as any).logStoreSuccess("canvas-001", { version: 3 }, 28);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("version=3"),
    );
  });
});
