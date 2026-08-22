/**
 * CapabilityBase 抽象基类 —— 对应 M1 §3.7 / 总控 Part 4.2.x。
 *
 * **职责**：
 *   - 提供 `bind` 默认实现 + 并发保护（同实例不能跨 session 复用）
 *   - 提供 `clone` 默认实现 + SKIP_KEYS 机制（结构化拷贝时跳过运行时
 *     状态字段）
 *   - 持有受保护字段 `_session` 给子类 tools handler 用
 *
 * **使用约定**：
 *   - 7 个 Capability（W2 实施）应优先 extends CapabilityBase 而非
 *     直接 implements Capability
 *   - 子类持有锁 / AbortController / EventEmitter 订阅时，**应该
 *     override clone**，显式处理这些字段（默认 SKIP_KEYS 已覆盖
 *     一部分常见场景，但子类自己持有的特殊资源仍要 override）
 */

import type {
  Capability,
  CapabilityCategory,
} from './capability.js';
import type { BackendSession } from './backend-session.js';

/**
 * clone 时**跳过**的字段名集合 —— 默认 SKIP_KEYS。
 *
 * 这些字段一旦深拷贝就会出问题：
 *   - `_session`: BackendSession 包含 IPC 句柄 / 子进程引用，拷贝后失效
 *   - `_activeLocks`: asyncio Lock 等并发原语，拷贝后两个 lock 不同步
 *   - `_subscribeHandles`: EventEmitter 订阅句柄，拷贝后断链
 *   - `_tools`: Tool 对象包含 `execute` 函数，structured-clone 不接受函数
 *   - `_eventEmitterHandles`: 同上
 *
 * 子类如果持有更多此类字段，应自己 override clone（参见 OpenAI
 * `_clone_capability_value` 实践）。
 */
const DEFAULT_SKIP_KEYS = new Set<string>([
  '_session',
  '_activeLocks',
  '_subscribeHandles',
  '_tools',
  '_eventEmitterHandles',
]);

/**
 * 抽象基类。子类必须实现 `type` / `category` 两个 readonly 字段；
 * 其他 hook 全部 optional（按 Capability 接口约定）。
 *
 * **不可 abstract bind / clone**：因为基类提供了完整默认实现，子类
 * 应当 override 才需要（例如 SkillsCap 启动 chokidar watcher 时需要
 * override clone 重建监听）。
 */
export abstract class CapabilityBase implements Capability {
  abstract readonly type: string;
  abstract readonly category: CapabilityCategory;

  /**
   * 当前绑定的 BackendSession。
   *
   * - bind() 之前为 null，tools handler 访问会 NPE —— 这是契约层面的
   *   设计：调用方必须按 prepare_agent 流程 bind → tools 顺序调用。
   * - 子类 tools handler 推荐这样写：
   *     `const session = this._session!; const buf = await session.read(path);`
   *   或在执行入口处显式 if (!this._session) throw。
   */
  protected _session: BackendSession | null = null;

  /**
   * 默认 bind —— 并发保护 + 记录当前 session。
   *
   * **并发保护语义**：同一个 Capability 实例如果已绑定 sessionA，
   * 再调用 bind(sessionB) 时抛 Error。同实例 bind(sessionA) 多次 OK。
   *
   * Capability 子类 override 时应**保留**此约束（典型 override 场景：
   * 子类需要在 bind 时初始化 session 相关资源，比如 SkillsCap 初始化
   * skill watcher），实现可以是：
   *
   *   override async bind(session: BackendSession) {
   *     await super.bind(session);  // 保留并发保护
   *     this._watcher = chokidar.watch(...);
   *   }
   */
  async bind(session: BackendSession): Promise<void> {
    if (this._session !== null && this._session.sessionId !== session.sessionId) {
      throw new Error(
        `Capability "${this.type}" cannot be reused across concurrent sessions ` +
          `(currently bound to "${this._session.sessionId}", attempted to bind to ` +
          `"${session.sessionId}"). Runtime must clone() the Capability before ` +
          `binding a second session.`,
      );
    }
    this._session = session;
  }

  /**
   * 默认 clone —— 结构化拷贝所有字段，跳过 DEFAULT_SKIP_KEYS。
   *
   * **拷贝策略**（保守 / 不破坏 Capability 状态）：
   *   1. 字段 ∈ DEFAULT_SKIP_KEYS → 拷贝为 null
   *   2. structuredClone 成功 → 用拷贝值
   *   3. structuredClone 失败（函数 / class instance / Symbol 等不支持）
   *      → 保留原引用（不抛错；典型情况是 Tool 对象的 execute 函数）
   *
   * **何时必须 override**（见 capability.ts hook 注释）：
   *   - 子类持有 chokidar watcher / EventEmitter 订阅 → clone 后要重建
   *   - 子类持有 LRU cache → clone 后要决策是否清空
   *   - 子类持有 inflight Promise → clone 后必须置 null（否则两实例
   *     同时 await 同一个 Promise）
   *
   * **重要：watcher 类资源不要指望落进 SKIP_KEYS**：DEFAULT_SKIP_KEYS
   * 是固定字段名清单（_session / _activeLocks / _subscribeHandles /
   * _tools / _eventEmitterHandles）。如果子类把 chokidar watcher 命名
   * 为 `_watcher`、`watcher`、`_skillWatcher` 等其他名字，**默认 clone
   * 会试图 structuredClone，失败回退为共享引用** —— 两个 clone 实例
   * 共用一个 watcher，对其中一个 unwatch 会同时影响另一个。**结论：
   * 一律 override clone 显式重建 watcher，不要靠字段名碰运气**。
   *
   * **重要：禁止使用 ES private 字段（`#xxx` 语法）**：
   *   `Object.entries(this)` 看不到 `#` 私有字段；`Object.create(Ctor.prototype)`
   *   也不调子类构造器。子类如果用 `#field` 持状态，clone 后字段会
   *   缺失，访问 `clone.#field` 会运行时抛 TypeError。
   *   **请用 TypeScript `private` 关键字 + `_` 前缀**（如 `private _session`），
   *   它们在运行时是普通字段，clone 流程能正确处理。
   */
  clone(): Capability {
    const Ctor = Object.getPrototypeOf(this).constructor as new () => Capability;
    // 不调 constructor —— 子类 constructor 可能有副作用（连接 IPC、读配置）。
    // 直接拿 prototype 创建空 instance，再逐字段拷贝。
    const cloned: Record<string, unknown> = Object.create(Ctor.prototype);

    for (const [k, v] of Object.entries(this) as Array<[string, unknown]>) {
      if (DEFAULT_SKIP_KEYS.has(k)) {
        cloned[k] = null;
        continue;
      }

      try {
        cloned[k] = structuredClone(v);
      } catch {
        // 不可 structured-clone（函数 / class instance / Symbol / WeakMap 等）
        // 保留原引用 —— 多数情况下原引用是只读资源（Tool schema / config
        // 对象），共享是安全的；如果不安全，子类应 override clone。
        cloned[k] = v;
      }
    }

    return cloned as unknown as Capability;
  }
}
