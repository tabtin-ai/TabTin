/**
 * Tool Result Storage — disk-only persistence for oversized tool results.
 *
 * **W3 (2026-05-10) — design based on persist+reference pattern `toolResultStorage.ts`,
 * not a line-for-line port**:
 *   - Same intent: write the **raw** pre-truncation content to disk and
 *     hand the LLM an absolute path so it can re-read via `read_file`.
 *   - Different API surface (intentional):
 * *       `{filepath, originalSize, isJson, preview, hasMore}` in one shot;
 *       caller composes the `<persisted-output>` wrapper itself.
 *     * TabTin: `save(id, toolName, content)` (sync, fire-and-forget) +
 *       `getFilePath(id)` (sync, deterministic). The truncation banner is
 *       composed by `tool-orchestration.ts::buildPersistMeta` based on the
 *       returned path; no preview is bundled into the storage layer.
 *   - Same opinionated trade-off: no in-memory cache, no `list()` /
 *     `asMap()` / LRU eviction, no periodic cleanup. The legacy
 *     `retrieve_tool_result` tool that needed those affordances was
 *     deleted in W3 (dogfood proved it produced `tool_result_not_found`
 *     death loops); the only consumer left is `enforceToolOutputBudget`,
 *     which writes when a result blows past the per-tool / per-round
 *     budget and immediately injects a path-bearing banner.
 *
 * **Two implementations**:
 *   - `FileToolResultStorage` — production hosts (Electron / Daemon).
 *   - `MemoryToolResultStorage` — headless / test fallback that swallows
 *     `save()` and returns `''` from `getFilePath()` so truncation banners
 *     never point the LLM at a fake path (callers treat falsy path as
 *     "Full output not persisted in this host"). Tests can also pass
 *     `undefined` storage entirely and `enforceToolOutputBudget` defaults
 *     to the same fallback banner.
 *
 * **File extension**: `.txt` (not `.json`). Bodies are raw content, no
 * envelope. Uses `.json` only when the original ToolResultBlock
 * was a content-array (multimodal); TabTin's `enforceToolOutputBudget`
 * runs on string content only, so we always write text. If a future tool
 * returns multimodal pre-truncation we'd need to revisit, but today every
 * tool that can blow the budget (`web_search`, `read_file`, `grep_search`,
 * `parse_document`, `mcp_call_tool`, `run_terminal_command`) is text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Public Interface ────────────────────────────────────────────────

export interface ToolResultStorage {
  /**
   * Persist a tool result. FileToolResultStorage fire-and-forgets a disk
   * write with `{ flag: 'wx' }` so accidental replays (microcompact, sub-
   * agent re-execution) are idempotent — same id + same content writes
   * once, EEXIST is silent.
   *
   * Synchronous return so callers can compose the `<persisted-output>`
   * banner without awaiting; the actual disk I/O happens in the
   * background.
   */
  save(id: string, toolName: string, content: string): void;

  /**
   * Return the path / URI where `save(id, ...)` would persist the content.
   * Stable per id — used by callers (`enforceToolOutputBudget`) to embed
   * the path in the truncation banner so the LLM can re-read with
   * `read_file`.
   *
   * Concrete shapes:
   *   - `FileToolResultStorage` returns an absolute filesystem path
   *     (`<sessionDir>/tool-results/<safeId>.txt`).
   *   - `MemoryToolResultStorage` returns `''` (no recoverable path); banner
   *     builders treat falsy paths as "Full output not persisted in this host".
   */
  getFilePath(id: string): string;

  /**
   * **W4 (2026-05-12)** — Return the absolute directory path where this
   * storage persists tool result files (without per-id filename).
   *
   * Consumers (notably `tabcode-adapter` for `read_file` workspace boundary
   * exemption): the LLM gets a `<persisted-output>` banner pointing at a
   * file inside `<sessionDir>/tool-results/`, but that path is outside the
   * user's workspace — without this dir signal the `read_file` boundary
   * check would block the very recovery path the persistence mechanism is
   * meant to provide.
   *
   * Concrete shapes:
   *   - `FileToolResultStorage` → returns the absolute disk directory
   *     (`<sessionDir>/tool-results`).
   *   - `MemoryToolResultStorage` → returns `undefined` (no real disk
   *     directory; banner falls back to "not persisted" so LLM doesn't
   *     try to read a fake path anyway).
   *
   * Optional method for backward compat: pre-W4 storage implementations
   * (none expected outside this file, but theoretically a host could
   * supply a custom storage) gracefully degrade — `getToolResultsDir`
   * callbacks fall back to undefined and read_file exemption stays off.
   */
  getResultsDir?(): string | undefined;
}

// ─── Internal helpers ────────────────────────────────────────────────

const TOOL_RESULTS_SUBDIR = 'tool-results';

/**
 * Sanitize a tool_use_id into a safe filesystem name. Same character set as
 * before W3 — keep alphanumerics + `_` + `-`, drop everything else (the
 * Anthropic / Bedrock IDs and OpenAI-compatible ids both fall in this set
 * after the substitution).
 */
