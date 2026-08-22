/**
 * System 工具集 —— Agent 在对话流中发起的"系统级动作"
 *
 * 当前覆盖：
 *   - `relaunch_app`：用户授权 macOS TCC 后必须重启进程才能生效。
 *     Agent 在对话里得到用户肯定回复后调用。
 *   - `clear_os_error_blacklist`：用户表示"我已经授权了 / 已下载完了"
 *     等之后，Agent 调用此工具解封某路径，让后续读写工具能再次尝试。
 *
 * **命名约束**：工具名必须满足 LLM 上游正则 `^[a-zA-Z0-9_-]{1,64}$`（OpenAI /
 * Anthropic tool function name 硬约束，不允许点号 / CJK / 空格）。所有新工具
 * 一律用 snake_case 或 dashes，参考 `proxy-provider.ts:TOOL_NAME_RE`。
 * 历史命名 `system.relaunch_app` / `system.clear_os_error_blacklist` 已于
 * 2026-04-30 改为下划线版本以解除 LLM 阻塞（dogfood P0）。
 *
 * 设计意图：
 *   - 这些动作的「决定权」在用户对话回应里，不弹任何应用内对话框
 *   - 宿主（Electron Main / Daemon）通过 deps 注入实际行为，agent-runtime
 *     不直接 import electron 包
 */

import path from 'node:path';
import os from 'node:os';

import type {
  Tool,
  ToolResult,
} from '../engine/contracts/tools.js';
import type { OSErrorBlacklist } from '../permissions/os-error-blacklist.js';
import { jsonError } from '../capability/core/_utils.js';
import { INTERNAL_ERROR, MISSING_REQUIRED_PARAM } from '../engine/errors/error-kinds.js';

/**
 * 把"用户语义路径"规范化为"OS 绝对路径"——让 `clear_os_error_blacklist`
 * 收到的 LLM 入参（可能是 `~/Desktop`、相对路径、含 `..` 段）能匹配到黑名单里
 * 存的真实绝对路径（`OSError.path` 已被 safe-fs 展开过）。
 *
 * **Wave 1 第三轮 三视角 Review 共识必修**：
 *
 *   - 用户场景：用户授权后说"我授权了 Desktop"，LLM 转述给 Agent 时常传
 *     `path: '~/Desktop'`（追随用户口语），但黑名单里 `originalPath` 是
 *     `/Users/foo/Desktop`（真实拒绝时 safe-fs 拿到的绝对路径）。
 *   - 修前：`clearByOriginalPath` 字符串前缀匹配 `~/Desktop` vs `/Users/foo/Desktop`
 *     → 0 命中 → 工具返回"这条路径其实没有进封锁记录"→ 用户耳朵里像
 *     Agent 不承认刚才报的错，体验断点。
 *   - 修后：规范化后再传给黑名单，匹配按"用户授权了某个目录子树"的真实
 *     OS 语义兑现。
 *
 * **不在 OSErrorBlacklist 内做规范化**：blacklist 是"路径数据存取的源真"，
 * 应保持 OS-agnostic（cross-process 同步 / 持久化 / 跨平台都不该假设 caller
 * 跑在能读 home 的进程里）。规范化属于"用户输入清洗"——更接近工具层职责。
 */
function normalizeUserSuppliedPath(rawPath: string): string {
  if (!rawPath) return rawPath;
  let abs = rawPath;
  if (abs.startsWith('~')) {
    try {
      abs = path.join(os.homedir(), abs.slice(1));
    } catch {
      // homedir() 仅在异常进程环境（如 chroot 没 HOME）才抛——拿不到时
      // 回落到原字符串，让 caller 通过 LLM 自己再问用户绝对路径。
      return rawPath;
    }
  }
  return path.normalize(abs);
}

export interface SystemToolsDeps {
  /**
   * 宿主提供的"重启自身"实现：
   *   - Electron Main：app.relaunch() + app.exit(0)
   *   - Daemon：spawn 新进程后 process.exit(0)
   *   - Web / 测试环境：可省略，工具会返回 "unsupported"
   */
  relaunchApp?: () => Promise<void>;

  /**
   * 共享的 OSErrorBlacklist 实例 —— 与 Engine 内部用于工具结果短路的实例同源。
   * 省略时 clear_os_error_blacklist 工具会返回 "unsupported"。
   */
  osErrorBlacklist?: OSErrorBlacklist;

