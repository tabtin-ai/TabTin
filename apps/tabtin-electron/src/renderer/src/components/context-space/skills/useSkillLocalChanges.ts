/**
 * Skill 本地改动判定（ W3，产品口径：本地改过 ≠ 分叉副本，就地保留 + 「已修改」标记）。
 *
 * 为什么在客户端算：本地物料只存在于客户端文件系统，服务端 upgrade_skill 的
 * `has_local_changes` 拿「安装基线 hash vs 新版 hash」比（只要出了新版必不同 →
 * 恒真），没有能力知道用户是否真的改过本地文件。正确语义 = 「当前本地物料指纹
 * vs 安装基线 install_content_hash」，由主进程 `fs:computeSkillContentHash` 计算
 * 目录指纹后在这里对比。
 *
 * 三态：
 * - 'modified'：本地 hash ≠ 安装基线 → 真改过，升级需二选一（覆盖 / 存副本）
 * - 'clean'   ：本地 hash = 安装基线 → 未改过，升级可直接 accept_new
 * - 'unknown' ：算不出（无 path / IPC 不可用 / hash 失败）→ 不显示 badge，
 *               升级时不传 resolution 交给后端兜底（后端保守返回 conflict 再弹窗）
 */
import { useQuery } from '@tanstack/react-query'
import type { SkillIndexEntry } from '@/skills/types'
import { normalizeSkillSource } from '@/skills/types'
import { getSkillKey } from './skillPanelFilters'

export type SkillLocalChangeState = 'modified' | 'clean' | 'unknown'

/** 是否具备本地改动判定条件（user 来源 + 有安装基线 + 有本地目录）。 */
function isLocalChangeCandidate(skill: SkillIndexEntry): boolean {
  return normalizeSkillSource(skill.source) === 'user'
    && Boolean(skill.install_content_hash)
    && Boolean(skill.path)
}

/** 单个 skill 的本地改动三态判定（升级流用）。 */
export async function computeSkillLocalChangeState(
  skill: SkillIndexEntry,
): Promise<SkillLocalChangeState> {
  const hashFn = window.tabtin?.fileSystem?.computeSkillContentHash
  if (!hashFn || !isLocalChangeCandidate(skill)) return 'unknown'
  try {
    const result = await hashFn(skill.path!)
    if (!result?.success || !result.hash) return 'unknown'
    return result.hash === skill.install_content_hash ? 'clean' : 'modified'
  } catch {
    return 'unknown'
  }
}

/**
 * 批量判定列表内技能的「已修改」状态（badge 用）。
 *
 * 返回 canonical key → true 的 map（仅 'modified' 收录；clean / unknown 不进 map，
 * 消费侧 `map[key] === true` 即「确定改过」）。指纹计算走主进程 IPC，按
 * (key, path, 基线 hash) 组合缓存 30s，列表刷新不会重复 hash 未变化的目录。
 */
export function useSkillLocalChanges(
  skills: SkillIndexEntry[],
): Record<string, boolean> {
  const candidates = skills.filter(isLocalChangeCandidate)
  const fingerprint = candidates
    .map(s => `${getSkillKey(s)}|${s.path}|${s.install_content_hash}`)
    .sort()
    .join(';')

  const { data } = useQuery({
    queryKey: ['skills', 'local-changes', fingerprint] as const,
    queryFn: async (): Promise<Record<string, boolean>> => {
      const entries = await Promise.all(
        candidates.map(async skill => ({
          key: getSkillKey(skill),
          state: await computeSkillLocalChangeState(skill),
        })),
      )
      const map: Record<string, boolean> = {}
      for (const { key, state } of entries) {
        if (state === 'modified') map[key] = true
      }
      return map
    },
    enabled: candidates.length > 0,
    staleTime: 30_000,
  })

  return data ?? {}
}
