/**
 * SkillMdEditor 详情页入口按钮测试。
 *
 * 验证「同一处入口、动作随来源切换」：可编辑来源（owner + user + Mine tab）显示「编辑」并打开
 * 可写模态；其它来源（builtin / 非 owner 的 team / 浏览态）显示「查看文件」并打开只读模态。
 * 重组件（SkillEditorDialog / MarkdownViewer / content query）用轻量 stub，断言聚焦入口编排。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

const editorDialogProps = vi.hoisted(() => ({ current: null as any }))
const skillContentQueryArgs = vi.hoisted(() => ({
  current: null as [string | null, Record<string, unknown>] | null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  ScrollArea: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@components/settings/settingsUi', () => ({ SETTINGS_GROUP_LABEL: '' }))

vi.mock('@/hooks/queries/skills', () => ({
  useSkillContentQuery: (...args: [string | null, Record<string, unknown>]) => {
    skillContentQueryArgs.current = args
    return {
      data: '---\nname: demo\ndescription: "d"\n---\n\n# Demo\n\nbody text',
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }
  },
}))

vi.mock('@components/shared/file-preview/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: any) => <div data-testid="md">{content}</div>,
}))

vi.mock('../SkillEditorDialog', () => ({
  SkillEditorDialog: (props: any) => {
    editorDialogProps.current = props
    return props.open
      ? <div data-testid="editor-dialog" data-readonly={String(props.readOnly)} />
      : null
  },
}))

import { SkillMdEditor } from '../SkillMdEditor'

const baseSkill = {
  skill_id: 's1',
  skill_key: 'user:demo',
  name: 'demo',
  display_name: 'Demo',
  slug: 'demo',
  source: 'user',
  owner_user_id: 'u1',
  description: 'd',
} as any

function renderEditor(
  skill: any,
  opts: {
    allowOwnerEdit?: boolean
    currentUserId?: string
    organizationId?: string | null
    editableOverride?: boolean
  } = {},
) {
  render(
    <SkillMdEditor
      skill={skill}
      spaceId="sp-1"
      organizationId={opts.organizationId === undefined ? 'wt-1' : opts.organizationId}
      currentUserId={opts.currentUserId ?? 'u1'}
      allowOwnerEdit={opts.allowOwnerEdit ?? true}
      editableOverride={opts.editableOverride}
    />,
  )
}

describe('SkillMdEditor entry button', () => {
  beforeEach(() => {
    editorDialogProps.current = null
    skillContentQueryArgs.current = null
  })

  it('owner user skill in Mine tab → "Edit" opens a writable dialog', () => {
    renderEditor(baseSkill, { allowOwnerEdit: true, currentUserId: 'u1' })

    expect(screen.getByText('skills.editor.edit')).toBeTruthy()
    expect(screen.queryByText('skills.editor.viewFiles')).toBeNull()

    fireEvent.click(screen.getByText('skills.editor.edit'))
    expect(screen.getByTestId('editor-dialog').getAttribute('data-readonly')).toBe('false')
  })

  it('owner id 大小写不一致时，Mine 仍判定可编辑（避免误降级为只读）', () => {
    const mixedCaseOwner = { ...baseSkill, owner_user_id: 'U1', has_published: true }
    renderEditor(mixedCaseOwner, { allowOwnerEdit: true, currentUserId: 'u1' })

    expect(screen.getByText('skills.editor.edit')).toBeTruthy()
    fireEvent.click(screen.getByText('skills.editor.edit'))
    expect(screen.getByTestId('editor-dialog').getAttribute('data-readonly')).toBe('false')
  })

  it('uses detail-pane editability so Mine tab does not reopen writable skills as read-only', () => {
    renderEditor(baseSkill, { allowOwnerEdit: true, currentUserId: '', editableOverride: true })

    expect(screen.getByText('skills.editor.edit')).toBeTruthy()
    fireEvent.click(screen.getByText('skills.editor.edit'))
    expect(screen.getByTestId('editor-dialog').getAttribute('data-readonly')).toBe('false')
  })

  it('builtin source → "View files" opens a read-only dialog', () => {
    const builtin = { ...baseSkill, skill_key: 'app:tabdata/table-operator', source: 'app', owner_user_id: null }
    renderEditor(builtin, { allowOwnerEdit: true, currentUserId: 'u1' })

    expect(screen.getByText('skills.editor.viewFiles')).toBeTruthy()
    expect(screen.queryByText('skills.editor.edit')).toBeNull()

    fireEvent.click(screen.getByText('skills.editor.viewFiles'))
    expect(screen.getByTestId('editor-dialog').getAttribute('data-readonly')).toBe('true')
  })

  it('未获取的市场包详情优先读取后端发布包，而不是空的本机目录', () => {
    const marketplace = {
      ...baseSkill,
      skill_id: 'code-safety-audit',
      skill_key: 'app:tabtin-dev-toolkit-pack/code-safety-audit',
      source: 'app',
      distribution: 'marketplace',
      owner_user_id: null,
      installed_on_device: false,
    }

    renderEditor(marketplace)

    expect(skillContentQueryArgs.current).toEqual([
      marketplace.skill_key,
      expect.objectContaining({ publishedSnapshotSkillId: marketplace.skill_id }),
    ])
  })

  it('user skill owned by someone else (team) → "View files" (read-only)', () => {
    const teamSkill = { ...baseSkill, skill_key: 'user:shared', owner_user_id: 'other-user' }
    renderEditor(teamSkill, { allowOwnerEdit: true, currentUserId: 'u1' })

    expect(screen.getByText('skills.editor.viewFiles')).toBeTruthy()
    fireEvent.click(screen.getByText('skills.editor.viewFiles'))
    expect(screen.getByTestId('editor-dialog').getAttribute('data-readonly')).toBe('true')
  })

  it('owner user skill but browse-only tab (allowOwnerEdit=false) → "View files" (read-only)', () => {
    renderEditor(baseSkill, { allowOwnerEdit: false, currentUserId: 'u1' })

    expect(screen.getByText('skills.editor.viewFiles')).toBeTruthy()
    expect(screen.queryByText('skills.editor.edit')).toBeNull()
    fireEvent.click(screen.getByText('skills.editor.viewFiles'))
    expect(screen.getByTestId('editor-dialog').getAttribute('data-readonly')).toBe('true')
  })
})
