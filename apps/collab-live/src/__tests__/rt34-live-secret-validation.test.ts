/**
 * RT-34 回归测试：LIVE_SECRET 启动校验增强
 *
 * 验证 env.ts 中 LIVE_SECRET IIFE 的校验逻辑：
 * 1. production 环境下缺少 LIVE_SECRET 应抛错
 * 2. production 环境下使用默认密钥应抛错
 * 3. production 环境下密钥过短应抛错
 * 4. COLLAB_LIVE_REQUIRE_SECRET=true 时即使 NODE_ENV=development 也拒绝默认密钥
 * 5. 正常配置的密钥应通过
 *
 * 注意：LIVE_SECRET 在 env 模块加载时由 IIFE 计算，需用 vi.resetModules + 动态 import 测试不同环境变量组合。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ENV_MODULE_PATH = new URL("../env.ts", import.meta.url).href;

async function loadEnv(): Promise<{ env: { LIVE_SECRET: string } }> {
  return import(ENV_MODULE_PATH);
}

describe("RT-34: LIVE_SECRET 启动校验", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("COLLAB_LIVE_SECRET", undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("1. production 环境下缺少 LIVE_SECRET 应抛错", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIVE_SECRET", ""); // 空字符串等同于未设置（falsy）
    vi.stubEnv("COLLAB_LIVE_REQUIRE_SECRET", "");

    await expect(loadEnv()).rejects.toThrow(/process\.exit\(1\)/);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/COLLAB_LIVE_SECRET.*must be.*set/));
  });

  it("2. production 环境下使用默认密钥应抛错", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIVE_SECRET", "collab-live-dev-secret");
    vi.stubEnv("COLLAB_LIVE_REQUIRE_SECRET", undefined);

    await expect(loadEnv()).rejects.toThrow(/process\.exit\(1\)/);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/default dev secret/));
  });

  it("3. production 环境下密钥过短应抛错", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIVE_SECRET", "short");
    vi.stubEnv("COLLAB_LIVE_REQUIRE_SECRET", undefined);

    await expect(loadEnv()).rejects.toThrow(/process\.exit\(1\)/);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/at least 16 characters/));
  });

  it("4. COLLAB_LIVE_REQUIRE_SECRET=true 时即使 NODE_ENV=development 也拒绝默认密钥", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LIVE_SECRET", "collab-live-dev-secret");
    vi.stubEnv("COLLAB_LIVE_REQUIRE_SECRET", "true");

    await expect(loadEnv()).rejects.toThrow(/process\.exit\(1\)/);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/default dev secret/));
  });

  it("5. 正常配置的密钥应通过", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIVE_SECRET", "a-secure-random-secret-at-least-16-chars");
    vi.stubEnv("COLLAB_LIVE_REQUIRE_SECRET", undefined);

    const mod = await loadEnv();
    expect(mod.env.LIVE_SECRET).toBe("a-secure-random-secret-at-least-16-chars");
  });

  it("5a. 部署模板使用 COLLAB_LIVE_SECRET 时应映射为运行时密钥", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIVE_SECRET", undefined);
    vi.stubEnv("COLLAB_LIVE_SECRET", "compose-secret-at-least-16-chars");
    vi.stubEnv("COLLAB_LIVE_REQUIRE_SECRET", "true");

    const mod = await loadEnv();
    expect(mod.env.LIVE_SECRET).toBe("compose-secret-at-least-16-chars");
  });

  it("5b. development 下未设置 LIVE_SECRET 时使用默认密钥（不要求 requireSecret）", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LIVE_SECRET", undefined);
    vi.stubEnv("COLLAB_LIVE_REQUIRE_SECRET", undefined);

    const mod = await loadEnv();
    expect(mod.env.LIVE_SECRET).toBe("collab-live-dev-secret");
  });

  it("5c. development 下有效密钥应通过", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LIVE_SECRET", "custom-dev-secret-16ch");
    vi.stubEnv("COLLAB_LIVE_REQUIRE_SECRET", undefined);

    const mod = await loadEnv();
    expect(mod.env.LIVE_SECRET).toBe("custom-dev-secret-16ch");
  });
});
