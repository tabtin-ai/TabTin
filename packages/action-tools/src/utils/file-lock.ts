/**
 * 进程内 per-file 锁（PRD「文件并发安全 Wave 1」 — 2026-05-13）
 *
 * **Wave 1.5（2026-05-13）下沉自 `packages/agent-runtime/src/tools/file-lock.ts`。**
 * 之前的实现（`FileLockManager` class + `resolveFileLockPath`）因为 4 个写入口
 * 各自持有独立 class 实例（adapter / ActionExecutorAdapter / Daemon MCP /
 * FAB / action-bridge），跨入口锁不串 —— LLM Agent 经 adapter 持锁改文件 F
 * 时，server push action 经另一个入口改同一文件 F 不受阻塞，等于「锁存在但
 * 跨入口失效」。Wave 1.5 把锁实现下沉到 action-tools 这里，把锁键 Map 收口
 * 为 module-level 单例，所有入口共享同一个 lockMap。
 *
 * **为什么不是 class**：原 FileLockManager class 让每个调用方各自维护一份
 * timeout + abort 语义（10s 超时降级 / dispose() cancel-all），调用方各自
 * 配置导致 bug surface 大且跨入口不串。统一为 module-level 函数 API：
 *   - 无 timeout 降级（PRD §A.5 决策：锁临界区 ≤ 单 edit 时长，不会真死锁）
 *   - 取消语义只支持单调用粒度的 abortSignal（abort 三档语义，见 jsdoc）
 *   - lockMap 模块级单例，4 入口跨入口锁串行（Wave 1.5 核心 H 不变量）
 *
 * 解决的真实用户问题：
 *   - 单 Agent streaming 时 LLM 一次输出多个 edit_file / write_file 调用
 *     同一文件 → 写盘并发竞态 → 后写的覆盖先写的，前一次改动悄悄丢失
 *   - 多 Agent 在同一进程并发改同一仓库（TabTin 经常多 Agent 同时干活）
 *     → 同款覆盖丢数据
 *   - LLM Agent chat（adapter 入口）跟 server push action（ActionExecutorAdapter
 *     入口）/ 外部 MCP client（Daemon MCP 入口）同时改同一文件 → 跨入口
 *     竞态（Wave 1.5 修复，L-11 升级根因）
 *
 * 设计要点：
 *   1. **per-file 颗粒**：lockMap 以 `canonicalizePath` 后的 realpath 为键，
 *      不同文件互不阻塞；同文件并发自动串行
 *   2. **FIFO 公平排队**：每个 entry 的 `tail` 是"最后一个排队者的 release
 *      promise"，新人 await 它即可拿到 FIFO 顺序
 *   3. **refcount 即时清**：临界区结束（无论成功/异常）时 refCount--，降到
 *      0 时立刻 `lockMap.delete(key)` —— daemon 长跑零泄漏，无 LRU 调参
 *   4. **锁键复用 canonicalizePath**：macOS symlink（`/tmp` ↔ `/private/tmp`）
 *      + 大小写不敏感（`/Foo` ↔ `/foo`）由 `fs.realpathSync` 兜底
 *   5. **abort 语义**（PRD §七决策）：
 *      - 进锁前 abort → 抛 AbortError，不入队也不增 refCount
 *      - 等锁期间 abort → 醒来后抛 AbortError，但 finally 仍释放下家
 *      - 持锁运行 fn 期间 abort → 不打断 fn（写一半被中断比等几秒糟糕），
 *        fn 自己决定怎么响应
 */

import { canonicalizePath } from './canonical-path.js';

