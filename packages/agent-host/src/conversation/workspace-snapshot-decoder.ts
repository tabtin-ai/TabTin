/**
 * L-W6-02 (W6 M3)：从 `agent.prompt.forward` envelope payload 解出
 * `WorkspaceSnapshot` 的纯函数。
 *
 * 抽到独立文件的目的：让 vitest 单测能 import 此函数验证形态容错 +
 * Daemon-parity 行为，**而无须**把整个 `ElectronAgentHost.ts` 拉起来
 * （后者顶层 import 会传递地把 NotificationService / electron-log
 * transports / cli-server 等一大堆 main-process side effect 拉进来，
 * 让"纯函数行为单测"被 mock 噪声淹没）。
 *
 * **与 `daemon.ts::decodeWorkspaceSnapshot` 必须严格对齐**：跨宿主行为
 * 分歧会让"同一条 wire payload 在 Electron forward 路径丢 snapshot、在
 * Daemon forward 路径生效"成为隐藏 bug（M3 三视角 review 第二轮发现）。
 *
 * 规则：
 * - 非 object / Array → `undefined`（让 host 走本地 tracker 兜底 / 不
 *   mutate session 工作区，与未传 `workspace_snapshot` 等价）
 * - 缺 `sources` / `allowedPaths` / `spaceSessionId` → `undefined`
 * - **`allowedFiles` 缺失 → 用 `[]` 兜底**（与 Daemon 一致 ——
 *   `daemon.ts:1707` 同款做法）
 * - `sources` 内字段缺失 → 用空数组 / 空字符串兜底，保证
 *   `WorkspaceSnapshot` shape 完整
 *
 * **M3.1 硬化补丁（过宽路径防护）**：在所有数组字段上调
 * `isDangerouslyBroadPath` 过滤，把 `/` `/Users` `/home` `/tmp` 等过宽
 * 字面量、以及非绝对路径、家目录本身（深度 ≤ 2 + `/Users`/`/home` 前缀）
 * 全部剔除。`sandbox` 字段过宽 → 清空（让上层兜底推导）。如果 allowedPaths
 * **过滤前非空、过滤后变空**（客户端整包都是畸形）→ 返回 `undefined`。
 *
 * **PD-12 fail-closed 的语义澄清（M3.1 review 第 2 轮第 3 项）**：
 * 这里返回 `undefined`，host 上游逻辑（`ElectronAgentHost.handleQueryInternal`
 * / `DaemonAgentHost.handleQueryInternal`）会**保持 session 当前已有的、
 * 上一轮已验证过的工作区不变**（与"未传 workspace_snapshot"等价），而**不是**
 * 把当前 session workspace 推平到 sandbox-only。如果 session 是首轮、之前
 * 没有合法 snapshot，host 走 `workspaceSnapshotV3 ?? sandbox 单条兜底`
 * 路径（`DaemonAgentHost.ts:3161`），此时确实退化为 sandbox-only。
 * 两条都满足 fail-closed：**永远不会让畸形 wire payload 扩大已有授予的工作区**。
 * **与"过滤前即为空"区分**：那是合法的"用户没在 TabCode 打开任何项目"，由 mutate
 * 层 "empty as omit" 防御处理。
 *
 * 不做 zod 强校验：wire 包不反向依赖 `@tabtin/security-policy` 类型层，
 * 跨包契约通过 type guard + `buildPolicyFromAgentConfigV2` 兜底（形态
 * 错误时 host 退化到"不 mutate 工作区"，与未传 `workspace_snapshot` 等价）。
 * 但运行时 `isDangerouslyBroadPath` helper 必须 import —— 这是 M3.1
 * 硬化的中央过滤器，避免每个 host 各写一份散落的过滤逻辑。
 *
 * **空数组防御按层分工（M3.1 后语义澄清）**：
 *   1. **本层（decode）**：过滤过宽路径；过滤前非空 + 过滤后空 → 返回
 *      `undefined`（畸形 payload 退化到 sandbox 兜底）
 *   2. **mutate 层（handleQueryInternal）**：过滤前已空（合法"无项目"）
 *      → 当作 omit，保留 session 现有工作区
 * 两层互补，不冲突。
 */
import { isDangerouslyBroadPath } from '@tabtin/security-policy'

function filterStrings(arr: unknown): string[] {
  if (!Array.isArray(arr)) return []
  return (arr as unknown[]).filter((p): p is string => typeof p === 'string')
}

function filterAndDropDangerous(arr: string[], onDrop: (p: string) => void): string[] {
  const out: string[] = []
  for (const p of arr) {
    if (isDangerouslyBroadPath(p)) {
      onDrop(p)
      continue
    }
    out.push(p)
  }
  return out
}

