/**
 * resolveSessionCodeRoot — 会话级代码执行根解析（「会话代码根」基础层）。
 *
 * 优先级：显式绑定（`useSessionBoundCodeRootStore`）且 status 可用（'active'）
 * → `spaceWorkingDir`（调用方传入，通常是 `resolveSpaceExecutionPath` 的结果）
 * → null（调用方可再走既有 sandbox fallback）。
 *
 * 与 `utils/resolveSpaceExecutionPath.ts` 的关系：那是 Space 维度的旧口径
 * （workspace 走 working_dir，非 workspace 走 active tab meta.path）；本模块是
 * session 维度的新口径，不读 Canvas/TabCode tab 的 active 态。`resolveSessionExecutionPath`
 * 薄封装两者：绑定根优先，否则原样复用 `resolveSpaceExecutionPath` 的行为，
 * 不改变其既有导出与语义。
 */

import { resolveRealPath } from '@/utils/canonicalPath'
import { resolveSpaceExecutionPath } from '@/utils/resolveSpaceExecutionPath'
import {
  useSessionBoundCodeRootStore,
  type BoundCodeRootBinding,
} from '@stores/useSessionBoundCodeRootStore'

export interface ResolveSessionCodeRootOptions {
  spaceWorkingDir?: string | null
  /** subagent 会话：自身无绑定时回退读取 parent 绑定 */
  parentSessionId?: string | null
}

function isBindingUsable(binding: BoundCodeRootBinding | null): binding is BoundCodeRootBinding {
  return Boolean(binding && binding.status === 'active' && binding.rootPath.trim())
}

/**
 * 只读取"是否存在可用绑定"，不与 `spaceWorkingDir` fallback 合并——供调用方需要
 * 区分"根来自显式绑定"还是"根来自 Space fallback"的场景（如发送路径把绑定根
 * 显式透传为 `boundCodeRoot`；无绑定时不传该字段，向前兼容）。
 */
export function resolveActiveSessionCodeRootBinding(
  sessionId: string | null | undefined,
  opts?: { parentSessionId?: string | null },
): BoundCodeRootBinding | null {
  const binding = useSessionBoundCodeRootStore.getState().getBinding(sessionId, {
    parentSessionId: opts?.parentSessionId,
  })
  return isBindingUsable(binding) ? binding : null
}

/**
 * 同步解析：只读内存态，不触碰磁盘/IPC。用于渲染期需要立即拿到路径的场景
 * （如展示态、发送前门禁）；需要真实物理路径（realpath）时改用
 * `resolveSessionExecutionPath`。
 */
export function resolveSessionCodeRoot(
  sessionId: string | null | undefined,
  opts?: ResolveSessionCodeRootOptions,
): string | null {
  const binding = useSessionBoundCodeRootStore.getState().getBinding(sessionId, {
    parentSessionId: opts?.parentSessionId,
  })
  if (isBindingUsable(binding)) {
    return binding.rootPath
  }
  const spaceWorkingDir = opts?.spaceWorkingDir
  if (typeof spaceWorkingDir === 'string' && spaceWorkingDir.trim()) {
    return spaceWorkingDir
  }
  return null
}

/**
 * 异步解析实际执行路径：绑定根存在时经 IPC realpath 收敛物理路径（symlink /
 * 大小写），否则原样复用 `resolveSpaceExecutionPath()`（workspace working_dir /
 * legacy tab fallback / sandbox）。
 */
export async function resolveSessionExecutionPath(
  sessionId: string | null | undefined,
  opts?: { parentSessionId?: string | null },
): Promise<string | null> {
  try {
    const binding = useSessionBoundCodeRootStore.getState().getBinding(sessionId, {
      parentSessionId: opts?.parentSessionId,
    })
    if (isBindingUsable(binding)) {
      const real = await resolveRealPath(binding.rootPath)
      return real || binding.rootPath
    }
  } catch {
    // fail-soft：绑定根解析异常，继续走既有 Space 执行根口径
  }
  return resolveSpaceExecutionPath()
}
