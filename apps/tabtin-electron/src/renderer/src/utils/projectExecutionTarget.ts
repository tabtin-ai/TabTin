export type WorkspaceProvisioningSource =
  | 'user'
  | 'system_project'
  | 'system_task'
  | string

export type ProjectExecutionTargetLike = {
  id?: string | null
  type?: string | null
  organization_id?: string | null
  project_id?: string | null
  /** ：系统供给来源；优先于 is_companion / project_id */
  provisioning_source?: WorkspaceProvisioningSource | null
  is_companion?: boolean | null
  execution_space_id?: string | null
  execution_agent_id?: string | null
  agent_id?: string | null
  control_device_id?: string | null
  bound_device_id?: string | null
  is_archived?: boolean | null
  is_default?: boolean | null
}

const SYSTEM_PROVISIONING_SOURCES = new Set(['system_project', 'system_task'])

/**
 * 系统自动供给的内部伴生 Workspace，不进入普通 Workspace 导航。
 *
 * ：只认供给来源（provisioning_source / is_companion），不能用
 * project_id 推断——用户主动创建后改绑到 Project/Task 的 Workspace 仍应展示。
 */
export function isProjectCompanionWorkspace(
  space: ProjectExecutionTargetLike | null | undefined,
): boolean {
  if (!space) return false
  if (
    typeof space.provisioning_source === 'string'
    && SYSTEM_PROVISIONING_SOURCES.has(space.provisioning_source)
  ) {
    return true
  }
  return space.is_companion === true
}

/** 普通工作台若恢复到内部伴生现场，回退到同组织的可见个人 Workspace。 */
export function resolveUserVisibleWorkspace<TSpace extends ProjectExecutionTargetLike>(
  activeWorkspace: TSpace | null | undefined,
  spaces: TSpace[],
): TSpace | null {
  if (!activeWorkspace) return null
  if (!isProjectCompanionWorkspace(activeWorkspace)) return activeWorkspace

  const candidates = spaces.filter(space => (
    space.type !== 'team_space'
    && !space.is_archived
    && !isProjectCompanionWorkspace(space)
    && (!activeWorkspace.organization_id || space.organization_id === activeWorkspace.organization_id)
  ))
  return candidates.find(space => space.is_default) ?? candidates[0] ?? null
}

/**
 * 只按 Project API 的 `my_workspace` 解析当前成员的伴生 Workspace。
 *
 * `execution_space_id` 是 Project 容器的历史兼容字段，不能用于成员私有的展示或操作。
 * 调用方没有拿到 `my_workspace` 时必须保守地视为执行现场不可用。
 */
export function resolveCurrentMemberProjectCompanionWorkspace<TSpace extends ProjectExecutionTargetLike>(
  project: (TSpace & { my_workspace?: { id?: string | null } | null }) | null | undefined,
  spaces: TSpace[],
): TSpace | null {
  if (!project || project.type !== 'team_space') return null

  const companionWorkspaceId = project.my_workspace?.id
  if (!companionWorkspaceId) return null

  return spaces.find(space => (
    space.id === companionWorkspaceId
    && space.type === 'workspace'
    && space.project_id === project.id
    && !space.is_archived
  )) ?? null
}

/**
 * 解析实际派发的执行 Workspace；保留 `execution_space_id` 仅兼容旧发送链路。
 * 成员私有展示请使用 resolveCurrentMemberProjectCompanionWorkspace。
 */
export function resolveProjectExecutionWorkspace<TSpace extends ProjectExecutionTargetLike>(
  project: TSpace | null | undefined,
  spaces: TSpace[],
): TSpace | null {
  if (!project) return null
  if (project.type !== 'team_space') return project

  const projectWorkspace = spaces.find(space => (
    space.type === 'workspace'
    && space.project_id === project.id
    && !space.is_archived
  ))
  if (projectWorkspace) return projectWorkspace

  const legacyExecutionSpaceId = project.execution_space_id
  return legacyExecutionSpaceId
    ? spaces.find(space => space.id === legacyExecutionSpaceId && space.type !== 'team_space') ?? null
    : null
}

export function getProjectExecutionSpaceId<TSpace extends ProjectExecutionTargetLike>(
  project: TSpace | null | undefined,
  spaces: TSpace[],
): string | null {
  return resolveProjectExecutionWorkspace(project, spaces)?.id ?? null
}
