/**
 * canonicalPath — 目录路径的归一化与物理真实路径解析
 *
 * 用途：判定「两个路径是不是同一个文件夹」。
 * - `normalizeComparableKey`：纯字符串归一化（统一分隔符、去尾部斜杠、Windows 大小写不敏感），
 *   用于渲染期同步比较（如绑定目录合并、去重预判），不触碰磁盘。
 * - `canonicalizePath`：先经主进程 `fs:realpath` 解析物理真实路径（收敛 symlink /
 *   junction / subst 盘符映射），再做字符串归一化。用于「添加目录」「绑定目录」等
 *   一次性用户动作的严格去重，避免不同写法指向同一物理目录被误判为不同。
 */

function isWindowsPlatform(): boolean {
  try {
    return window.tabtin?.getPlatform?.() === 'win32'
  } catch {
    return false
  }
}

/**
 * 纯字符串归一化，得到可比较 key。不解析 realpath、不访问磁盘。
 * 规则：反斜杠 → 正斜杠、去掉尾部斜杠、Windows 下小写。
 */
export function normalizeComparableKey(path: string | null | undefined): string {
  const trimmed = (path ?? '').trim()
  if (!trimmed) return ''
  const unified = trimmed.replace(/\\/g, '/').replace(/\/+$/, '')
  return isWindowsPlatform() ? unified.toLowerCase() : unified
}

/**
 * 解析物理真实路径，保留原生大小写与分隔符（不做归一化）。用于「绑定 working_dir」
 * 场景：把用户选中的路径收敛到真实物理路径再上报后端，让不同写法（symlink /
 * junction / 大小写）指向同一目录时命中后端唯一性约束。realpath 失败时回退原值。
 */
export async function resolveRealPath(path: string | null | undefined): Promise<string> {
  const trimmed = (path ?? '').trim()
  if (!trimmed) return ''
  try {
    const result = await window.tabtin?.fileSystem?.realpath?.(trimmed)
    if (result?.success && result.path) {
      return result.path
    }
  } catch {
    // 忽略——回退到原始路径
  }
  return trimmed
}

/**
 * 解析物理真实路径后归一化。realpath 失败（路径不存在等）时回退到字符串归一化，
 * 保证调用方总能拿到一个可比较 key。
 */
export async function canonicalizePath(path: string | null | undefined): Promise<string> {
  const trimmed = (path ?? '').trim()
  if (!trimmed) return ''
  try {
    const result = await window.tabtin?.fileSystem?.realpath?.(trimmed)
    if (result?.success && result.path) {
      return normalizeComparableKey(result.path)
    }
  } catch {
    // 忽略——回退到字符串归一化
  }
  return normalizeComparableKey(trimmed)
}
