/**
 * Anti-detect bridge — 让爬取工具可选地注入反检测 headers
 *
 * 架构决策：crawl-integration（HTTP 引擎）不直接依赖 anti-detect，
 * 反检测能力在此编排层注入。调用方在构建 HTTP 请求时合并这些 headers。
 */

export interface AntiDetectHeadersConfig {
  preset?: 'desktop' | 'mobile' | 'tablet';
  userAgent?: string;
}

/**
 * 从 anti-detect 包获取反检测 headers（UA + Client Hints）。
 * Dynamic import 避免在不需要反检测的场景加载整个 anti-detect 包。
 */
export async function resolveAntiDetectHeaders(
  config?: AntiDetectHeadersConfig,
): Promise<Record<string, string>> {
  if (!config) return {};

  try {
    const mod = await import('@tabtin/anti-detect');
    const manager = mod.sharedAntiDetectManager;

    const profile = await manager.getOrCreateProfile({
      userAgent: config.userAgent
        ? config.userAgent
        : { preset: config.preset ?? 'desktop' },
    });

    const options = manager.applyToHttpOptions(profile);
    return options.headers ?? {};
  } catch (err) {
    console.warn('[anti-detect-bridge] Failed to resolve headers:', err);
    return {};
  }
}
