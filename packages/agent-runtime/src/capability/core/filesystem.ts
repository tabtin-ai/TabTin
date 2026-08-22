/**
 * FileSystemCap —— Core Capability：文件系统相关的配置容器。
 *
 * 原有的 list_directory / mkdir 两个工具已在工具系统宪法 W1 中删除——
 * LLM 通过 run_terminal_command ls/mkdir 即可完成同等操作，冗余 FC 不保留。
 *
 * 当前职责：
 *   - 为后续 W3 HITL Pipeline 提供 deny_read/write_paths 配置
 *
 * read_file / write_file / delete_file 统一在 adapter 端的
 * read_file / write_file / edit_file / delete_file（tabcode-adapter）。
 *
 * **历史**：曾通过 `instructions()` 把 deny_read/write/custom_write/file_access
 * 等字段拼成软提示给 LLM，阶段 2.3（2026-05-20）删除 —— `Capability.instructions?()`
 * 接口下线后所有 5 个 cap 实现连同字段一并清理。未来若 W3 HITL 需要把策略软提示
 * 给 LLM，走 `@tabtin/agent-prompt` + prompt-contract 注册表，而非恢复本类的
 * `instructions()` 方法。
 */

import type {
  Tool,
} from '../../engine/contracts/tools.js';
import type { CapabilityCategory } from '../capability.js';
import { CapabilityBase } from '../base.js';

/**
 * v2 `capabilities.overrides.filesystem` 形状（与 Django
 * `apps/tabtinspace/agent_config_v2.py::build_default_agent_config_v2`
 * 的 filesystem 块对齐）。
 *
 * **字段语义**：
 *   - `sandbox_level`: 'filesystem' | 'network' | 'none' —— 期望的
 *     沙箱隔离级别。当前 W2.2.1 仅作为配置容器持有；W3 HITL Pipeline
 *     基于此字段决策审批路径。
 *   - `file_access`: 'workspace' | 'organization' | 'open' —— Agent 可见
 *     的文件视图范围。W2.2.1 仅持有。
 *   - `custom_write_paths`: 显式额外可写白名单（绝对路径或 `~` 起手）。
 *     与 deny_write_paths 同时存在时白名单优先 —— 但 W2.2.1 不强制。
 *   - `deny_read_paths` / `deny_write_paths`: 黑名单。外层 v3 judge()
 *     在 beforeTool 强制拒绝。
 *
 * **设计考量**：本类型独立维护一份而非 import @tabtin/app-shell —— 后者是
 * UI / Renderer 侧的类型，agent-runtime（pure TS 库）依赖它会反向
 * 耦合（Daemon 里没装 app-shell）。两边通过结构兼容（Pyhton agent_config_v2
 * + TS app-shell + 本类型）三处对齐字段名 + 语义。
 */
export interface FilesystemCapConfig {
  sandbox_level?: 'filesystem' | 'network' | 'none' | string;
  file_access?: 'workspace' | 'organization' | 'open' | string;
  custom_write_paths?: string[];
  deny_read_paths?: string[];
  deny_write_paths?: string[];
}

// ─── FileSystemCap ───────────────────────────────────────────────────
export class FileSystemCap extends CapabilityBase {
  readonly type = 'filesystem';
  readonly category: CapabilityCategory = 'core';

  /**
   * 配置快照——构造时浅拷贝一次后只读，clone 时由基类 structuredClone
   * 复制（plain object，能 clone）。
   *
   * 字段命名保留 v2 snake_case，与 agent_config 形状对齐，避免读字段
   * 时手动 camel/snake 转换；TS 端只在工具暴露给 LLM 的 schema 字段
   * 名上才用 camelCase（"recursive" / "force" 等）。
   */
  private readonly _config: Readonly<FilesystemCapConfig>;

  constructor(config?: FilesystemCapConfig) {
    super();
    this._config = Object.freeze({ ...(config ?? {}) });
  }

  tools(): Tool[] {
    return [];
  }

  /**
   * Capability 不依赖任何其他 Cap —— 直接写文件 / 读文件，不需要
   * Skills / Cost / Audit 协助。
   */
  required_capability_types(): ReadonlySet<string> {
    return new Set();
  }

  /**
   * 供 W3 HITL Pipeline 读取配置（deny_read/write_paths / custom_write_paths /
   * sandbox_level / file_access）。当前 cap 仅作为配置容器，没有 tools / hooks /
   * instructions —— 真实的策略执行在外层 judge() / approval 链路。
   */
  getConfig(): Readonly<FilesystemCapConfig> {
    return this._config;
  }

}
