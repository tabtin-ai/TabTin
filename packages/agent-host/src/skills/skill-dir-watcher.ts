/**
 * SkillDirWatcher（Wave A · M2）
 *
 * 职责（PRD §5.2 M2）：
 * - 用 chokidar 监听所有 ScanRoot（6 类路径）
 * - `depth: 2`：只关心 `<root>/<slug>/SKILL.md` 两层，不递归整棵树
 *   （E1 §7.4：debounce 后重扫）
 * - 300ms debounce 合并事件：避免 git checkout 等一次性大量事件引发雪崩
 * - 每次 debounce 窗口触发后，按发生变化的 root 调用 `registry.refreshSlug(root, slug)`
 * - 进程退出 / registry 销毁时 `close()` 所有 watcher，避免泄漏
 *
 * 健壮性：
 * - `ignorePermissionErrors: true`：EACCES / EPERM 不抛——企业权限场景不挂
 * - 路径不存在：chokidar 会 emit `add`/`addDir`（因为 persistent），但 depth=2 + 本模块
 *   只关心 SKILL.md 本身的变化。目录没建不影响 watcher 启动——chokidar 5 支持 watch
 *   不存在的路径（`ignoreInitial: true` + 后续 mkdir 被监测到）
 */

import * as path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type {
  ScanRoot,
  SkillsChangedListener,
} from '@tabtin/agent-runtime/skills';
import type { LocalSkillRegistry, RegistryLogger } from './local-skill-registry.js';

/** debounce 窗口（ms）—— E1 §7.4。 */
const DEBOUNCE_MS = 300;

export interface WatcherOptions {
  /** 关联的 registry，watcher 通过它 refreshSlug 触发增量更新。 */
  registry: LocalSkillRegistry;
  /** 日志（可选） */
  logger?: RegistryLogger;
  /** 单次变更 debounce 窗口，默认 300ms。测试里可以调小 */
  debounceMs?: number;
  /**
   * 是否初始期扫（chokidar ready 前就 emit `add` 事件）。
   * 默认 `false`——首次扫由 registry.ready() 完成，watcher 只响应后续变化。
   */
  ignoreInitial?: boolean;
}

/**
 * 内部状态：按 `<root.path> -> Set<slug>` 累积变化，debounce 窗口到期后一起应用。
 */
interface PendingState {
  dirtySlugsByRoot: Map<string, Set<string>>;
  timer: NodeJS.Timeout | null;
}

export class SkillDirWatcher {
  private fsw: FSWatcher | null = null;
  private readonly registry: LocalSkillRegistry;
  private readonly logger: RegistryLogger;
  private readonly debounceMs: number;
  private readonly ignoreInitial: boolean;

  private readonly pending: PendingState = {
    dirtySlugsByRoot: new Map(),
    timer: null,
  };

  /** 当前监听的 roots 列表（按 path 索引） */
  private rootsByPath = new Map<string, ScanRoot>();

  /**
   * 订阅者转发表。注意 Review P0 修正：`onChange` 多次调用不再覆盖前一个 unsubscribe——
   * 改为每个 listener 独立记账，保证多订阅者（面板 + 诊断）不会互相吞掉回调。
   */
  private readonly unsubscribesRegistry = new Set<() => void>();

  constructor(options: WatcherOptions) {
    this.registry = options.registry;
    this.logger = options.logger ?? {
      warn: (m) => console.warn(`[skills:watcher] ${m}`),
      info: (m) => console.info(`[skills:watcher] ${m}`),
    };
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.ignoreInitial = options.ignoreInitial ?? true;
  }

