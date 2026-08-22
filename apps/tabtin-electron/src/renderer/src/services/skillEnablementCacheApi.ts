/**
 * ：Renderer → main，失效 Agent Skill 启用快照（SkillEnablementMapCache）。
 *
 * 面板启用/停用/携带集变更写的是 Django；斜杠直链读的是主进程缓存。
 * 成功写入后主动 invalidate，避免 TTL 内假失败 not_enabled_for_agent。
 */
export async function invalidateSkillEnablementCache(agentId?: string): Promise<boolean> {
  const ipc = window.tabtin?.agentEngine
  if (!ipc?.invalidateSkillEnablementCache) return false
  try {
    const ack = await ipc.invalidateSkillEnablementCache(
      agentId ? { agentId } : undefined,
    )
    return ack?.success === true
  } catch {
    return false
  }
}