/**
 * 锁条目。**FIFO 排队靠 promise chain**：
 *
 *   t=0: lockMap.set(key, { tail: Promise.resolve(), refCount: 0 })
 *   t=1: A enqueue：prev=Promise.resolve(), entry.tail=A.release
 *        → A 立刻拿锁运行 fn
 *   t=2: B enqueue：prev=A.release, entry.tail=B.release
 *        → B 等 A.release
 *   t=3: C enqueue：prev=B.release, entry.tail=C.release
 *        → C 等 B.release
 *   t=4: A finally → A.release() → B 醒来运行 fn
 *   t=5: B finally → B.release() → C 醒来运行 fn
 *
 * 释放策略：每次 finally 都 refCount--；refCount 降到 0 时（既无人持锁
 * 也无人排队）从 lockMap 删除 entry。**不留 LRU 上限**：refcount 模型在
 * 并发结束后自然清空，daemon 长跑零泄漏。
 */
interface LockEntry {
  /** 最后一个排队者的 release-promise；新人 await 它进入 FIFO。 */
  tail: Promise<void>;
  /** 已 enqueue 但 finally 尚未执行的总数（持锁的 + 等锁的）。 */
  refCount: number;
}

const lockMap = new Map<string, LockEntry>();

export interface WithFileLockOptions {
  /**
   * 进锁前 + 等锁醒来后做取消检查；持锁运行 fn 期间不打断。
   *
   * 设计理由（PRD §七决策）：写一半被中断比等几秒糟糕——AbortSignal 触发
   * 时如果当前临界区正在 atomicWriteFile 或 refreshSnapshot 中，强行打断会
   * 留下半写文件 / 未刷新 snapshot，下次启动可能撞奇怪的 stale 状态。
   *
   * 取折中：「拒绝下个进锁的请求」——已在 fn 内的不打断，等队列里的醒来后
   * 直接抛 AbortError，避免在 ctx 已被取消的会话里继续做无用功。
   */
  abortSignal?: AbortSignal;
  /**
   * 相对路径解析基准（一般传 workspaceRoot）。
   *
   * 跟 `canonicalizePath` 的 baseDir 参数语义一致：filePath 是绝对路径时
   * 此字段无效；filePath 是相对路径时按 baseDir 解析后再 realpath。
   */
  baseDir?: string;
}