export function decodeForwardWorkspaceSnapshot(
  raw: unknown,
  logger: { warn(message: string): void } = console,
): import('@tabtin/security-policy').WorkspaceSnapshot | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const rawSources = obj.sources && typeof obj.sources === 'object' && !Array.isArray(obj.sources)
    ? obj.sources as Record<string, unknown>
    : null
  const rawAllowedPaths = Array.isArray(obj.allowedPaths)
    ? filterStrings(obj.allowedPaths)
    : null
  const spaceSessionId = typeof obj.spaceSessionId === 'string' ? obj.spaceSessionId : null

  if (!rawSources || !rawAllowedPaths || !spaceSessionId) {
    return undefined
  }

  // M3.1：在每个字段上过滤过宽路径；用单一 onDrop 收集警告，最后聚合 console.warn。
  // 样本上限 5 条（避免日志被对抗 payload 撑爆），但 totalDropped 计完整数（运维用
  // 来评估真实污染规模 —— review 第 2 轮第 4 项要求）。
  const droppedSamples: string[] = []
  let totalDropped = 0
  const onDrop = (p: string): void => {
    totalDropped += 1
    if (droppedSamples.length < 5) droppedSamples.push(p)
  }

  const rawSandbox = typeof rawSources.sandbox === 'string' ? rawSources.sandbox : ''
  const sandbox = isDangerouslyBroadPath(rawSandbox) ? '' : rawSandbox
  if (rawSandbox && isDangerouslyBroadPath(rawSandbox)) onDrop(rawSandbox)

  // 单根契约（见 docs/single-root-space-prd.md §2.2）：workingDir 是真相单源。
  const rawWorkingDir = typeof rawSources.workingDir === 'string' ? rawSources.workingDir : ''
  const workingDir = isDangerouslyBroadPath(rawWorkingDir) ? '' : rawWorkingDir
  if (rawWorkingDir && isDangerouslyBroadPath(rawWorkingDir)) onDrop(rawWorkingDir)

  // 单根契约 §2.4：ApprovalPanel 审批通过的路径（session 内有效）。
  const sessionApprovedPaths = filterAndDropDangerous(
    filterStrings(rawSources.sessionApprovedPaths),
    onDrop,
  )

  const attachedFiles = filterAndDropDangerous(
    filterStrings(rawSources.attachedFiles),
    onDrop,
  )
  // 与 Daemon 对齐：allowedFiles 缺失用 [] 兜底（M3 三视角 review 第二轮 P1 修复）。
  const rawAllowedFiles = Array.isArray(obj.allowedFiles)
    ? filterStrings(obj.allowedFiles)
    : []
  const allowedFiles = filterAndDropDangerous(rawAllowedFiles, onDrop)

  const allowedPaths = filterAndDropDangerous(rawAllowedPaths, onDrop)

  // M3.1 fail-closed：过滤前非空 + 过滤后空 → 整条退化为 undefined
  // 让 host 走 sandbox-only 兜底（PD-12 一致），避免"全是畸形 path"被悄悄
  // 当成"合法的空 workspace"。区分"过滤前已空"（合法）由调用方 mutate 层处理。
  //
  // 日志契约（M3.1.1）：跟 Daemon 端 `daemon.ts::decodeWorkspaceSnapshot` 严格对齐
  // —— 同一文案、同一字段顺序、同一 JSON 序列化方式。日志通道按宿主自然分工
  // （Electron 用 `console.warn`、Daemon 用 `this.logger.warn`），消息内容必须一致，
  // 这样运维 / 排障 grep 一条 message 既能命中 Electron 也能命中 Daemon。
  if (rawAllowedPaths.length > 0 && allowedPaths.length === 0) {
    if (totalDropped > 0) {
      try {
        logger.warn(
          '[workspace-snapshot-decode] M3.1 hardening: allowedPaths fully poisoned ' +
            'by dangerously broad paths; dropping snapshot. totalDropped=' +
            totalDropped +
            ' samples=' +
            JSON.stringify(droppedSamples),
        )
      } catch {
        /* logger 异常不应影响主路径 */
      }
    }
    return undefined
  }

  if (totalDropped > 0) {
    try {
      logger.warn(
        '[workspace-snapshot-decode] M3.1 hardening: filtered ' +
          totalDropped +
          ' dangerously broad path(s); samples=' +
          JSON.stringify(droppedSamples),
      )
    } catch {
      /* 同上 */
    }
  }

  return {
    sources: { sandbox, workingDir, sessionApprovedPaths, attachedFiles },
    allowedPaths,
    allowedFiles,
    spaceSessionId,
  }
}
