import { describe, expect, it } from 'vitest'

import {
  getProjectExecutionSpaceId,
  isProjectCompanionWorkspace,
  resolveCurrentMemberProjectCompanionWorkspace,
  resolveProjectExecutionWorkspace,
  resolveUserVisibleWorkspace,
} from './projectExecutionTarget'

describe('projectExecutionTarget', () => {
  it('resolves the internal Workspace linked to the Project', () => {
    const project = {
      id: 'project-1',
      type: 'team_space',
      organization_id: 'organization-1',
      execution_space_id: null,
      my_workspace: { id: 'workspace-1' },
    }
    const workspace = {
      id: 'workspace-1',
      type: 'workspace',
      organization_id: 'organization-1',
      project_id: 'project-1',
      control_device_id: 'device-local',
      execution_agent_id: 'agent-1',
    }
    const spaces = [project, workspace]

    expect(getProjectExecutionSpaceId(project, spaces)).toBe('workspace-1')
    expect(resolveProjectExecutionWorkspace(project, spaces)).toBe(workspace)
    expect(resolveCurrentMemberProjectCompanionWorkspace(project, spaces)).toBe(workspace)
  })

  it('identifies system-provisioned companions as hidden navigation internals', () => {
    expect(isProjectCompanionWorkspace({
      id: 'workspace-1',
      type: 'workspace',
      project_id: 'project-1',
      provisioning_source: 'system_project',
      is_companion: true,
    })).toBe(true)
    expect(isProjectCompanionWorkspace({
      id: 'workspace-2',
      type: 'workspace',
      project_id: null,
    })).toBe(false)
    expect(isProjectCompanionWorkspace({
      id: 'legacy-companion',
      type: 'workspace',
      project_id: null,
      is_companion: true,
    })).toBe(true)
  })

  it('keeps user-owned Workspaces visible after Project rebinding', () => {
    expect(isProjectCompanionWorkspace({
      id: 'user-rebound',
      type: 'workspace',
      project_id: 'project-1',
      provisioning_source: 'user',
      is_companion: false,
    })).toBe(false)
  })

  it('falls back from a restored companion to the default visible Workspace', () => {
    const companion = {
      id: 'project-workspace',
      type: 'workspace',
      organization_id: 'organization-1',
      project_id: 'project-1',
      provisioning_source: 'system_project' as const,
      is_companion: true,
    }
    const regular = {
      id: 'regular-workspace',
      type: 'workspace',
      organization_id: 'organization-1',
      provisioning_source: 'user' as const,
    }
    const defaultWorkspace = {
      id: 'default-workspace',
      type: 'workspace',
      organization_id: 'organization-1',
      is_default: true,
      provisioning_source: 'user' as const,
    }

    expect(resolveUserVisibleWorkspace(
      companion,
      [companion, regular, defaultWorkspace],
    )).toBe(defaultWorkspace)
  })

  it('does not use a legacy container binding as the current member Workspace', () => {
    const project = {
      id: 'project-1',
      type: 'team_space',
      execution_space_id: 'legacy-workspace',
    }
    const legacyWorkspace = {
      id: 'legacy-workspace',
      type: 'workspace',
      control_device_id: 'device-legacy',
    }

    expect(resolveCurrentMemberProjectCompanionWorkspace(project, [project, legacyWorkspace])).toBeNull()
  })

  it('uses the explicitly identified current member Workspace when historical data has multiple companions', () => {
    const project = {
      id: 'project-1',
      type: 'team_space',
      my_workspace: { id: 'workspace-current-member' },
    }
    const currentMemberWorkspace = {
      id: 'workspace-current-member',
      type: 'workspace',
      project_id: 'project-1',
    }
    const otherWorkspace = {
      id: 'workspace-other-member',
      type: 'workspace',
      project_id: 'project-1',
    }

    expect(resolveCurrentMemberProjectCompanionWorkspace(
      project,
      [project, otherWorkspace, currentMemberWorkspace],
    )).toBe(currentMemberWorkspace)
  })

  it('falls back to legacy execution_space_id when no Project Workspace is listed', () => {
    const project = {
      id: 'project-1',
      type: 'team_space',
      execution_space_id: 'legacy-workspace',
    }
    const legacyWorkspace = {
      id: 'legacy-workspace',
      type: 'workspace',
      control_device_id: 'device-legacy',
    }

    expect(resolveProjectExecutionWorkspace(project, [project, legacyWorkspace])).toBe(legacyWorkspace)
  })

  it('ignores archived Project Workspaces', () => {
    const project = { id: 'project-1', type: 'team_space', execution_space_id: null }
    const archivedWorkspace = {
      id: 'workspace-archived',
      type: 'workspace',
      project_id: 'project-1',
      is_archived: true,
    }

    expect(getProjectExecutionSpaceId(project, [project, archivedWorkspace])).toBeNull()
  })
})
