/**
 * judge.ts — 授权策略 v3 单一判决函数
 *
 * 实现 spec 附录 A 的 5 步流程。
 *
 * 调用契约：
 *   - 由 `tool-orchestration.ts::runTools` 在 tool 入口为每个 tool call 调一次
 *   - 同一 batch 内复用同一份 EffectivePolicy 快照（policy 不变）
 *   - 判决纯函数：除读 memoStore + 调 normalize 外无副作用
 *   - 异常 fail-closed：调用方应外层 try/catch；内部异常会**直接抛**让调用方决定
 *     ask 或 deny；本函数不做 swallow
 *
 * 设计要点（ 三档审批策略）：
 *   - `approvalMode` 三档由 build-policy 派生（requested + approval_grant + !group）：
 *     `always_ask`（请求批准，原 agent 行为）/ `auto`（替我审批，原 yolo）/
 *     `full_access`（完全访问，新增档）。
 *   - Step 1 红线按 tier 分层：`catastrophic`（rm -rf / 等灾难级）三档均 deny；
 *     `risk`（sudo 等）always_ask deny、auto 转 ask（policy_risk_ask）、full_access 放行。
 *     sensitive_out_deny 同款：always_ask deny、auto 转 ask、full_access 放行。
 *   - Step 2.5 sensitive_in_ask 仅 always_ask 档触发（auto / full_access 豁免，DR-15）。
 *   - Step 3：auto / full_access 直接 allow（auto_allow / full_access_allow）。
 *   - object_read 直接 allow；object/object_write ask
 *   - mcp 类一律 ask（除 memo 命中）
 *   - device observe allow；device interact/未声明 ask
 */

import type {
  Decision,
  DecisionReason,
  JudgeContext,
  JudgeTool,
  PolicyActionKind,
  ResolutionHint,
  ApprovalMode,
} from './types-v3.js';

import {
  checkHardlineCommand,
  checkHardlinePath,
  checkOpaquePowerShellCommand,
  checkSensitivePath,
  extractPathsFromCommand,
  hasOpaqueWindowsDeleteTarget,
  isAbsoluteShellPath,
  isWindowsFileDeleteCommand,
  type HardlineHit,
} from './hardline-v3.js';
import { normalize, isInWorkspace, isCwdInWorkspace } from './path-normalize.js';
import { isPlatformArtifactReadAllowed } from './platform-artifact-paths.js';
import { isShellCommandWriteOp } from './shell-command-side-effect.js';
import { buildApprovalKey } from './pattern-key.js';
import { detectPlatformManagedTabtinCli } from './platform-cli-deferral.js';
import { UNKNOWN_WORKSPACE_OUT_PATH } from './approval-contract.js';
import {
  evaluateAgentModeToolAccess,
  isPlanModeGuardActive,
  isAgentModeName,
  type AgentModeName,
} from '@tabtin/agent-modes';

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

export { UNKNOWN_WORKSPACE_OUT_PATH } from './approval-contract.js';

