/**
 * CapabilityRegistry —— 对应 M1 §3.6 / 总控 Part 4.x。
 *
 * 存储 type → factory 的映射；UI / Preset / 测试通过 `list()` /
 * `create(type)` 等方法访问。
 *
 * **关键约定**：
 *   - **存的是 factory 而非实例** —— 每次 buildAgent 都从 preset 展开
 *     成一批新实例（每 Capability 实例只服务一个 Agent）
 *   - **不是单例** —— 测试 / 多 Organization 隔离时可以创建独立 registry
 *   - 全局共享的 registry（如果需要）由调用方在宿主层维护，不在本模块
 *     暴露 module-level 单例（避免 hot-reload / test 串扰）
 *
 * **校验 fail-fast 策略**：
 *   - `register` 同 type 重复注册 → 抛错（不静默覆盖）
 *   - `create` 未知 type → 抛错（不返回 undefined / null 让上层决策）
 *   - `validateDependencies` 缺依赖 → 抛 CapabilityDependencyError
 */

import type { Capability, CapabilityCategory } from './capability.js';
import { CapabilityDependencyError } from './errors.js';

/**
 * Capability 工厂函数 —— 返回新实例。
 *
 * 工厂模式而非 class 引用，是为了让注册者灵活：可以闭包预先注入
 * 配置（例 `() => new ShellCap({ ... })`）。
 */
export type CapabilityFactory = () => Capability;

/**
 * Registry 列表项 —— UI / 调试用。
 */
export interface CapabilityRegistryEntry {
  type: string;
  category: CapabilityCategory;
}

/**
 * Capability 注册表 —— 实例级别（非全局单例）。
 *
 * 典型用法（W2 宿主层）：
 *
 *   const registry = new CapabilityRegistry();
 *   registry.register('filesystem', () => new FileSystemCap());
 *   registry.register('shell', () => new ShellCap());
 *   ...
 *
 *   // buildAgent 时
 *   const caps = preset.capabilityTypes.map(t => registry.create(t));
 *   registry.validateDependencies(caps);
 *   for (const c of caps) await c.bind(session);
 */
export class CapabilityRegistry {
  private readonly factories = new Map<string, CapabilityFactory>();
  /**
   * 缓存 type → category 映射，避免每次 list 都 create 一个新实例。
   * 在 register 阶段调一次 factory 拿 category（一次性成本 + 可暴露
   * register 阶段的 factory bug）。
   */
  private readonly categories = new Map<string, CapabilityCategory>();

  /**
   * 注册一个 factory。同 type 重复注册抛错。
   *
   * **同 type 检查**：让"两个团队都注册 'filesystem'"立即崩在启动期，
   * 而不是运行时拿到不期望的实现版本。
   */
  register(type: string, factory: CapabilityFactory): void {
    if (this.factories.has(type)) {
      throw new Error(
        `CapabilityRegistry: type "${type}" already registered. ` +
          `Re-registering would silently override the previous factory; ` +
          `unregister first if intentional.`,
      );
    }

    // 立即调一次 factory 拿 category，验证 factory 能产出合法 Capability
    let probe: Capability;
    try {
      probe = factory();
    } catch (err) {
      throw new Error(
        `CapabilityRegistry: factory for type "${type}" threw on invocation: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (probe == null) {
      throw new Error(
        `CapabilityRegistry: factory for type "${type}" returned null/undefined. ` +
          `Factory must return a Capability instance.`,
      );
    }
    if (typeof probe.type !== 'string' || probe.type.length === 0) {
      throw new Error(
        `CapabilityRegistry: factory for type "${type}" produced an object ` +
          `with missing/invalid \`type\` field (got ${typeof probe.type}). ` +
          `Factory output must satisfy the Capability interface.`,
      );
    }
    if (probe.type !== type) {
      throw new Error(
        `CapabilityRegistry: factory for "${type}" produced Capability with ` +
          `type "${probe.type}". Factory output type must match registration type.`,
      );
    }
    if (
      probe.category !== 'app' &&
      probe.category !== 'core' &&
      probe.category !== 'governance'
    ) {
      throw new Error(
        `CapabilityRegistry: factory for type "${type}" produced Capability with ` +
          `invalid category "${String(probe.category)}". ` +
          `Must be one of: 'app' | 'core' | 'governance'.`,
      );
    }

    this.factories.set(type, factory);
    this.categories.set(type, probe.category);
  }

  /**
   * 创建一个新 Capability 实例（每次调用都是独立实例）。
   *
   * 未知 type 抛错 —— 不返回 undefined，让上层 fail-fast。
   */
  create(type: string): Capability {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new Error(
        `CapabilityRegistry: unknown type "${type}". Known types: ` +
          `${this.list().map((e) => e.type).join(', ') || '(none)'}`,
      );
    }
    return factory();
  }

  /** 是否已注册某 type */
  has(type: string): boolean {
    return this.factories.has(type);
  }

  /**
   * 注销 —— 主要服务于测试 / hot-reload 场景。
   * 未注册过的 type 不抛错（幂等）。
   */
  unregister(type: string): void {
    this.factories.delete(type);
    this.categories.delete(type);
  }

  /**
   * 列出所有已注册条目，按 type 字典序稳定输出。
   *
   * 字典序而非注册序：让 UI / 测试 / 日志输出稳定，避免"哪个先注册
   * 的依赖"成为隐性契约。
   */
  list(): CapabilityRegistryEntry[] {
    return Array.from(this.categories.entries())
      .map(([type, category]) => ({ type, category }))
      .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  }

  /**
   * 校验 capabilities 列表的依赖完整性。
   *
   * 算法：对每个 cap 的 `required_capability_types()`，检查每个
   * 依赖是否存在于 caps 列表中（**不是** registry 中 —— preset 展开
   * 后的实际 caps 才是真相）。
   *
   * 缺失则抛 `CapabilityDependencyError`，错误对象同时包含 `capType`
   * 和 `missingDep` 字段（便于上层做结构化日志，无需 grep message）。
   *
   * **多依赖同时缺**：抛第一个发现的。如果未来需要"一次性报告所有
   * 缺失"，可以扩展返回错误集合（M5+ 决策）。
   */
  validateDependencies(caps: Capability[]): void {
    const presentTypes = new Set(caps.map((c) => c.type));

    for (const cap of caps) {
      const required = cap.required_capability_types?.();
      if (!required) continue;
      for (const dep of required) {
        if (!presentTypes.has(dep)) {
          throw new CapabilityDependencyError(cap.type, dep);
        }
      }
    }
  }
}