  /**
   * 启动 watcher —— **必须在 `registry.ready()` 之后调用**（PRD §5.2 M1 ready 门闩）。
   *
   * 首次扫已经由 registry 完成；watcher 只追踪后续变化。
   */
  start(): void {
    if (this.fsw) {
      this.logger.warn('watcher 已启动，忽略重复 start');
      return;
    }

    const roots = this.registry.getScanRoots();
    if (roots.length === 0) {
      this.logger.info('无 scan roots，watcher 不启动');
      return;
    }

    this.rootsByPath = new Map(roots.map((r) => [r.path, r]));

    const watchedPaths = roots.map((r) => r.path);

    this.fsw = watch(watchedPaths, {
      depth: 2,
      ignoreInitial: this.ignoreInitial,
      persistent: true,
      ignorePermissionErrors: true,
      // awaitWriteFinish：避免 Agent 正在写 SKILL.md 的过程中 chokidar 就 emit change；
      // 读到半成品文件 parser 会返回 null，这里用 50/100ms 稳定性阈值尽量避免
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.fsw.on('add', (p) => this.onFsEvent(p, 'add'));
    this.fsw.on('change', (p) => this.onFsEvent(p, 'change'));
    this.fsw.on('unlink', (p) => this.onFsEvent(p, 'unlink'));
    this.fsw.on('unlinkDir', (p) => this.onFsEvent(p, 'unlinkDir'));
    this.fsw.on('error', (err) => {
      this.logger.warn(`chokidar 错误：${(err as Error).message}`);
    });
    this.fsw.on('ready', () => {
      this.logger.info(
        `watcher ready (${watchedPaths.length} roots, debounce=${this.debounceMs}ms)`,
      );
    });
  }

  private onFsEvent(
    filePath: string,
    _event: 'add' | 'change' | 'unlink' | 'unlinkDir',
  ): void {
    // 只关心 `<root>/<slug>/SKILL.md` 或 `<root>/<slug>` 目录本身
    // filePath 已经是绝对路径（chokidar 给的是配置传入 path 的原样展开）
    const match = this.resolveSlugDir(filePath);
    if (!match) return;

    const { root, slug } = match;
    let set = this.pending.dirtySlugsByRoot.get(root.path);
    if (!set) {
      set = new Set();
      this.pending.dirtySlugsByRoot.set(root.path, set);
    }
    set.add(slug);

    this.scheduleFlush();
  }

  /**
   * 从 fs 事件 filePath 解析出 `{ root, slug }`：
   * - 如果 filePath 位于某个 root.path 下
   * - 取 filePath 相对 root.path 的第一段作为 slug
   * - 若第一段是 `README.md`/文件等非目录，也返回 null
   */
  private resolveSlugDir(filePath: string): { root: ScanRoot; slug: string } | null {
    for (const [rootPath, root] of this.rootsByPath.entries()) {
      const normRoot = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
      if (!filePath.startsWith(normRoot) && filePath !== rootPath) continue;

      // 跨平台 relative
      const rel = filePath.slice(normRoot.length);
      if (!rel) return null; // root 本身

      const slug = rel.split(/[\\/]/)[0];
      if (!slug || slug.startsWith('.')) return null;

      return { root, slug };
    }
    return null;
  }

  /**
   * Trailing-edge debounce：每个事件重置计时器，合并窗口内所有事件。
   *
   * Review P1 修正：原实现是 leading-edge（首事件后固定 N ms 必 flush），
   * 当写入持续超过 N ms 时可能读到半成品。现改为 trailing-edge debounce——
   * 与 PRD §5.2 M2 "合并事件避免雪崩" 更一致。
   */
  private scheduleFlush(): void {
    if (this.pending.timer) {
      clearTimeout(this.pending.timer);
    }
    this.pending.timer = setTimeout(() => {
      this.pending.timer = null;
      void this.flushNow();
    }, this.debounceMs);
  }

  /**
   * flushNow：按 root 去重触发 refresh——同一窗口内一个 root 只调一次，避免并发
   * race condition（Review P0-1 修正）。
   *
   * refreshSlug 签名仍保留 slugDir（一个 root 下变更了多个 slug 时传第一个做日志标识），
   * 但 registry 侧已按 root 串行化处理，内部实现等价于"整根 diff"。
   */
  private async flushNow(): Promise<void> {
    const batch = this.pending.dirtySlugsByRoot;
    if (batch.size === 0) return;
    this.pending.dirtySlugsByRoot = new Map();

    const tasks: Promise<void>[] = [];
    for (const [rootPath, slugs] of batch.entries()) {
      const root = this.rootsByPath.get(rootPath);
      if (!root) continue;
      const firstSlug = slugs.values().next().value ?? '';
      const slugDir = firstSlug ? path.join(rootPath, firstSlug) : rootPath;
      tasks.push(
        this.registry.refreshSlug(root, slugDir).catch((err) => {
          this.logger.warn(
            `refreshSlug ${rootPath} 失败：${(err as Error).message}`,
          );
        }),
      );
    }
    await Promise.all(tasks);
  }

  /**
   * 订阅 registry 的变更事件（对外转发）。
   *
   * Review P0 修正：支持多订阅者，不再覆盖前一个。
   */
  onChange(listener: SkillsChangedListener): () => void {
    const unsubscribe = this.registry.subscribeChanges(listener);
    this.unsubscribesRegistry.add(unsubscribe);
    return () => {
      if (this.unsubscribesRegistry.delete(unsubscribe)) {
        unsubscribe();
      }
    };
  }

  /**
   * 关闭所有 watcher，清理定时器。**进程退出 + 测试 teardown 必须调**。
   */
  async close(): Promise<void> {
    if (this.pending.timer) {
      clearTimeout(this.pending.timer);
      this.pending.timer = null;
    }
    this.pending.dirtySlugsByRoot.clear();
    for (const u of this.unsubscribesRegistry) {
      try {
        u();
      } catch {
        // ignore
      }
    }
    this.unsubscribesRegistry.clear();
    if (this.fsw) {
      const fsw = this.fsw;
      this.fsw = null;
      try {
        await fsw.close();
      } catch (err) {
        this.logger.warn(
          `chokidar close 异常：${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Wave 6: 动态添加一个扫描根到 watcher（新 Space 预装完成后调用）。
   */
  addRoot(root: ScanRoot): void {
    if (this.rootsByPath.has(root.path)) return;
    this.rootsByPath.set(root.path, root);
    if (this.fsw) {
      this.fsw.add(root.path);
    }
  }

  /** 测试/诊断：等待 debounce 窗口 flush 完成 */
  async _flushForTest(): Promise<void> {
    if (this.pending.timer) {
      clearTimeout(this.pending.timer);
      this.pending.timer = null;
    }
    await this.flushNow();
  }
}
