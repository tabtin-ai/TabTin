import { describe, expect, it } from 'vitest'
import {
  dedupeMachineDiscoveredSkills,
  isWorkspaceScanSkill,
  mapWorkspaceScanToSkillIndexEntry,
  resolveWorkspaceSkillScanTargets,
  shouldScanWorkspaceSkills,
  WORKSPACE_SCAN_META_FLAG,
} from '../workspaceSkillScan'
import { getSkillDetailProductState } from '../skillProductState'
import type { SkillIndexEntry } from '@/skills/types'

describe('workspaceSkillScan', () => {
  const currentDevice = {
    id: 'device-me',
    fingerprint: 'fingerprint-me',
  }

  it('只在用户进入“我的”或具体工作区后扫描目录 Skill', () => {
    expect(shouldScanWorkspaceSkills({ sourceFilter: 'builtin', workspaceScopeId: null })).toBe(false)
    expect(shouldScanWorkspaceSkills({ sourceFilter: 'organization', workspaceScopeId: null })).toBe(false)
    expect(shouldScanWorkspaceSkills({ sourceFilter: 'all', workspaceScopeId: null })).toBe(false)
    expect(shouldScanWorkspaceSkills({ sourceFilter: 'mine', workspaceScopeId: null })).toBe(true)
    expect(shouldScanWorkspaceSkills({ sourceFilter: 'all', workspaceScopeId: 'workspace-1' })).toBe(true)
  })

  it('只扫描当前组织、本机、非伴生且有目录的 Workspace', () => {
    const targets = resolveWorkspaceSkillScanTargets(
      [
        {
          id: 'current-local',
          name: '默认 Workspace',
          organization_id: 'org-current',
          type: 'workspace',
          provisioning_source: 'user',
          control_device_id: 'device-me',
          working_dir: '/workspace/current',
        },
        {
          id: 'other-org',
          name: '默认 Workspace',
          organization_id: 'org-other',
          type: 'workspace',
          provisioning_source: 'user',
          control_device_id: 'device-me',
          working_dir: '/workspace/other-org',
        },
        {
          id: 'other-device',
          name: '远程 Workspace',
          organization_id: 'org-current',
          type: 'workspace',
          provisioning_source: 'user',
          control_device_id: 'device-other',
          working_dir: '/workspace/remote',
        },
        {
          id: 'project-companion',
          name: '项目内部 Workspace',
          organization_id: 'org-current',
          type: 'workspace',
          provisioning_source: 'system_project',
          is_companion: true,
          control_device_id: 'device-me',
          working_dir: '/workspace/project',
        },
        {
          id: 'without-root',
          name: '无目录 Workspace',
          organization_id: 'org-current',
          type: 'workspace',
          provisioning_source: 'user',
          control_device_id: 'device-me',
          working_dir: '  ',
        },
      ],
      'org-current',
      currentDevice,
      [{ id: 'device-other', fingerprint: 'fingerprint-other' }],
    )

    expect(targets).toEqual([
      {
        spaceId: 'current-local',
        spaceName: '默认 Workspace',
        workspaceRoot: '/workspace/current',
      },
    ])
  })

  it('保留当前组织内真实存在的同名本机 Workspace', () => {
    const targets = resolveWorkspaceSkillScanTargets(
      [
        {
          id: 'workspace-1',
          name: '默认 Workspace',
          organization_id: 'org-current',
          control_device_id: 'device-me',
          working_dir: '/workspace/one',
        },
        {
          id: 'workspace-2',
          name: '默认 Workspace',
          organization_id: 'org-current',
          control_device_id: 'device-me',
          working_dir: '/workspace/two',
        },
      ],
      'org-current',
      currentDevice,
    )

    expect(targets.map(target => target.spaceId)).toEqual(['workspace-1', 'workspace-2'])
  })

  it('设备记录 ID 漂移时通过相同指纹识别本机 Workspace', () => {
    const targets = resolveWorkspaceSkillScanTargets(
      [{
        id: 'workspace-1',
        name: '默认 Workspace',
        organization_id: 'org-current',
        control_device_id: 'backend-device-id',
        working_dir: '/workspace/one',
      }],
      'org-current',
      {
        id: 'local-fingerprint',
        fingerprint: 'same-machine',
      },
      [{
        id: 'backend-device-id',
        fingerprint: 'same-machine',
      }],
    )

    expect(targets.map(target => target.spaceId)).toEqual(['workspace-1'])
  })

  it('当前设备未就绪时不扫描任何 Workspace', () => {
    expect(resolveWorkspaceSkillScanTargets(
      [{
        id: 'workspace-1',
        name: '默认 Workspace',
        organization_id: 'org-current',
        control_device_id: null,
        working_dir: '/workspace/one',
      }],
      'org-current',
      null,
    )).toEqual([])
  })

  it('maps scan entry to SkillIndexEntry with workspace meta', () => {
    const skill = mapWorkspaceScanToSkillIndexEntry(
      {
        key: 'workspace:foo/bar',
        slug: 'bar',
        name: 'bar',
        display_name: 'Bar Skill',
        description: 'from workspace',
        emoji: '🧩',
        rel_path: '.cursor/skills/bar',
        doc_path: '/tmp/ws/.cursor/skills/bar/SKILL.md',
      },
      { spaceId: 'space-1', spaceName: '测试' },
    )

    expect(skill.skill_key).toBe('workspace:foo/bar')
    expect(skill.source).toBe('workspace')
    expect(skill.agent_enabled).toBe(false)
    expect(skill.display_name).toBe('Bar Skill')
    expect(skill.path).toBe('/tmp/ws/.cursor/skills/bar/SKILL.md')
    expect(isWorkspaceScanSkill(skill)).toBe(true)
    expect(skill.meta?.[WORKSPACE_SCAN_META_FLAG]).toBe(true)
    expect(skill.meta?.workspace_space_id).toBe('space-1')
    expect(skill.meta?.workspace_space_name).toBe('测试')
  })

  it('defaults agent_enabled to false until an Agent explicitly carries it', () => {
    const skill = mapWorkspaceScanToSkillIndexEntry(
      { key: 'workspace:a/b', slug: 'b', name: 'b' },
      { spaceId: 's1', spaceName: 'TabTin' },
    )
    expect(skill.agent_enabled).toBe(false)
  })

  it('同内容复制到不同本机目录时只展示一次，云端已有同内容时不再展示本机候选', () => {
    const first = mapWorkspaceScanToSkillIndexEntry(
      {
        key: 'workspace:first/demo',
        slug: 'demo',
        name: 'demo',
        doc_path: '/workspace/first/demo/SKILL.md',
        content_hash: 'a'.repeat(64),
      },
      { spaceId: 'space-1', spaceName: '一号工作区' },
    )
    const copied = mapWorkspaceScanToSkillIndexEntry(
      {
        key: 'workspace:copied/demo',
        slug: 'demo-copy',
        name: 'demo-copy',
        doc_path: '/workspace/copied/demo/SKILL.md',
        content_hash: 'a'.repeat(64),
      },
      { spaceId: 'space-2', spaceName: '二号工作区' },
    )

    expect(dedupeMachineDiscoveredSkills([first, copied], [])).toEqual([first])
    expect(dedupeMachineDiscoveredSkills([first], [{
      skill_id: 'cloud-demo',
      skill_key: 'platform:cloud-demo',
      name: 'cloud-demo',
      source: 'platform',
      install_content_hash: 'a'.repeat(64),
    }])).toEqual([])
  })

  it('同名但内容不同的本机 Skill 保留为两个候选', () => {
    const first = mapWorkspaceScanToSkillIndexEntry(
      {
        key: 'workspace:first/demo',
        slug: 'demo',
        name: 'demo',
        doc_path: '/workspace/first/demo/SKILL.md',
        content_hash: 'a'.repeat(64),
      },
      { spaceId: 'space-1', spaceName: '一号工作区' },
    )
    const fork = mapWorkspaceScanToSkillIndexEntry(
      {
        key: 'workspace:fork/demo',
        slug: 'demo',
        name: 'demo',
        doc_path: '/workspace/fork/demo/SKILL.md',
        content_hash: 'b'.repeat(64),
      },
      { spaceId: 'space-2', spaceName: '二号工作区' },
    )

    expect(dedupeMachineDiscoveredSkills([first, fork], [])).toEqual([first, fork])
    expect(dedupeMachineDiscoveredSkills([first], [{
      skill_id: 'cloud-demo',
      skill_key: 'platform:cloud-demo',
      slug: 'demo',
      name: 'demo',
      source: 'platform',
      install_content_hash: 'b'.repeat(64),
    }])).toEqual([first])
  })

  it('不同 Workspace 的相同相对路径不视为同一个 Skill', () => {
    const first = mapWorkspaceScanToSkillIndexEntry(
      {
        key: 'workspace:.agents/skills/demo',
        slug: 'demo',
        name: 'demo',
        doc_path: '/workspace/first/.agents/skills/demo/SKILL.md',
        content_hash: 'a'.repeat(64),
      },
      { spaceId: 'space-1', spaceName: '一号工作区' },
    )
    const fork = mapWorkspaceScanToSkillIndexEntry(
      {
        key: 'workspace:.agents/skills/demo',
        slug: 'demo',
        name: 'demo',
        doc_path: '/workspace/second/.agents/skills/demo/SKILL.md',
        content_hash: 'b'.repeat(64),
      },
      { spaceId: 'space-2', spaceName: '二号工作区' },
    )

    expect(dedupeMachineDiscoveredSkills([first, fork], [])).toEqual([first, fork])
  })

  it('依次复用来源地址、真实路径和 slug 兼容旧候选，但不合并强身份冲突项', () => {
    const local = (partial: Partial<SkillIndexEntry>): SkillIndexEntry => ({
      skill_id: 'local',
      skill_key: 'workspace:local',
      slug: 'demo',
      name: 'demo',
      source: 'workspace',
      ...partial,
    })
    const catalog = (partial: Partial<SkillIndexEntry>): SkillIndexEntry => ({
      skill_id: 'catalog',
      skill_key: 'platform:catalog',
      slug: 'demo',
      name: 'demo',
      source: 'platform',
      ...partial,
    })

    expect(dedupeMachineDiscoveredSkills([
      local({ skill_key: 'workspace:first', meta: { realpath: '/skills/demo/SKILL.md' } }),
      local({ skill_key: 'workspace:second', meta: { realpath: '/skills/demo/SKILL.md' } }),
    ], [])).toHaveLength(1)

    expect(dedupeMachineDiscoveredSkills([
      local({ import_source_url: 'https://example.com/skills/demo/' }),
    ], [
      catalog({ slug: 'renamed-demo', import_source_url: 'https://example.com/skills/demo' }),
    ])).toEqual([])

    expect(dedupeMachineDiscoveredSkills([
      local({ import_source_url: 'https://example.com/local/demo' }),
    ], [
      catalog({ import_source_url: 'https://example.com/cloud/demo' }),
    ])).toHaveLength(1)

    expect(dedupeMachineDiscoveredSkills([local({})], [catalog({})])).toEqual([])
  })

  it('hides make-team-visible for workspace scan skills', () => {
    const skill = mapWorkspaceScanToSkillIndexEntry(
      { key: 'workspace:a/b', slug: 'b', name: 'b' },
      { spaceId: 's1', spaceName: 'TabTin' },
    )
    const state = getSkillDetailProductState(skill, 'user-1', 'mine', false)
    expect(state.detailKind).toBe('device_local')
    expect(state.canShowMakeTeamVisible).toBe(false)
  })
})