/**
 * 用 per-file 锁包裹临界区。同一文件并发调用自动 FIFO 串行；不同文件互不
 * 影响并行执行。
 *
 * **Wave 1.5（2026-05-13）跨入口共享 lockMap**：所有 4 个写入口
 *   - LLM Agent chat（agent-runtime tabcode-adapter）
 *   - server push action（ActionExecutorAdapter.executeAction，covers
 *     FAB / action-bridge / Daemon MCP server）
 * 都经过本函数，共享同一份 module-level `lockMap`。canonicalizePath 保证
 * 跨入口对同一文件路径计算出相同的 key —— LLM Agent 持锁时其他入口
 * 同改同文件必然 FIFO 串行（L-11 升级核心 H 不变量）。
 *
 * @param filePath  目标文件路径（绝对或相对 baseDir）。锁键 = canonical
 *                  realpath，所以 `/tmp/x` 跟 `/private/tmp/x` 视为同一锁。
 * @param fn        临界区函数（在持锁期间执行）。返回值原样回传。
 * @param options   abortSignal / baseDir，详见 WithFileLockOptions。
 * @returns         fn 的返回值。fn 抛错时锁正确释放后异常透传。
 * @throws          AbortError（进锁前或等锁期间 abortSignal 被 abort 时）
 *                  fn 内部抛的任何错（原样透传）
 *
 * **禁止重入**：fn 内**不得**调用 `withFileLock(同一文件)`——锁是非重入
 * 实现，嵌套调用同文件会直接死锁。且因 PRD §七决策「持锁运行 fn 期间
 * abort 不打断」，死锁不会被 abortSignal 解开，整个 ctx 会 hang。当前生
 * 产代码（edit_file / write_file）内部不调用 withFileLock —— 后人扩展
 * apply_patch / delete_file 等工具时务必保持这条不变量；如有跨工具协同
 * 需求（如「edit 内部 stage 到临时文件」），让外层 caller 持锁而不是
 * 工具内部嵌套。
 *
 * **Wave 1.5 跨层调用同款**：ActionExecutorAdapter 加锁后，再去掉
 * FrontendActionBridge / action-bridge 外层 fileLockManager 包是必须的
 * —— 双层包同 key 也会死锁。
 *
 * @example
 * ```ts
 * await withFileLock(filePath, async () => {
 *   const content = await fs.readFile(filePath, 'utf8');
 *   await fs.writeFile(filePath, content + '\n', 'utf8');
 * }, { abortSignal: ctx.abortSignal, baseDir: ctx.workspaceRoot });
 * ```
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: WithFileLockOptions = {},
): Promise<T> {
  // 进锁前的快速取消：ctx 已 abort 直接拒绝，不入队也不增 refCount。
  // 这是 abort 语义的第一道闸口（PRD §七决策）。
  options.abortSignal?.throwIfAborted();

  const key = canonicalizePath(filePath, options.baseDir);

  let entry = lockMap.get(key);
  if (!entry) {
    entry = { tail: Promise.resolve(), refCount: 0 };
    lockMap.set(key, entry);
  }
  // refCount++ **必须**在拿到 prev / 替换 tail **之前**，确保从此刻起 finally
  // 一定会执行 refCount--（即便后续 throwIfAborted 抛错也走 finally）。
  entry.refCount++;

  // 创建本次的 release-promise：下个排队者 await 这个 promise 进入 FIFO。
  let release!: () => void;
  const myRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = entry.tail;
  entry.tail = myRelease;

  try {
    // 等前任 release。prev 永远 fulfill（release() 是同步 resolve），
    // 不会 reject —— 即便前任的 fn 抛错，前任 finally 也会调 release()。
    await prev;
    // 等锁期间 ctx 可能被 abort 了：拒绝下个进锁的请求（PRD §七决策）。
    // 已在 finally try 块内抛错，所以 myRelease 会被 release() 触发，下个
    // 排队者醒来。
    options.abortSignal?.throwIfAborted();
    return await fn();
  } finally {
    // 1. 释放下家：触发下一个排队者的 `await prev` 醒来。
    release();
    // 2. refCount 即时清：refCount 降到 0 表示既无人持锁也无人排队，
    //    从 Map 删除 entry。**JS 单线程 + 同步执行**：release() 跟
    //    refCount-- 之间没有异步暂停点，下个排队者的 finally 不会插入
    //    进来抢先 delete。
    entry.refCount--;
    if (entry.refCount === 0) {
      lockMap.delete(key);
    }
  }
}

/**
 * 仅供测试使用：返回当前 lockMap 大小。
 *
 * 用于 PRD §A.6 L5 矩阵的「100 并发后 Map.size === 0 无泄漏」断言。生产
 * 代码不应依赖此值——锁状态是模块级私有，外部只能通过 withFileLock 操作。
 */
export function getFileLockMapSize(): number {
  return lockMap.size;
}

/**
 * 仅供测试使用：清空 lockMap（仅用于 test 隔离，避免上个 test 残留 entry
 * 影响下个 test 的 size 断言）。
 *
 * **危险**：生产代码绝对不要调用——会在并发场景下让正在排队的 await prev
 * 丢失链接（前任的 release 没人接），永远卡死。仅 test 内 beforeEach /
 * afterEach 用，且必须确保所有 withFileLock 调用都已 await 完成。
 *
 * **运行时校验**：如果发现 entry 的 refCount > 0，说明上一个测试漏 await
 * 了 withFileLock 调用——直接 throw 让排查路径变短（避免下个测试看到莫
 * 名其妙的 size 断言失败 / 死锁 timeout）。
 */
export function __resetFileLockMapForTest(): void {
  for (const [key, entry] of lockMap) {
    if (entry.refCount > 0) {
      throw new Error(
        `[__resetFileLockMapForTest] entry "${key}" still has refCount=${entry.refCount}. ` +
          `Did the previous test forget to await all withFileLock calls? ` +
          `Wait for all in-flight Promises before resetting.`,
      );
    }
  }
  lockMap.clear();
}
