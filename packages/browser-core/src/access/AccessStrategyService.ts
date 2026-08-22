/**
 * AccessStrategyService — 自适应访问策略编排
 *
 * L4 扩展层模块，与 CaptchaGuard / BlockDetector 同级。
 * 职责：根据 BlockDetector 检测结果，自动升级访问等级（L0→L1），
 * 所有策略失败时返回人机协作信号。
 *
 * 本模块不直接操作 View/BrowserContext，而是返回决策结果，
 * 由上层（BrowserToolImpl 或 FrontendActionBridge）执行实际操作。
 */

import { AccessLevel, buildAntiDetectConfig } from './AccessLevel';
import { SiteAccessMemory } from './SiteAccessMemory';
import type { EnhancedBlockSignal } from '../types/browser';
import type { AntiDetectConfig } from '@tabtin/crawl-contracts';

export interface StrategyDecision {
  /** 本次应使用的访问等级 */
  level: AccessLevel;
  /** 应用的 AntiDetectConfig（已考虑 overrides） */
  config: AntiDetectConfig;
  /** 是否是从低等级升级来的（需要创建新 View） */
  upgraded: boolean;
  /** 策略升级日志（供 Agent 日志展示） */
  upgradeLog?: string;
}

export interface StrategyResult {
  /** 最终使用的访问等级 */
  level: AccessLevel;
  /** 是否被封禁（所有策略都试过了） */
  blocked: boolean;
  /** 是否需要人机协作（blocked=true 时） */
  humanAssistRequired: boolean;
  /** 封禁详情 */
  blockSignal?: EnhancedBlockSignal;
  /** 策略过程日志 */
  logs: string[];
}

export type AccessPolicy = 'auto' | 'enhanced' | 'off';

export class AccessStrategyService {
  private siteMemory: SiteAccessMemory;
  private policy: AccessPolicy = 'auto';

  constructor(siteMemory?: SiteAccessMemory) {
    this.siteMemory = siteMemory ?? new SiteAccessMemory();
  }

  getSiteMemory(): SiteAccessMemory {
    return this.siteMemory;
  }

  getPolicy(): AccessPolicy {
    return this.policy;
  }

  /**
   * 设置用户选择的访问策略。
   * - 'auto'：L0 起步，遇阻自动升级
   * - 'enhanced'：所有访问从 L1 开始
   * - 'off'：不做任何自适应升级
   */
  setPolicy(policy: AccessPolicy): void {
    this.policy = policy;
    if (policy === 'off') {
      this.siteMemory.clear();
    }
  }

  /** 当前策略是否允许自适应升级 */
  isUpgradeEnabled(): boolean {
    return this.policy !== 'off';
  }

  /**
   * 获取首次访问的策略决策。
   * 根据 policy + SiteAccessMemory 确定起始等级。
   */
  getInitialDecision(url: string): StrategyDecision {
    if (this.policy === 'enhanced') {
      return { level: AccessLevel.L1, config: buildAntiDetectConfig(AccessLevel.L1), upgraded: false };
    }
    const domain = SiteAccessMemory.extractDomain(url);
    const memoryLevel = this.siteMemory.getLevel(domain);
    return {
      level: memoryLevel,
      config: buildAntiDetectConfig(memoryLevel),
      upgraded: false,
    };
  }

  /**
   * 根据 BlockDetector 的检测结果，判断是否应该升级，并返回升级决策。
   *
   * shouldUpgrade 的决策权在这里（而非 BlockDetector），因为这是策略问题不是检测问题：
   * - Cloudflare / IP ban / rate limit → 升级
   * - business_403（需要登录/付费）/ auth_wall（登录墙）→ 不升级
   * - 已到最高等级 → 不升级
   *
   * 返回 null 表示不升级（页面正常、业务权限不足、或已到最高等级）。
   */
  evaluateAndUpgrade(
    url: string,
    currentLevel: AccessLevel,
    blockSignal: EnhancedBlockSignal,
  ): StrategyDecision | null {
    if (!blockSignal.blocked) return null;
    if (!this.isUpgradeEnabled()) return null;
    if (!this.shouldUpgrade(blockSignal)) return null;
    if (currentLevel >= AccessLevel.L1) return null;

    const nextLevel = (currentLevel + 1) as AccessLevel;
    const domain = SiteAccessMemory.extractDomain(url);
    const reason = blockSignal.reason ?? 'Blocked';
    const typeNote = blockSignal.type === 'cloudflare' ? ' (Cloudflare)'
      : blockSignal.type === 'rate_limit' ? ' (限流)'
      : blockSignal.type === 'ip_ban' ? ' (IP 封禁)' : '';

    return {
      level: nextLevel,
      config: buildAntiDetectConfig(nextLevel),
      upgraded: true,
      upgradeLog: `检测到访问限制${typeNote}：${reason}，升级到 L${nextLevel} 增强访问 (${domain})`,
    };
  }

  /**
   * 判断封禁信号是否应触发策略升级。
   * 这是策略决策，只有 AccessStrategyService 有权做这个判断。
   */
  private shouldUpgrade(signal: EnhancedBlockSignal): boolean {
    if (!signal.blocked) return false;
    // 登录墙 / 业务权限不足不是反爬封禁：升级访问等级也进不去，只会白试并触发风控。
    if (signal.type === 'business_403') return false;
    if (signal.type === 'auth_wall') return false;
    if (signal.httpStatus === 401 || signal.httpStatus === 404) return false;
    return signal.type === 'cloudflare'
      || signal.type === 'ip_ban'
      || signal.type === 'rate_limit'
      || signal.error_code === 'blocked'
      || signal.error_code === 'rate_limited';
  }

  /**
   * 记录成功访问，更新 SiteAccessMemory。
   */
  recordSuccess(url: string, level: AccessLevel): void {
    const domain = SiteAccessMemory.extractDomain(url);
    this.siteMemory.recordSuccess(domain, level);
  }

  /**
   * 构建所有策略失败后的人机协作结果。
   */
  buildHumanAssistResult(
    url: string,
    lastLevel: AccessLevel,
    lastBlockSignal: EnhancedBlockSignal,
    logs: string[],
  ): StrategyResult {
    const domain = SiteAccessMemory.extractDomain(url);
    return {
      level: lastLevel,
      blocked: true,
      humanAssistRequired: true,
      blockSignal: lastBlockSignal,
      logs: [
        ...logs,
        `所有自动策略已尝试 (L0-L${lastLevel})，${domain} 需要人工协助`,
      ],
    };
  }

  /**
   * 构建成功访问结果。
   */
  buildSuccessResult(level: AccessLevel, logs: string[]): StrategyResult {
    return {
      level,
      blocked: false,
      humanAssistRequired: false,
      logs,
    };
  }
}

let shared: AccessStrategyService | null = null;

export function getSharedAccessStrategyService(): AccessStrategyService {
  if (!shared) shared = new AccessStrategyService();
  return shared;
}

export function setSharedAccessStrategyService(service: AccessStrategyService): void {
  shared = service;
}