export function judge(ctx: JudgeContext): Decision {
  const { tool, input, effectivePolicy, memoStore, homeDir, agentMode } = ctx;
  const approvalMode: ApprovalMode = effectivePolicy.approvalMode;
  const kind: PolicyActionKind = tool.policyActionKind ?? 'object';
  const subcmd = safeExtract(tool.extractSubcmd, input) ?? '';
  const isWrite = safeIsWrite(tool, input);

  // ── Step 0: Agent Mode Tool Guard（主闸门）─
  //
  // **v3 重构（2026-05-27）**：本 step 调用 SSoT `evaluateAgentModeToolAccess`，
  // 把 ask / plan / study 三个受限模式下的工具策略判定收口到一个函数。
  //
  // 历史背景（W7 / L1）：plan-mode-guard 走 `tool-orchestration.ts` pre-check
  // 路径，但 `hasJudge=true` 主路径整段 pre-check 跳过——普通 file 工具靠
  // `filterToolsForMode` 在 ToolProvider 层移除挡住，但 `PLAN_TARGET_GUARDED_TOOLS`
  // 这类 plan 仍可见但需绑 active plan 的写工具裸奔。
  //
  // **进一步治理**：`filterToolsForMode` 退化为 identity
  // ——所有模式都能看到完整工具列表，但调用时由本 step 0 软拒并返回带
  // `remediation` 的结构化错误。这关闭了"模型在 ask 模式调 write_file 撞红线
  // 才学到边界"的 dogfood 痛点；同时也修复了**P0 裸奔**：filter 退化后如果
  // step 0 不扩展，write_file 在工作区内会被 step 4 直接 allow 真写入磁盘。
  //
  // 顺序要求（**必须**在 step 4 workspace allow 之前）：
  //   - mode 拒绝是产品决策（与 yolo 完全解耦：yolo 也不能开 plan 模式写）
  //   - memo `allow` 不能让 plan 模式放行写工具（与 sensitive_in_ask 同款治理）
  //   - 红线仍兜底，但语义上 mode_restricted 是更上游的决策（mode-level 而非
  //     path-level），先于红线判定让 reason 字段更精确
  //
  // ── TD-15（已解决，文档化路线选项 B）──
  //
  // Plan 模式 **不再支持 inline TabDoc 编辑**。`tabdoc_update_document` /
  // `tabdoc_replace_content` 等 tabdoc_* 写工具在 plan 模式走 step 0 的
  // `mode_disallowed_tool` deny 路径——即使 orchestration legacy 路径曾依赖
  // active plan tracker 做 target 豁免，hasJudge=true 主路径也不注入 tracker。
  //
  // 产品意图：plan_create 落 TabDoc + PlanProposalCard；后续改 TabDoc 正文须
  // 用户点「执行」切 agent 模式。任务清单微调走 `plan_update_todos`；本地
  // 笔记走 `.md` / `.canvas.tsx` 草稿路径。
  //
  // judge 不接 active plan tracker —— target 细颗粒度校验由 agent-runtime/
  // permissions/plan-mode-guard.ts 在 hasJudge=false 路径兜底。
  if (isPlanModeGuardActive(coerceAgentMode(agentMode))) {
    const modeName = coerceAgentMode(agentMode);
    if (modeName) {
      // P0-2 修复（2026-05-27）：isReadOnly 优先读 tool 自声明，无值才 fallback
      // 到 `!isWrite`。
      //
      // 旧 bug：`isReadOnly: !isWrite` 把 `safeIsWrite` 的"按 kind 推断"语义
      // 当成 readonly 判定——`safeIsWrite` 对 device/object/mcp 默认返回 false
      // → isReadOnly=true → 这些工具被 `defaultAllowReadOnly` 错误放行。
      //
      // 现在工具在注册时显式声明 `isReadOnly`（譬如 `relaunch_app: false` /
      // `read_file: true`），SSoT evaluate 直接消费工具自声明，与 mode policy
      // 的 `defaultAllowReadOnly` / `mcpReadOnlyOnly` 语义对齐。
      const isReadOnly = safeIsReadOnly(tool, input, isWrite);
      const workspaceRoot =
        effectivePolicy.workspace.sources.workingDir || undefined;
      const result = evaluateAgentModeToolAccess({
        tool: { name: tool.name, isReadOnly },
        toolInput: input,
        agentMode: modeName,
        workspaceRoot,
      });
      if (!result.allowed) {
        const err = result.error;
        return {
          behavior: 'deny',
          reason: {
            type: 'plan_blocked',
            mode: modeName,
            deny_code: err.deny_code,
            error_kind: 'mode_restricted',
            tool_name: err.tool_name,
          },
          userVisibleReason: err.error,
          resolutionHints: [
            {
              action: 'switch_tool',
              suggestion: err.remediation.hint,
            },
          ],
        };
      }
    }
  }

  // 向后兼容：保留 W7 `planTargetWriteGuarded` 标记的兜底分支（hasJudge=false
  // 路径 / 老测试不依赖完整 evaluate 时仍能 plan_blocked）。新主路径已被上面
  // 的 SSoT evaluate 覆盖（同样的 PLAN_TARGET_GUARDED_TOOLS 走 default deny
  // 路径）。本分支不会让 Phase 1 验收的"write_file in workspace" 通过——
  // write_file 不是 planTargetWriteGuarded 工具，主要靠上面的 SSoT evaluate 拦。
  if (effectivePolicy.planModeGuardActive && tool.planTargetWriteGuarded) {
    return {
      behavior: 'deny',
      reason: {
        type: 'plan_blocked',
        mode: agentMode ?? 'plan',
        deny_code: 'mode_disallowed_tool',
        error_kind: 'mode_restricted',
        tool_name: tool.name,
      },
      userVisibleReason: `${agentMode ?? 'plan'} mode does not allow writes via '${tool.name}'`,
      resolutionHints: [
        {
          action: 'switch_tool',
          suggestion: 'End this turn so the user can switch to agent mode (or click Execute on the proposal card) before retrying.',
        },
      ],
    };
  }

  // 提取 path：file 类的 file_path / shell 类的 cwd
  // 路径权限治理 Wave 4 (L5)：extractPath 现支持多路径返回。
  // - 单路径用 `normalizedPath`（保留）；
  // - 多路径全部 normalize 后写到 `allNormalizedPaths`（用于 file 分支
  //   AND 严格 workspace boundary + 红线 + 敏感四态批判定）。
  // 单路径与多路径在 file 分支语义统一：对所有元素逐条跑红线 / 敏感 /
  // workspace 判定，任一 deny 即整体 deny；workspace_in 要求所有元素都在
  // workspace 内。这与"用户授权了 X 不等于自动授权 Y"的产品意图一致。
  const allRawPaths = safeExtractAll(tool.extractPath, input);
  const allNormalizedPaths: string[] = allRawPaths
    .map((p) => normalize(p, homeDir).path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  const rawPath = allRawPaths[0];
  const normRes = rawPath ? normalize(rawPath, homeDir) : undefined;
  const normalizedPath = normRes?.path;
  const pathResolved = normRes?.resolved ?? false;
  const shellCommand = kind === 'shell' ? safeStringField(input, 'command') : undefined;
  const shellCommandIsWrite = shellCommand
    ? (
        typeof tool.isWriteOp === 'function'
          ? !!tool.isWriteOp(input)
          : isShellCommandWriteOp(shellCommand)
      )
    : false;
  const shellIsWindowsDelete = shellCommand
    ? isWindowsFileDeleteCommand(shellCommand)
    : false;

  // ── Step 1: 红线 ────────────────────────────────────────
  // 1a. 绝对命令红线（shell 类）
  if (shellCommand) {
    const opaquePowerShellHit = checkOpaquePowerShellCommand(shellCommand);
    if (opaquePowerShellHit.hit) {
      return makeDeny(
        {
          type: 'hardline_command',
          pattern: opaquePowerShellHit.pattern!,
        },
        `系统拦截：${opaquePowerShellHit.description}；请改用可审计的明文命令`,
      );
    }

    const cmdHit = checkHardlineCommand(shellCommand);
    if (cmdHit.hit) {
      const hardlineDecision = resolveHardlineHit(cmdHit, approvalMode, {
        type: 'hardline_command',
        pattern: cmdHit.pattern!,
      }, `系统拦截：${cmdHit.description ?? cmdHit.pattern}，无法通过设置开启`);
      if (hardlineDecision) return hardlineDecision;
    }
  }

  // 1a-bis. shell 参数路径红线（F.1：YOLO 也挡）
  let cachedArgPaths: string[] | undefined;
  if (shellCommand) {
    cachedArgPaths = extractPathsFromCommand(shellCommand, homeDir);

    // 「请求批准」档下，终端删除与 delete_file 对齐为破坏性操作：即便目标
    // 是工作区内相对路径也必须明确确认。这样不依赖 best-effort Checkpoint，
    // 同时保证系统路径删除真的产生审批窗口，而不是 hardline 直接阻止。
    if (shellIsWindowsDelete && approvalMode === 'always_ask') {
      return makeRiskAsk(
        { type: 'hardline_command', pattern: 'windows file deletion' },
        '即将通过终端删除文件，请确认',
        buildApprovalKey(tool.name, subcmd, input, false, {
          kind,
          normalizedCommand: shellCommand,
        }),
      );
    }

    // 「替我审批」仍可自动处理可归属的普通删除；变量、命令替换、wildcard
    // 无法在执行前确认真实目标，必须敲门。完全访问保持既有旁路语义。
    if (
      shellIsWindowsDelete
      && approvalMode === 'auto'
      && hasOpaqueWindowsDeleteTarget(shellCommand)
    ) {
      return makeRiskAsk(
        { type: 'hardline_command', pattern: 'windows opaque delete target' },
        'Windows 删除目标包含动态表达式，无法在执行前确认真实路径',
        buildApprovalKey(tool.name, subcmd, input, false, {
          kind,
          normalizedCommand: shellCommand,
        }),
      );
    }

    const argPaths = cachedArgPaths;
    if (shellCommandIsWrite) {
      for (const ap of argPaths) {
        const apNorm = normalize(ap, homeDir);
        // Windows 盘符 / UNC / `%WINDIR%` 在非 Windows 测试宿主上会被
        // `normalize()` 当相对路径；先检查命令里的原始词法，再以 realpath
        // 结果兜底，避免跨平台语义在触盘前丢失。
        const rawPathHardline = checkHardlinePath(ap, 'shell');
        const apHardline = rawPathHardline.hit
          ? rawPathHardline
          : checkHardlinePath(apNorm.path, 'shell');
        if (apHardline.hit) {
          const hardlineDecision = resolveHardlineHit(apHardline, approvalMode, {
            type: 'hardline_path',
            pattern: apHardline.pattern!,
          }, `系统拦截：命令参数路径 ${apNorm.path} 命中红线`);
          if (hardlineDecision) return hardlineDecision;
        }
      }
    }
  }

  // 1b. 绝对路径红线：仅写操作 + 文件类 触发
  // Wave 4 (L5)：多路径时对每条都查红线，任一命中即 deny。
  if (kind === 'file' && isWrite && allNormalizedPaths.length > 0) {
    for (const p of allNormalizedPaths) {
      const pathHit = checkHardlinePath(p, kind);
      if (pathHit.hit) {
        const hardlineDecision = resolveHardlineHit(pathHit, approvalMode, {
          type: 'hardline_path',
          pattern: pathHit.pattern!,
        }, `系统拦截：${pathHit.description ?? pathHit.pattern}`);
        if (hardlineDecision) return hardlineDecision;
      }
    }
  }

  // 1c. 敏感路径四态
  // 工作区前缀判定：spec §3.6 规则 3 —— ENOENT 时按 fallback path 做前缀匹配
  // （写新文件场景，父目录在工作区内时该 path 也算在工作区内）。
  // iCloud 占位符的"不算在工作区"降级由 host 层在 normalize 之前判断（W2 接通），
  // 本 wave 默认按 fallback path 字面量做前缀匹配。
  // Wave 4 (L5)：多路径时按 AND 严格语义——所有元素都 in workspace 才算
  // inWorkspace。
  void pathResolved; // 保留变量供未来审计 path_unresolved 字段使用
  const inWorkspace = allNormalizedPaths.length > 0
    ? allNormalizedPaths.every((p) => isInWorkspace(p, effectivePolicy.workspace))
    : false;

  // Wave 4 (L5)：敏感路径多路径检查——任一命中 deny 即整体 deny。
  // sensitiveHit 给后面的 ask reason 字段还要用（multi-path 场景给第一个
  // 命中的元素，与现有单路径行为对齐）。
  let sensitiveHit: ReturnType<typeof checkSensitivePath> | null = null;
  let sensitiveHitPath: string | undefined;
  for (const p of allNormalizedPaths) {
    const hit = checkSensitivePath(
      p,
      kind === 'shell' ? 'shell' : 'file',
      inWorkspace,
      isWrite,
    );
    if (hit?.hit && hit.action === 'deny') {
      const sensitiveDecision = resolveSensitiveOutDeny(
        approvalMode,
        {
          type: 'sensitive_out_deny',
          path: p,
          category: hit.category ?? 'unknown',
        },
        `敏感文件（${hit.description ?? hit.category}）在工作区外禁止写入`,
        buildApprovalKey(tool.name, subcmd, input, inWorkspace, {
          kind,
          normalizedPath: p,
        }),
      );
      if (sensitiveDecision) return sensitiveDecision;
    }
    if (!sensitiveHit && hit?.hit) {
      sensitiveHit = hit;
      sensitiveHitPath = p;
    }
  }
  void sensitiveHitPath;

  // ── Step 2: 记忆 ────────────────────────────────────────
  const memoOpts = {
    toolName: tool.name,
    subcmd,
    input,
    inWorkspace,
    kind,
    ...(normalizedPath !== undefined ? { normalizedPath } : {}),
  };
  const command = shellCommand;
  if (command !== undefined) {
    (memoOpts as Record<string, unknown>).normalizedCommand = command;
  }
  let memoHit: ReturnType<typeof memoStore.lookup> = null;
  try {
    memoHit = memoStore.lookup(memoOpts);
  } catch {
    // memoStore 抛错不应影响判决；视为未命中并继续
    memoHit = null;
  }

  if (memoHit) {
    // M4.1 L-W6-24：scope_description 同时写入 reason 字段（让审批卡片 UI 取到）
    // 和 userVisibleReason（让 Agent prompt 看到人话），不是二选一。
    const scopeDesc = memoHit.entry.scope_description;
    const reason: DecisionReason = memoHit.decision === 'allow'
      ? {
          type: 'memo_allow',
          key: memoHit.matchedKey,
          createdAt: memoHit.entry.created_at,
          specificity: memoHit.specificity,
          ...(scopeDesc ? { scope_description: scopeDesc } : {}),
        }
      : {
          type: 'memo_deny',
          key: memoHit.matchedKey,
          createdAt: memoHit.entry.created_at,
          specificity: memoHit.specificity,
          ...(scopeDesc ? { scope_description: scopeDesc } : {}),
        };
    return {
      behavior: memoHit.decision,
      reason,
      approvalKey: memoHit.matchedKey,
      ...(scopeDesc ? { userVisibleReason: scopeDesc } : {}),
    };
  }

  // 敏感路径 ask（YOLO 两步授权 PRD v3 §5.1.6 / DR-15 取代 spec §3.3 旧规则）：
  //
  // 历史规则（已废除）：「yolo 也要敲门」—— sensitive_in_ask 优先于 yolo。
  // 新规则（DR-15）：yolo 模式下 sensitive_in_ask **豁免**（bypass = 极致不打扰）。
  //
  // 仍保留的护栏（yolo 也挡）：
  //   - Layer 1 hardline command / hardline path（step 1 已 deny）
  //   - sensitive_out_deny（工作区外敏感写入，step 1 已 deny）
  //
  // 仅 sensitive_in_ask（工作区内敏感读 / 工作区内非默认敏感）这一档由本步豁免。
  // 放在 memo 之后是为了让"用户已批的敏感路径"能放行（memo allow / deny 双向都 honor）。
  if (
    sensitiveHit?.hit &&
    sensitiveHit.action === 'ask' &&
    approvalMode === 'always_ask'
  ) {
    const approvalKey = buildApprovalKey(tool.name, subcmd, input, inWorkspace, {
      kind,
      ...(normalizedPath !== undefined ? { normalizedPath } : {}),
    });
    return {
      behavior: 'ask',
      reason: {
        type: 'sensitive_in_ask',
        path: normalizedPath!,
        category: sensitiveHit.category ?? 'unknown',
      },
      approvalKey,
      userVisibleReason: '即将访问敏感文件，请确认',
      resolutionHints: [
        { action: 'request_user_help', suggestion: '若该文件确实属于你的工作区，请确认后允许' },
      ],
    };
  }

  // ── Step 3: auto / full_access 旁路 ─────────────────────
  if (approvalMode === 'auto') {
    return {
      behavior: 'allow',
      reason: { type: 'auto_allow' },
    };
  }
  if (approvalMode === 'full_access') {
    return {
      behavior: 'allow',
      reason: { type: 'full_access_allow' },
    };
  }

  // ── Step 4: 工作区 ──────────────────────────────────────
  const approvalKey = buildApprovalKey(tool.name, subcmd, input, inWorkspace, {
    kind,
    ...(normalizedPath !== undefined ? { normalizedPath } : {}),
    ...(command !== undefined ? { normalizedCommand: command } : {}),
  });

  switch (kind) {
    case 'file': {
      if (inWorkspace && normalizedPath) {
        // ：工作区内破坏性写操作需用户确认。
        //
        // 产品决策：非 yolo 模式下，即便路径在工作区内，破坏性（不可逆）写
        // 操作仍要弹审批——对齐 `authorization_policy.py` 的
        // `delete_system: confirm`（`delete_file` 注册 `riskLevel: 'strict'` →
        // `delete_system` category；`sandbox_policy.py` 同款 `approval_required`）。
        //
        // 信号选择：用 `tool.riskLevel === 'strict'` 而非硬编码工具名，让"破坏性
        // 写需确认"成为 strict 档位的通用语义。当前唯一声明 strict 的 file 工具
        // 是 `delete_file`；未来任何 strict file 写工具自动获得同款保护。write_file
        // / edit_file 是 'review' 不受影响（issue 明确不改 write 行为）。
        //
        // 边界：yolo 在 step 3 已 allow（不会到此）；memo allow 在 step 2 已放行
        // （用户已知情同意，不重复打扰）；sensitive_in_ask 在 step 2.5 已处理。
        if (isWrite && tool.riskLevel === 'strict') {
          return {
            behavior: 'ask',
            reason: { type: 'destructive_in_workspace_ask', path: normalizedPath },
            approvalKey,
            userVisibleReason: '即将删除文件，请确认',
            resolutionHints: [
              {
                action: 'request_user_help',
                suggestion: '确认后允许本次删除；若不想删除请拒绝',
              },
            ],
          };
        }
        return {
          behavior: 'allow',
          reason: { type: 'workspace_in', path: normalizedPath, kind: 'path' },
        };
      }
      // 平台自产产物（cli-outputs / tabtin-agent-tasks）：只读免 workspace_out。
      // 写仍走下方 ask——这些目录是平台缓存，不是用户工作区，不允许静默写入。
      if (
        normalizedPath
        && isPlatformArtifactReadAllowed(normalizedPath, isWrite, homeDir)
      ) {
        return {
          behavior: 'allow',
          reason: { type: 'platform_artifact_allow', path: normalizedPath },
        };
      }
      return {
        behavior: 'ask',
        reason: { type: 'workspace_out', path: normalizedPath ?? UNKNOWN_WORKSPACE_OUT_PATH, kind: 'path' },
        approvalKey,
        userVisibleReason: '该路径不在当前工作区内',
        resolutionHints: [
          {
            action: 'request_user_help',
            suggestion: '在 TabFolder 或 TabCode 打开该文件夹后再试',
          },
        ],
      };
    }

    case 'shell': {
      const cwd = safeStringField(input, 'cwd');
      const cwdNorm = cwd ? normalize(cwd, homeDir) : undefined;
      const normalizedCwd = cwdNorm?.path;
      const cwdIn = normalizedCwd
        ? isCwdInWorkspace(normalizedCwd, effectivePolicy.workspace)
        : false;
      const shellCmd = safeStringField(input, 'command');

      if (cwdIn && normalizedCwd) {
        if (shellCmd) {
          // 与 file 工具对称：按命令副作用判读写，再用于敏感四态 / 平台产物只读放行。
          // 旧实现写死 isWrite=true，导致 grep 也被按「写」查敏感路径。
          const shellIsWrite = shellCommandIsWrite;
          const argPaths = cachedArgPaths ?? extractPathsFromCommand(shellCmd, homeDir);
          for (const ap of argPaths) {
            const apNorm = normalize(ap, homeDir);
            const apPath = apNorm.path;
            const apInWs = isInWorkspace(apPath, effectivePolicy.workspace);
            const apSensitive = checkSensitivePath(apPath, 'shell', apInWs, shellIsWrite);
            if (apSensitive.hit && apSensitive.action === 'deny') {
              const sensitiveDecision = resolveSensitiveOutDeny(
                approvalMode,
                {
                  type: 'sensitive_out_deny',
                  path: apPath,
                  category: apSensitive.category ?? 'unknown',
                },
                `命令参数路径 ${apPath} 为工作区外敏感文件，禁止访问`,
                buildApprovalKey(tool.name, subcmd, input, apInWs, {
                  kind,
                  normalizedPath: apPath,
                }),
              );
              if (sensitiveDecision) return sensitiveDecision;
            }
            // ：shell 命令携带**绝对路径**且指向工作区外 → 需人工确认。
            //
            // 根因：shell judge 原本只按 `cwd` 判工作区，而 tool-orchestration 会把
            // LLM 缺省的 `cwd` 合成为 workspaceRoot（永远区内），导致
            // `rm -rf ~/Desktop/xxx` 这类操作**工作区外**路径的破坏性命令在
            // always_ask 下被判 workspace_in → 静默放行，绕过审批。这里与 file 工具的
            // workspace_out 语义对齐：碰工作区外路径就要用户确认。
            //
            // 仅对绝对路径生效：extractPathsFromCommand 只抽绝对/`~`/引号路径，未加引号
            // 的相对路径不会进来；引号相对路径按 cwd(=workspaceRoot) 视为区内，不误伤。
            // auto/full_access 档在 Step 3 已提前放行，不受影响。
            //
            // ：若整条命令是平台受管 tabtin CLI（browser/desktop），workspace_out
            // ask 让位给 CLI 边界 ApprovalGate（避免工具前+平台双弹）。deny 与
            // sensitive_in_ask 不让位——那些不是浏览器闸能覆盖的语义。
            //
            // 平台自产产物：仅**只读**命令跳过 workspace_out；写/删仍 ask。
            if ((isAbsoluteShellPath(ap) || isAbsoluteShellPath(apPath)) && !apInWs) {
              if (isPlatformArtifactReadAllowed(apPath, shellIsWrite, homeDir)) {
                continue;
              }
              return deferWorkspaceOutAskIfPlatformCli(shellCmd, {
                behavior: 'ask',
                reason: { type: 'workspace_out', path: apPath, kind: 'path' },
                approvalKey: buildApprovalKey(tool.name, subcmd, input, apInWs, {
                  kind,
                  normalizedPath: apPath,
                }),
                userVisibleReason: `命令将操作工作区外路径 ${apPath}，请确认`,
              });
            }
            if (apSensitive.hit && apSensitive.action === 'ask') {
              const apKey = buildApprovalKey(tool.name, subcmd, input, apInWs, {
                kind,
                normalizedPath: apPath,
              });
              return {
                behavior: 'ask',
                reason: { type: 'sensitive_in_ask', path: apPath, category: apSensitive.category ?? 'unknown' },
                approvalKey: apKey,
                userVisibleReason: `命令参数涉及敏感文件 ${apPath}，请确认`,
              };
            }
          }
        }
        return {
          behavior: 'allow',
          reason: { type: 'workspace_in', path: normalizedCwd, kind: 'cwd' },
        };
      }
      return deferWorkspaceOutAskIfPlatformCli(shellCmd, {
        behavior: 'ask',
        reason: { type: 'workspace_out', path: normalizedCwd ?? '<no cwd>', kind: 'cwd' },
        approvalKey,
        userVisibleReason: cwd ? '工作目录不在当前工作区内' : '命令未指定 cwd，无法判定工作区',
      });
    }

    case 'object_read':
      if (isWrite) {
        return {
          behavior: 'ask',
          reason: { type: 'object_write_ask' },
          approvalKey,
          userVisibleReason: '对象写操作需要确认',
        };
      }
      return {
        behavior: 'allow',
        reason: { type: 'object_default_allow' },
      };

    case 'object':
    case 'object_write':
      // ：注册档位 riskLevel='safe' 的 object 写工具直接放行。
      // 目标是 todo / plan_create / plan_update_todos 这类「Agent 自身
      // 任务状态」工具——不碰用户资产、无损失面，本质是透明化进度看板；
      // 归进 object_write 一刀切 ask 会把透明工具变成打扰源（每步状态翻转
      // 都弹审批）。真实用户资源写入（TabDoc / TabData）不声明 safe，仍走 ask。
      // reason 复用 object_default_allow，避免 DecisionReason wire schema 变更。
      if (tool.riskLevel === 'safe') {
        return {
          behavior: 'allow',
          reason: { type: 'object_default_allow' },
        };
      }
      return {
        behavior: 'ask',
        reason: { type: 'object_write_ask' },
        approvalKey,
        userVisibleReason: '对象写操作需要确认',
      };

    case 'mcp': {
      const server = safeStringField(input, 'server') ?? safeStringField(input, 'server_id');
      const reason: DecisionReason = server
        ? { type: 'mcp_default_ask', server }
        : { type: 'mcp_default_ask' };
      return {
        behavior: 'ask',
        reason,
        approvalKey,
        userVisibleReason: 'MCP 工具调用需要确认',
      };
    }

    case 'device': {
      if (tool.deviceActionRisk === 'observe') {
        return {
          behavior: 'allow',
          reason: { type: 'device_observe_allow' },
        };
      }
      const deviceAction = safeStringField(input, 'device_action');
      const reason: DecisionReason = deviceAction
        ? { type: 'device_default_ask', device_action: deviceAction }
        : { type: 'device_default_ask' };
      return {
        behavior: 'ask',
        reason,
        approvalKey,
        userVisibleReason: '设备权限调用需要确认',
      };
    }

    default: {
      // 类型穷尽保护：编译期若 PolicyActionKind 新增值未更新本函数，会在此抛错
      const _exhaustive: never = kind;
      void _exhaustive;
      return makeFallbackAsk(approvalKey);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

function resolveHardlineHit(
  hit: HardlineHit,
  approvalMode: ApprovalMode,
  reason: DecisionReason,
  denyMessage: string,
  approvalKey?: string,
): Decision | null {
  if (!hit.hit) return null;
  if (hit.tier === 'catastrophic' || approvalMode === 'always_ask') {
    return makeDeny(reason, denyMessage);
  }
  if (approvalMode === 'auto') {
    return makeRiskAsk(reason, denyMessage, approvalKey, hit.pattern);
  }
  return null;
}

function resolveSensitiveOutDeny(
  approvalMode: ApprovalMode,
  reason: DecisionReason,
  denyMessage: string,
  approvalKey: string,
): Decision | null {
  if (approvalMode === 'always_ask') {
    return makeDeny(reason, denyMessage);
  }
  if (approvalMode === 'auto') {
    const category = reason.type === 'sensitive_out_deny' ? reason.category : undefined;
    return makeRiskAsk(reason, denyMessage, approvalKey, undefined, category);
  }
  return null;
}

function makeRiskAsk(
  baseReason: DecisionReason,
  userVisible: string,
  approvalKey?: string,
  pattern?: string,
  category?: string,
): Decision {
  const reason: DecisionReason = {
    type: 'policy_risk_ask',
    ...(pattern ? { pattern } : {}),
    ...(category ? { category } : {}),
  };
  void baseReason;
  return {
    behavior: 'ask',
    reason,
    ...(approvalKey ? { approvalKey } : {}),
    userVisibleReason: userVisible,
    resolutionHints: [
      {
        action: 'request_user_help',
        suggestion: '该操作存在风险，请确认是否继续',
      },
    ],
  };
}

function makeDeny(reason: DecisionReason, userVisible: string): Decision {
  const hints: ResolutionHint[] = [];
  // 命令 / 路径硬红线：建议用户检查命令、不建议改设置
  if (reason.type === 'hardline_command' || reason.type === 'hardline_path') {
    hints.push({
      action: 'switch_tool',
      suggestion: '该操作系统级危险，请改用更精确的命令或工具',
    });
  }
  if (reason.type === 'sensitive_out_deny') {
    hints.push({
      action: 'request_user_help',
      suggestion: '若该敏感文件确实需要访问，请通过 TabFolder 把目录纳入工作区再试',
    });
  }
  return {
    behavior: 'deny',
    reason,
    userVisibleReason: userVisible,
    resolutionHints: hints,
  };
}

function makeFallbackAsk(approvalKey: string): Decision {
  return {
    behavior: 'ask',
    reason: { type: 'fallback_ask' },
    approvalKey,
    userVisibleReason: '该工具调用需要你确认',
  };
}

/**
 * ：仅把 workspace_out ask 让位给平台 CLI gate。
 * deny / sensitive_in_ask 保持工具前拦截，避免「整条 shell 静默放行」的安全真空。
 */
function deferWorkspaceOutAskIfPlatformCli(
  command: string | undefined,
  decision: Decision,
): Decision {
  if (decision.behavior !== 'ask' || decision.reason.type !== 'workspace_out') {
    return decision;
  }
  const deferral = detectPlatformManagedTabtinCli(command);
  if (!deferral) return decision;
  return {
    behavior: 'allow',
    reason: {
      type: 'platform_gate_deferred',
      surface: deferral.surface,
    },
  };
}

function safeExtract(
  fn: ((input: unknown) => string | undefined) | undefined,
  input: unknown,
): string | undefined {
  if (typeof fn !== 'function') return undefined;
  try {
    const v = fn(input);
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 路径权限治理 Wave 4 (L5)：取出 extractPath 的多路径返回。
 *
 * 兼容三种返回形态（与 ToolPolicyMeta.extractPath 类型扩展配套）：
 *   - `string`：单路径，返回 `[v]`；
 *   - `readonly string[]`：多路径，返回过滤后的非空字符串数组；
 *   - `undefined` / 异常：返回 `[]`。
 *
 * judge file 分支按 AND 严格语义处理多路径——所有元素都在工作区内才放
 * `workspace_in`，任一不在则 ask `workspace_out`（语义见 ToolPolicyMeta
 * doc-comment）。
 */
function safeExtractAll(
  fn: ((input: unknown) => string | readonly string[] | undefined) | undefined,
  input: unknown,
): readonly string[] {
  if (typeof fn !== 'function') return [];
  try {
    const v = fn(input);
    if (typeof v === 'string') {
      return v.length > 0 ? [v] : [];
    }
    if (Array.isArray(v)) {
      return v.filter((p): p is string => typeof p === 'string' && p.length > 0);
    }
    return [];
  } catch {
    return [];
  }
}

function safeIsWrite(tool: JudgeTool, input: unknown): boolean {
  if (typeof tool.isWriteOp !== 'function') {
    // 默认按工具类别推断：file 类按 'write_' 前缀启发；shell 类总是按写处理（cwd 检查）
    if (tool.policyActionKind === 'file' && tool.name) {
      return /write|edit|delete|append|create|mkdir|move|rename/i.test(tool.name);
    }
    if (tool.policyActionKind === 'shell') return true; // shell 默认按写
    return false;
  }
  try {
    return !!tool.isWriteOp(input);
  } catch {
    return false;
  }
}

function safeIsReadOnly(tool: JudgeTool, input: unknown, isWrite: boolean): boolean {
  if (typeof tool.isWriteOp === 'function') {
    return !isWrite;
  }
  if (tool.isReadOnly !== undefined) {
    return tool.isReadOnly;
  }
  return !safeIsWrite(tool, input);
}

function safeStringField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const v = (input as Record<string, unknown>)[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * 把 judge ctx 里的 agentMode（string | undefined）收窄为 AgentModeName。
 *
 * judge.ts 仍把 agentMode 当作 string 透传（避免 security-policy 引入
 * agent-modes 的复杂 enum 校验链）；step 0 调 SSoT 评估器前用本函数收窄。
 */
function coerceAgentMode(value: string | undefined): AgentModeName | undefined {
  if (value === undefined) return undefined;
  return isAgentModeName(value) ? value : undefined;
}
