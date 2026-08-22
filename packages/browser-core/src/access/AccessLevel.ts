import type { AntiDetectConfig } from '@tabtin/crawl-contracts';

export enum AccessLevel {
  /** 标准访问：Profile 预设的默认反检测（fingerprint + webdriver 删除 + UA 清洗） */
  L0 = 0,
  /** 增强访问：换一个身份重新来（新 UA + 行为伪装 + Session 隔离） */
  L1 = 1,
}

const BASE_CONFIGS: Record<AccessLevel, AntiDetectConfig> = {
  [AccessLevel.L0]: {
    userAgent: { preset: 'system' },
    fingerprint: { preset: 'balanced' },
  },
  [AccessLevel.L1]: {
    userAgent: { preset: 'desktop', randomize: true },
    fingerprint: { preset: 'stealth' },
    session: { persistent: false },
  },
};

/**
 * 根据 AccessLevel 生成对应的 AntiDetectConfig。
 *
 * @param overrides - 可选的覆盖参数，用于站点级定制（Phase B SiteAccessMemory 场景）。
 *                    浅合并到基础配置上。
 */
export function buildAntiDetectConfig(
  level: AccessLevel,
  overrides?: Partial<AntiDetectConfig>,
): AntiDetectConfig {
  const base = BASE_CONFIGS[level];
  if (!overrides) return { ...base };
  return { ...base, ...overrides };
}

export const DEFAULT_ACCESS_LEVEL = AccessLevel.L0;