function safeFilename(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Optional logger shape; when not injected, FileToolResultStorage falls
 * back to `console.warn`. Kept minimal to avoid coupling to a specific
 * logger lib across hosts (Electron / Daemon use different wiring).
 */
export interface ToolResultStorageLogger {
  warn: (message: string, extra?: Record<string, unknown>) => void;
}

const defaultLogger: ToolResultStorageLogger = {
  warn(message, extra) {
    if (extra) {
      console.warn(message, extra);
    } else {
      console.warn(message);
    }
  },
};

// ─── FileToolResultStorage ──────────────────────────────────────────

export interface FileToolResultStorageOptions {
  /**
   * Logger for non-fatal disk errors (EEXIST still ignored silently).
   * When omitted, falls back to `console.warn`. Pass a no-op to silence.
   */
  logger?: ToolResultStorageLogger;
}

export class FileToolResultStorage implements ToolResultStorage {
  private readonly _dir: string;
  private readonly _logger: ToolResultStorageLogger;
  private _dirEnsured = false;

  constructor(sessionDir: string, options?: FileToolResultStorageOptions) {
    // **W4 (2026-05-12) realpath normalize**：dogfood 调试场景里 sessionDir
    // 经常落在 `/tmp/...` / `/var/folders/...`（macOS 上是 `/private/tmp` /
    // `/private/var` 的 symlink）。banner 给 LLM 的 path 来自 `getFilePath`
    // → 字面前缀；action-tools `resolveInWorkspace` 走 `realpathSync`
    // dereference symlink → 用 dereference 后 path 跟字面 `_tool_results_dir`
    // 比 `path.relative` 永远命中 `..` → workspace 豁免漏命中。
    //
    // 修法：构造时立刻尝试 mkdir + realpath，让 `_dir` 是 canonical 形态，
    // 下游所有路径派生都跟 action-tools 的 realpath 链路对齐。生产
    // `~/Library/...` 路径不过 symlink 这一步是 noop。
    //
    // **失败容忍**：sessionDir 目录权限异常 / 父路径是文件 / 磁盘满都
    // 可能让 mkdir 抛错。这条路径**不能让构造失败**——否则宿主装配
    // 引擎时直接崩溃，连 headless / 测试用例都跑不起来。降级策略：
    // mkdir 失败时回退到 lazy mkdir + 字面 path（沿用 W3 _ensureDir 路径，
    // realpath 同样容错）；后续 `save()` 真写盘时再次 mkdir，那时若仍
    // 失败 logger.warn 会把错误透出，跟 W3 行为对齐。
    const dir = path.join(sessionDir, TOOL_RESULTS_SUBDIR);
    let canonical = dir;
    let dirReady = false;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      dirReady = true;
      try {
        canonical = fs.realpathSync(dir);
      } catch {
        // realpath 失败（罕见，目录刚创建）→ 用字面 path 兜底，
        // dogfood symlink 场景下豁免会漏命中，但不影响生产 ~/Library 路径。
      }
    } catch {
      // mkdir 失败 → 留给 _ensureDir lazy 重试，_dir 用字面 path。
    }
    this._dir = canonical;
    this._dirEnsured = dirReady;
    this._logger = options?.logger ?? defaultLogger;
  }

  save(id: string, _toolName: string, content: string): void {
    this._ensureDir();
    const filePath = this.getFilePath(id);
    fs.promises
      .writeFile(filePath, content, { flag: 'wx', mode: 0o600 })
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'EEXIST') return;
        // Not a duplicate write — surface to the logger so the host can
        // alert on disk pressure / permission issues. Fire-and-forget:
        // the truncation banner the LLM sees still names the path; if
        // disk write fails, `read_file` will fail telling the LLM the
        // file is missing, which is honest.
        this._logger.warn(
          `[FileToolResultStorage] writeFile failed (${err.code ?? 'UNKNOWN'}): ${err.message}`,
          { id, code: err.code },
        );
      });
  }

  getFilePath(id: string): string {
    return path.join(this._dir, `${safeFilename(id)}.txt`);
  }

  /**
   * **W4 (2026-05-12)** — see `ToolResultStorage.getResultsDir` interface
   * doc for usage. Returns the per-session tool-results directory absolute
   * path (`<sessionDir>/tool-results`), independent of any per-call id.
   */
  getResultsDir(): string {
    return this._dir;
  }

  private _ensureDir(): void {
    if (this._dirEnsured) return;
    try {
      fs.mkdirSync(this._dir, { recursive: true });
    } catch {
      // Best-effort; save() will silently fail on the writeFile if dir missing.
    }
    this._dirEnsured = true;
  }
}

// ─── MemoryToolResultStorage ────────────────────────────────────────

/**
 * No-op storage that swallows `save()` and returns `''` from `getFilePath()`.
 * Useful for unit tests that want to assert "the budget enforcer called save
 * with id X" without touching disk. Production hosts always use
 * `FileToolResultStorage`.
 */
export class MemoryToolResultStorage implements ToolResultStorage {
  private _warned = false;

  save(_id: string, toolName: string, content: string): void {
    // No-op: nothing to persist in memory-only mode. Warn once so host
    // integrators notice missing FileToolResultStorage before LLM hits a
    // dead-end truncation banner.
    if (!this._warned) {
      this._warned = true;
      defaultLogger.warn(
        '[MemoryToolResultStorage] oversized tool output was not persisted — '
        + 'inject FileToolResultStorage in production hosts so the LLM can '
        + 're-read truncated output via read_file',
        { toolName, contentLength: content.length },
      );
    }
  }

  getFilePath(_id: string): string {
    return '';
  }
}

// ─── Factory Helper ──────────────────────────────────────────────────

/**
 * Resolve the effective storage from an EngineConfig-shaped object.
 * Returns the host-injected storage when present, otherwise a
 * `MemoryToolResultStorage` so callers always have a concrete target
 * (no nullish branches downstream).
 *
 * Hosts that want to disable persistence entirely should pass an
 * `undefined` storage to `EngineConfig.toolResultStorage` and the
 * runtime falls back to in-content head+tail truncation banners that
 * say `Full output not persisted in this host` — see
 * `enforceToolOutputBudget`.
 */
export function resolveToolResultStorage(config: {
  toolResultStorage?: ToolResultStorage;
}): ToolResultStorage {
  return config.toolResultStorage ?? new MemoryToolResultStorage();
}