  /**
   * 可选：实际重启前给 Agent runtime 一个钩子（清理流式状态、保存草稿等）。
   * 不抛错就视为可继续重启；抛错则取消并把错误返回给 Agent。
   */
  beforeRelaunch?: () => Promise<void>;
}

const relaunchInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description:
        // 阶段 6.6 议题 3 翻译。保留 telemetry / macOS 等术语。
        '为什么现在需要重启 TabTin（会落 telemetry）。典型：用户授予了 macOS 文件访问权限。',
    },
  },
  required: ['reason'],
  additionalProperties: false,
};

function createRelaunchAppTool(deps: SystemToolsDeps): Tool {
  return {
    name: 'relaunch_app',
    policyActionKind: 'device',
    description:
      '重启 TabTin 宿主进程，让新授权的操作系统权限生效。' +
      '**只在**用户说"我授权了"之后原工具调用仍失败时调本工具——大部分文件夹级授权' +
      '（Desktop / Documents / Downloads / Removable / Network）立即生效，**不需要**重启。' +
      '需要重启才生效的能力授权：Full Disk Access、屏幕录制、麦克风、摄像头、network entitlement、' +
      '第三方杀毒白名单变更。' +
      '不确定时先重试原工具；同样的操作系统错误再次出现，再调本工具。' +
      '用户在对话里的回复**就是**重启的同意信号——**不要**主动调本工具。',
    inputSchema: relaunchInputSchema,
    isReadOnly: false,
    execute: async (input: unknown): Promise<ToolResult> => {
      const { reason } = (input ?? {}) as { reason?: string };
      if (!deps.relaunchApp) {
        // Daemon / 服务进程模式下没有 Electron app.relaunch()——重启由系统服务
        // 管理器（macOS launchd / Linux systemd / Windows 服务）控制。这不是
        // "工具坏了"，而是部署模式的硬约束。`isError: false` 让 LLM 把消息
        // 讲给用户后不再反复尝试（isError:true 会触发某些 LLM 的"工具失败
        // 自动重试"模式，反而把用户搞糊涂）。
        //
        // 文案分两层（Wave 1 第二轮 Review M-6 修订）：
        //   - `user_message` —— LLM 直接念给用户听的人话，不含工程术语
        //   - `technical_note` —— 给 LLM 自己的内部上下文，含 launchd /
        //     clear_os_error_blacklist 等工具名供其后续决策
        // LLM 看到 `user_message` 字段会优先把它转述给用户。
        return {
          content: JSON.stringify({
            status: 'unsupported_in_this_runtime',
            runtime: 'daemon',
            user_message:
              '我现在跑在 TabTin 后台服务模式下，没法自己重启。请你手动重启一下 TabTin' +
              '（怎么启动的就怎么重启，比如命令行起的就 Ctrl+C 后再跑一次），' +
              '重启完了告诉我一声，我帮你接着试。',
            technical_note:
              'Daemon mode runs under launchd (macOS) / systemd (Linux) / service manager (Windows); ' +
              'app.relaunch is unavailable. After user manually restarts the daemon, call ' +
              'clear_os_error_blacklist to unblock the failed path, then retry the original tool.',
          }),
          isError: false,
        };
      }
      try {
        if (deps.beforeRelaunch) await deps.beforeRelaunch();
      } catch (err) {
        // Wave 1 第二轮 用户视角 Review：直接把 err.message 拼到对话里
        // （如 "Pre-relaunch hook failed: relaunch_aborted_by_user"）会让
        // LLM 把奇怪的英文堆给用户。区分两类：
        //   - 已知"用户主动取消重启"（exit-guard-relaunch-hook 抛 message
        //     === 'relaunch_aborted_by_user'）→ 给中文 user_message
        //   - 其他未知错误 → 不暴露内部 message，给受控中文兜底（避免泄漏
        //     stack / 路径 / 内部状态——技术视角 Review 的硬要求）
        const errMessage = err instanceof Error ? err.message : String(err);
        const isUserCancelled = errMessage === 'relaunch_aborted_by_user';
        return jsonError(
          isUserCancelled
            ? '我刚才请你确认是否要重启 TabTin（重启后我才能用上你刚授权的权限），你点了取消，所以这次没重启。如果你后来又想让我重启，告诉我一声。'
            : '我尝试在重启前先帮你保存未存改动，但这一步没顺利完成，所以我没有重启 TabTin（避免动了你的工作）。你可以稍后再让我试一次，或者自己手动重启 TabTin。',
          {
            // user 主动 cancel 走 catalog 现有 'aborted' 文案池（normalize 表里
            // aborted_by_user → aborted），soft + userInitiated；hook 抛非 cancel
            // 错走内部异常分支。
            error_kind: isUserCancelled ? 'aborted_by_user' : INTERNAL_ERROR,
            status: 'aborted',
            user_cancelled: isUserCancelled,
            hint: isUserCancelled
              ? 'Do not retry relaunch_app unless the user explicitly asks to restart again.'
              : 'Do not restart automatically; ask the user to save work or restart TabTin manually.',
            technical_note: isUserCancelled
              ? 'beforeRelaunch hook signalled user cancel via exit-guard dialog.'
              : 'beforeRelaunch hook threw a non-cancel error; details are intentionally not propagated to the LLM-visible content for safety.',
          },
        );
      }
      // 调相当于 fire-and-forget —— 进程随后会退出，本工具的返回值实际上
      // 在用户重新打开 TabTin 后已经不会被消费。仍返回成功状态便于 telemetry。
      void deps.relaunchApp().catch(() => {
        /* 进程已退出，再处理 promise 已经无意义 */
      });
      return {
        content: JSON.stringify({
          status: 'restarting',
          reason: reason ?? 'unspecified',
          // Wave 1 第二轮 用户视角 Review：原英文 "TabTin is restarting..."
          // LLM 弱模型可能直译成奇怪中文。直接给中文 user_message 让 LLM 念。
          user_message:
            'TabTin 正在重启，这次对话会暂时断开几秒钟。重启完成后我会自动重新打开，你可以让我接着试刚才那个被卡住的任务（比如再让我读那个文件夹）。',
          technical_note:
            'Agent session ends here (Electron app.relaunch + app.exit). On next launch, ' +
            'newly granted OS permissions take effect. User can re-issue the original task.',
        }),
      };
    },
  };
}

const clearBlacklistInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        // 阶段 6.6 议题 3 瘦身 + 翻译：示例 / 子树语义 / 整体清除约束已搬到
        // 工具 description（system-tools.ts:222-230）。L1 只留"传授权路径 +
        // POSIX 子树规则"硬契约。
        '用户授权的那个路径（绝对路径）。清除会同时解锁该路径以及它所有子路径下记录的条目（POSIX 子树语义），不需要为每个子文件单独调用。',
    },
    reason: {
      type: 'string',
      description:
        '为什么认为底层问题已解决（譬如"用户表示已授权并重启"）。',
    },
  },
  required: ['path', 'reason'],
  additionalProperties: false,
};

function createClearOSErrorBlacklistTool(deps: SystemToolsDeps): Tool {
  return {
    name: 'clear_os_error_blacklist',
    description:
      '清除 runtime 缓存——这个缓存会阻止你重试之前遇到操作系统级错误的路径' +
      '（TCC 拒绝、杀毒拦截、云占位符等）。' +
      '**只在**用户在对话里确认他们处理了底层问题（授予权限、下载了文件、加入杀毒白名单）后调本工具。' +
      '**不支持**整体清除——必须指定路径。' +
      '语义：传用户说他授权的那个路径（如他提到的文件夹名）。清除会解锁该路径下记录的所有文件系统工具' +
      '调用 + 所有子路径下记录的调用——匹配用户"我授权了那个文件夹"的意图（POSIX 上等同整个子树）。' +
      '示例：用户授权了 "~/Desktop"。调用 clear({path:"/Users/foo/Desktop"}) 会解锁 ' +
      '"/Users/foo/Desktop"、"/Users/foo/Desktop/a.png"、"/Users/foo/Desktop/screenshots/x.jpg" 等所有条目，' +
      '一次搞定。通常**不需要**为每个子文件单独调一次 clear。',
    inputSchema: clearBlacklistInputSchema,
    isReadOnly: false,
    execute: async (input: unknown): Promise<ToolResult> => {
      const { path, reason } = (input ?? {}) as { path?: string; reason?: string };
      if (!deps.osErrorBlacklist) {
        // Wave 1 第二轮 Review S-3 + 用户视角：本宿主未注入黑名单（典型：
        // 测试 / 早期定制宿主）。**不视作错误**——LLM 看到 isError:true 会
        // 反复改参数重试；此处给出"无黑名单模式直接重试"的中性中文文案。
        // 与 relaunchApp 缺省（同模式 + 中文 user_message + isError:false）
        // 对称（产品视角 Review 必修）。
        return {
          content: JSON.stringify({
            status: 'unsupported_in_this_runtime',
            user_message:
              '我这个运行模式下没有"短路缓存"机制——你授权完之后，我直接重试原工具就好，' +
              '不需要先调用解封工具。',
            technical_note:
              'osErrorBlacklist is not wired into this host (typical for tests / minimal hosts). ' +
              'Skip clear and retry the original tool directly — there is no cache to invalidate.',
          }),
          // 不算错误——LLM 看到非 isError 会把内容讲给用户后正常推进。
          isError: false,
        };
      }
      if (!path || typeof path !== 'string') {
        return jsonError(
          '我没拿到要解封的路径。请告诉我刚才被拦的是哪个文件或文件夹（比如 /Users/foo/Desktop），' +
            '我才能去清掉缓存让自己重试。',
          {
            error_kind: MISSING_REQUIRED_PARAM,
            status: 'error',
            hint: 'Ask the user which file or folder they authorized, then pass that absolute path to clear_os_error_blacklist.',
            technical_note: '`path` is required and must be a non-empty string.',
          },
        );
      }
      // 双维度清理：
      //   1. `clear(path)` 命中 path 维度条目（safe-fs 直接调用方写入的）
      //   2. `clearByOriginalPath(path)` 命中 toolCall 维度条目
      //      （tool-orchestration 写入的 —— 内部 key 是合成串，但 originalPath
      //       字段是真实 OSError.path）
      // 两者必须都跑——用户给的 path 不知道是哪种写入路径触发的。
      //
      // **第二维度还会按 POSIX 子树前缀解封**（M-5 修订）：clear({path: '~/Desktop'})
      // 命中 originalPath 是 ~/Desktop / ~/Desktop/a.png / ~/Desktop/sub/b.jpg
      // 等所有子路径条目，对齐用户"我授权了这个目录"的真实意图。
      //
      // **路径规范化**（Wave 1 第三轮 三视角 Review 共识必修）：LLM 转述用户
      // "我授权了 Desktop"时常传 `~/Desktop`，但黑名单里 originalPath 是真实
      // 绝对路径 `/Users/foo/Desktop`。直接字符串前缀匹配会 0 命中，导致用户
      // 耳里"我授权了你又说没记录"的体验断。展开 ~ + path.normalize 后再传给
      // blacklist，匹配按"OS 子树语义"兑现用户授权意图。
      const normalizedPath = normalizeUserSuppliedPath(path);
      const clearedPathDim = deps.osErrorBlacklist.clear(normalizedPath);
      const clearedToolCallDim = deps.osErrorBlacklist.clearByOriginalPath(normalizedPath);
      const cleared = clearedPathDim + clearedToolCallDim;
      return {
        content: JSON.stringify({
          status: 'ok',
          path,
          reason: reason ?? 'unspecified',
          cleared_entries: cleared,
          // Wave 1 第二轮 用户视角 Review 必修：原英文 message 让 LLM 在中文
          // 对话里突然讲英文。给 user_message 让 LLM 直接念，给 technical_note
          // 自留（含工具名供 LLM 后续决策，不该被念给用户）。
          user_message:
            cleared > 0
              ? `好的，我已经把对 ${path} 的封锁记录清掉了（共 ${cleared} 条），现在我可以再试一次刚才被卡住的操作。`
              : `${path} 这条路径其实没有被我加进封锁记录里——可能是你说的路径和我刚才报错时的路径不完全一致，` +
                `也可能我已经清过了。你直接让我再试一次原来那个操作就好。`,
          technical_note:
            cleared > 0
              ? `Cleared ${cleared} OSErrorBlacklist entry/entries for ${path} (path-dim=${clearedPathDim}, originalPath-dim=${clearedToolCallDim}). Retry the original tool now.`
              : `No blacklist entry matched ${path}. Either path mismatch with originalPath, or already cleared. Retry directly.`,
        }),
      };
    },
  };
}

export function createSystemTools(deps: SystemToolsDeps): Tool[] {
  return [createRelaunchAppTool(deps), createClearOSErrorBlacklistTool(deps)];
}
