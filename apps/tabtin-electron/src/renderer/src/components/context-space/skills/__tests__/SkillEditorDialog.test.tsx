/**
 * SkillEditorDialog（多文件编辑器）组件测试。
 *
 * 覆盖：解析 skill 目录 → 文件树渲染、增删文件/目录、SKILL.md 编辑/预览切换、
 * 保存时多文件收集 files[] 并发布。重组件（FileTree / Monaco CodeEditor / MarkdownViewer）
 * 用轻量 stub 替换，断言聚焦编排逻辑与 fs / publish 契约。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const publishMutateAsync = vi.hoisted(() => vi.fn().mockResolvedValue({ skill_id: 'skill-1' }))
const versionsRefetch = vi.hoisted(() => vi.fn().mockResolvedValue({ data: [] }))
const toastMock = vi.hoisted(() => {
  const fn = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  })
  return fn
})

vi.mock('@tabtin/smartsheet-ui', () => ({
  Dialog: ({ children, open }: any) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children }: any) => <div data-testid="dialog-content">{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  ScrollArea: ({ children }: any) => <div>{children}</div>,
  OverlayContainerProvider: ({ children }: any) => <>{children}</>,
  Button: ({ children, onClick, disabled, title }: any) => (
    <button onClick={onClick} disabled={disabled} title={title}>{children}</button>
  ),
  toast: toastMock,
}))

vi.mock('@components/ui', async (importOriginal) => {
  const actual = await importOriginal<any>().catch(() => ({}))
  return {
    ...actual,
    Dialog: ({ children, open }: any) => (open ? <div data-testid="dialog">{children}</div> : null),
    DialogContent: ({ children }: any) => <div data-testid="dialog-content">{children}</div>,
    DialogHeader: ({ children }: any) => <div>{children}</div>,
    DialogTitle: ({ children }: any) => <div>{children}</div>,
    DialogDescription: ({ children, asChild }: any) => (asChild ? children : <div>{children}</div>),
    DialogFooter: ({ children }: any) => <div>{children}</div>,
    ScrollArea: ({ children }: any) => <div>{children}</div>,
    OverlayContainerProvider: ({ children }: any) => <>{children}</>,
    Button: ({ children, onClick, disabled, title }: any) => (
      <button onClick={onClick} disabled={disabled} title={title}>{children}</button>
    ),
    toast: toastMock,
  }
})

vi.mock('@/hooks/queries/skills', () => ({
  usePublishSkillMutation: () => ({ mutateAsync: publishMutateAsync, isPending: false }),
  useSkillVersionsListQuery: () => ({ data: [], refetch: versionsRefetch }),
  useUpdateSkillQuickUseMutation: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  skillKeys: {
    all: ['skills'],
    content: (skillKey: string) => ['skills', 'content', skillKey],
    list: (spaceId: string) => ['skills', 'list', spaceId],
  },
}))

vi.mock('@components/shared/file-preview/CodeEditor', () => ({
  CodeEditor: ({ value, onChange, language, readOnly }: any) => (
    <textarea
      data-testid="code-editor"
      data-language={language}
      data-readonly={readOnly ? 'true' : 'false'}
      value={value}
      readOnly={!onChange}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}))

vi.mock('@components/shared/file-preview/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: any) => <div data-testid="markdown-viewer">{content}</div>,
}))

// FileTree stub：把回调暴露成可点的按钮，驱动 dialog 的增删 / 选中逻辑。
const fileTreeProps = vi.hoisted(() => ({ current: null as any }))
vi.mock('@components/context-space/folder/FileTree', () => ({
  FileTree: (props: any) => {
    fileTreeProps.current = props
    const entry = (name: string, rel: string, isDirectory = false) => ({
      name,
      path: `${props.rootPath}/${rel}`,
      isDirectory,
      size: 0,
      modifiedAt: null,
    })
    return (
      <div data-testid="file-tree">
        <div data-testid="file-tree-root">{props.rootPath}</div>
        <button data-testid="select-skillmd" onClick={() => props.onSelectFile(entry('SKILL.md', 'SKILL.md'))}>select-skillmd</button>
        <button data-testid="select-ref" onClick={() => props.onSelectFile(entry('style.md', 'references/style.md'))}>select-ref</button>
        <button data-testid="create-file" onClick={() => props.onCreateFile(props.rootPath, 'new.md')}>create-file</button>
        <button data-testid="create-dir" onClick={() => props.onCreateDirectory(props.rootPath, 'newdir')}>create-dir</button>
        <button data-testid="delete-ref" onClick={() => props.onDeleteFile(entry('style.md', 'references/style.md'))}>delete-ref</button>
        <button data-testid="delete-skillmd" onClick={() => props.onDeleteFile(entry('SKILL.md', 'SKILL.md'))}>delete-skillmd</button>
      </div>
    )
  },
}))

const SKILL_DIR = '/data/skills/demo'
const SKILL_MD_DISK = [
  '---',
  'name: demo',
  'description: "Demo skill"',
  'metadata:',
  '  version: 1.2.0',
  '  tabtin:',
  '    displayName: "Demo"',
  '---',
  '',
  '# Demo',
  '',
  'body',
  '',
].join('\n')
const SKILL_MD_CLEAN = [
  '---',
  'name: demo',
  'description: "Demo skill"',
  'metadata:',
  '  tabtin:',
  '    displayName: "Demo"',
  '---',
  '',
  '# Demo',
  '',
  'body',
  '',
].join('\n')
const STYLE_MD_DISK = '# Style guide\n\nuse short sentences.'

const skill = {
  skill_id: 'skill-1',
  skill_key: 'user:demo',
  name: 'demo',
  display_name: 'Demo',
  slug: 'demo',
  source: 'user',
  visibility: 'private',
  description: 'Demo skill',
  latest_version_label: '2.3.4',
} as any

function makeWindowTabtin() {
  const resolvePath = vi.fn().mockResolvedValue({
    skillDir: SKILL_DIR,
    mdPath: `${SKILL_DIR}/SKILL.md`,
    exists: true,
    mdExists: true,
  })
  const writeContent = vi.fn().mockResolvedValue({ mdPath: `${SKILL_DIR}/SKILL.md`, skillDir: SKILL_DIR })
  const readContent = vi.fn().mockResolvedValue({ content: SKILL_MD_DISK })

  const readFilePreview = vi.fn(async (path: string) => {
    if (path.endsWith('/SKILL.md')) {
      return { success: true, data: { kind: 'text', content: SKILL_MD_DISK } }
    }
    if (path.endsWith('/references/style.md')) {
      return { success: true, data: { kind: 'text', content: STYLE_MD_DISK } }
    }
    return { success: false }
  })
  const readDir = vi.fn(async (path: string) => {
    if (path === SKILL_DIR) {
      return {
        success: true,
        entries: [
          { name: 'SKILL.md', path: `${SKILL_DIR}/SKILL.md`, isDirectory: false },
          { name: 'references', path: `${SKILL_DIR}/references`, isDirectory: true },
        ],
      }
    }
    if (path === `${SKILL_DIR}/references`) {
      return {
        success: true,
        entries: [
          { name: 'style.md', path: `${SKILL_DIR}/references/style.md`, isDirectory: false },
        ],
      }
    }
    return { success: false }
  })
  const writeFile = vi.fn().mockResolvedValue({ success: true })
  const createDir = vi.fn().mockResolvedValue({ success: true })
  const deleteFile = vi.fn().mockResolvedValue({ success: true })
  const deleteDir = vi.fn().mockResolvedValue({ success: true })
  const rename = vi.fn().mockResolvedValue({ success: true })
  const pathExists = vi.fn(async (path: string) => {
    const known = new Set([
      SKILL_DIR,
      `${SKILL_DIR}/SKILL.md`,
      `${SKILL_DIR}/references`,
      `${SKILL_DIR}/references/style.md`,
    ])
    return { success: true, exists: known.has(path) }
  })

  return {
    skill: { resolvePath, writeContent, readContent },
    fileSystem: {
      readFilePreview, readDir, writeFile, createDir, deleteFile, deleteDir, rename, pathExists,
    },
  }
}

function renderDialog(overrides: {
  onOpenChange?: any
  onSaved?: any
  skill?: any
  readOnly?: boolean
  organizationId?: string | null
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const onOpenChange = overrides.onOpenChange ?? vi.fn()
  const onSaved = overrides.onSaved ?? vi.fn()
  const organizationId = overrides.organizationId === undefined ? 'wt-1' : overrides.organizationId
  return new Promise<{ onOpenChange: any; onSaved: any }>((resolve) => {
    import('../SkillEditorDialog').then(({ SkillEditorDialog }) => {
      render(
        <QueryClientProvider client={queryClient}>
          <SkillEditorDialog
            open
            onOpenChange={onOpenChange}
            skill={overrides.skill ?? skill}
            spaceId="space-1"
            organizationId={organizationId}
            readOnly={overrides.readOnly ?? false}
            onSaved={onSaved}
          />
        </QueryClientProvider>,
      )
      resolve({ onOpenChange, onSaved })
    })
  })
}

describe('SkillEditorDialog (multi-file editor)', () => {
  beforeEach(() => {
    publishMutateAsync.mockClear()
    versionsRefetch.mockReset()
    versionsRefetch.mockResolvedValue({ data: [] })
    toastMock.success.mockClear()
    toastMock.error.mockClear()
    toastMock.warning.mockClear()
    ;(window as any).tabtin = makeWindowTabtin()
  })

  afterEach(() => {
    delete (window as any).tabtin
    vi.restoreAllMocks()
  })

  it('resolves the skill dir, roots the file tree there, and auto-selects SKILL.md', async () => {
    await renderDialog()

    await waitFor(() => expect((window as any).tabtin.skill.resolvePath).toHaveBeenCalledWith({
      spaceId: 'space-1', organizationId: 'wt-1', skillKey: 'user:demo',
    }))
    await waitFor(() => expect(screen.getByTestId('file-tree-root').textContent).toBe(SKILL_DIR))
    // SKILL.md 自动选中 → Monaco 编辑器加载清理后的内容；展示 edit/preview 切换。
    await waitFor(() => expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe(SKILL_MD_CLEAN))
    expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).not.toContain('version:')
    expect(screen.getByText('skills.editor.edit')).toBeTruthy()
    expect(screen.getByText('skills.editor.preview')).toBeTruthy()
  })

  it('normalizes Windows backslash skillDir before passing rootPath to FileTree', async () => {
    const winDir = 'C:\\Users\\demo\\TabTin\\skills\\brainstorming-3'
    ;(window as any).tabtin.skill.resolvePath.mockResolvedValue({
      skillDir: winDir,
      mdPath: `${winDir}\\SKILL.md`,
      exists: true,
      mdExists: true,
    })
    ;(window as any).tabtin.fileSystem.readFilePreview.mockImplementation(async (path: string) => {
      if (path.replace(/\\/g, '/').endsWith('/SKILL.md')) {
        return { success: true, data: { kind: 'text', content: SKILL_MD_DISK } }
      }
      return { success: false }
    })

    await renderDialog()

    await waitFor(() => {
      expect(screen.getByTestId('file-tree-root').textContent).toBe(
        'C:/Users/demo/TabTin/skills/brainstorming-3',
      )
    })
  })

  it('creates files and folders through the file tree actions (fs:* IPC)', async () => {
    await renderDialog()
    await waitFor(() => expect(screen.getByTestId('file-tree-root')).toBeTruthy())

    fireEvent.click(screen.getByTestId('create-file'))
    await waitFor(() => expect((window as any).tabtin.fileSystem.writeFile)
      .toHaveBeenCalledWith(`${SKILL_DIR}/new.md`, ''))

    fireEvent.click(screen.getByTestId('create-dir'))
    await waitFor(() => expect((window as any).tabtin.fileSystem.createDir)
      .toHaveBeenCalledWith(`${SKILL_DIR}/newdir`))
  })

  it('deletes non-SKILL.md files but protects SKILL.md', async () => {
    await renderDialog()
    await waitFor(() => expect(screen.getByTestId('file-tree-root')).toBeTruthy())

    fireEvent.click(screen.getByTestId('delete-ref'))
    await waitFor(() => expect((window as any).tabtin.fileSystem.deleteFile)
      .toHaveBeenCalledWith(`${SKILL_DIR}/references/style.md`))

    // SKILL.md 是必备文件：删除被拦截，toast 报错且不调用 deleteFile。
    ;(window as any).tabtin.fileSystem.deleteFile.mockClear()
    fireEvent.click(screen.getByTestId('delete-skillmd'))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('skills.editorDialog.skillMdProtected'))
    expect((window as any).tabtin.fileSystem.deleteFile).not.toHaveBeenCalled()
  })

  it('hides the SKILL.md preview toggle when another file is selected', async () => {
    await renderDialog()
    await waitFor(() => expect(screen.getByText('skills.editor.edit')).toBeTruthy())

    fireEvent.click(screen.getByTestId('select-ref'))
    await waitFor(() => expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe(STYLE_MD_DISK))
    expect(screen.queryByText('skills.editor.preview')).toBeNull()
  })

  it('asks for a database version before publishing the collected bundle without rewriting SKILL.md version', async () => {
    const { onOpenChange, onSaved } = await renderDialog()
    await waitFor(() => expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe(SKILL_MD_CLEAN))

    const edited = `${SKILL_MD_CLEAN}\nedited line\n`
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: edited } })

    const saveBtn = screen.getByText('skills.editor.saveAndPublish').closest('button') as HTMLButtonElement
    await waitFor(() => expect(saveBtn.disabled).toBe(false))
    fireEvent.click(saveBtn)

    await waitFor(() => expect(screen.getByText('skills.versionPublish.title')).toBeTruthy())
    expect(publishMutateAsync).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('skills.versionPublish.bump.minor.title'))
    fireEvent.click(screen.getByText('skills.versionPublish.confirm'))

    // SKILL.md 走 skill:write-content（触发 registry rescan）。
    await waitFor(() => expect((window as any).tabtin.skill.writeContent).toHaveBeenCalledWith({
      spaceId: 'space-1', organizationId: 'wt-1', skillKey: 'user:demo', content: edited,
    }))

    await waitFor(() => expect(publishMutateAsync).toHaveBeenCalledTimes(1))
    const payload = publishMutateAsync.mock.calls[0][0]
    expect(payload).toMatchObject({
      skillId: 'skill-1',
      organization_id: 'wt-1',
      version_label: '2.4.0',
      visibility: 'private',
    })
    // 多文件收集：SKILL.md 用编辑后内容；references/style.md 从盘收进。
    const paths = payload.files.map((f: any) => f.path).sort()
    expect(paths).toEqual(['SKILL.md', 'references/style.md'].sort())
    const skillMdFile = payload.files.find((f: any) => f.path === 'SKILL.md')
    expect(skillMdFile.content).toBe(edited)
    expect(skillMdFile.content).not.toContain('version:')
    const styleFile = payload.files.find((f: any) => f.path === 'references/style.md')
    expect(styleFile.content).toBe(STYLE_MD_DISK)

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(toastMock.success).toHaveBeenCalledWith('skills.editor.saveSuccess')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('explains that SKILL.md name is required before opening the publish dialog', async () => {
    await renderDialog()
    await waitFor(() => expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe(SKILL_MD_CLEAN))

    const withoutName = SKILL_MD_CLEAN.replace('name: demo\n', '')
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: withoutName } })
    fireEvent.click(screen.getByText('skills.editor.saveAndPublish').closest('button') as HTMLButtonElement)

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('skills.editor.nameRequired'))
    expect(screen.queryByText('skills.versionPublish.title')).toBeNull()
    expect(publishMutateAsync).not.toHaveBeenCalled()
    expect((window as any).tabtin.skill.writeContent).not.toHaveBeenCalled()
  })

  it('uses the latest server version instead of a stale skill snapshot before publishing', async () => {
    versionsRefetch.mockResolvedValue({
      data: [
        { version_seq: 3, version_label: '0.0.3' },
        { version_seq: 2, version_label: '0.0.2' },
      ],
    })
    await renderDialog({ skill: { ...skill, latest_version_label: '0.0.2' } })
    await waitFor(() => expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe(SKILL_MD_CLEAN))
    fireEvent.change(screen.getByTestId('code-editor'), {
      target: { value: `${SKILL_MD_CLEAN}\nnew patch\n` },
    })

    fireEvent.click(screen.getByText('skills.editor.saveAndPublish').closest('button') as HTMLButtonElement)
    await waitFor(() => expect(versionsRefetch).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('skills.versionPublish.title')).toBeTruthy())

    expect((screen.getByLabelText('skills.versionPublish.part.patch') as HTMLInputElement).value).toBe('4')
    fireEvent.click(screen.getByText('skills.versionPublish.confirm'))

    await waitFor(() => expect(publishMutateAsync).toHaveBeenCalledTimes(1))
    expect(publishMutateAsync.mock.calls[0][0].version_label).toBe('0.0.4')
  })

  it('asks for confirmation again when the server version advances while the dialog is open', async () => {
    versionsRefetch
      .mockResolvedValueOnce({ data: [{ version_seq: 3, version_label: '0.0.3' }] })
      .mockResolvedValueOnce({ data: [{ version_seq: 4, version_label: '0.0.4' }] })
    await renderDialog({ skill: { ...skill, latest_version_label: '0.0.2' } })
    await waitFor(() => expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe(SKILL_MD_CLEAN))
    fireEvent.change(screen.getByTestId('code-editor'), {
      target: { value: `${SKILL_MD_CLEAN}\nconcurrent patch\n` },
    })

    fireEvent.click(screen.getByText('skills.editor.saveAndPublish').closest('button') as HTMLButtonElement)
    await waitFor(() => expect(screen.getByText('skills.versionPublish.title')).toBeTruthy())
    expect((screen.getByLabelText('skills.versionPublish.part.patch') as HTMLInputElement).value).toBe('4')

    fireEvent.click(screen.getByText('skills.versionPublish.confirm'))

    await waitFor(() => expect(versionsRefetch).toHaveBeenCalledTimes(2))
    expect(publishMutateAsync).not.toHaveBeenCalled()
    await waitFor(() => {
      expect((screen.getByLabelText('skills.versionPublish.part.patch') as HTMLInputElement).value).toBe('5')
    })
    expect(toastMock.error).toHaveBeenCalledWith('skills.versionPublish.versionChanged')
  })

  it('defaults the first publish version to 0.0.1 for all bump buttons', async () => {
    await renderDialog({ skill: { ...skill, latest_version_label: null } })
    await waitFor(() => expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe(SKILL_MD_CLEAN))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: `${SKILL_MD_CLEAN}\nfirst release\n` } })

    fireEvent.click(screen.getByText('skills.editor.saveAndPublish').closest('button') as HTMLButtonElement)
    await waitFor(() => expect(screen.getByText('skills.versionPublish.title')).toBeTruthy())

    const major = screen.getByLabelText('skills.versionPublish.part.major') as HTMLInputElement
    const minor = screen.getByLabelText('skills.versionPublish.part.minor') as HTMLInputElement
    const patch = screen.getByLabelText('skills.versionPublish.part.patch') as HTMLInputElement
    const expectInitial = () => {
      expect(major.value).toBe('0')
      expect(minor.value).toBe('0')
      expect(patch.value).toBe('1')
    }

    expectInitial()
    fireEvent.click(screen.getByText('skills.versionPublish.bump.major.title'))
    expectInitial()
    fireEvent.click(screen.getByText('skills.versionPublish.bump.minor.title'))
    expectInitial()
    fireEvent.click(screen.getByText('skills.versionPublish.bump.patch.title'))
    expectInitial()

    fireEvent.click(screen.getByText('skills.versionPublish.confirm'))
    await waitFor(() => expect(publishMutateAsync).toHaveBeenCalledTimes(1))
    expect(publishMutateAsync.mock.calls[0][0].version_label).toBe('0.0.1')
  })
})

// builtin / installed / team 来源用的「查看文件」只读模式。
const builtinSkill = {
  skill_id: 'table-operator',
  skill_key: 'app:tabdata/table-operator',
  name: 'table-operator',
  display_name: 'Table Operator',
  slug: 'table-operator',
  source: 'app',
  // registry 扫到的真实目录（doc_path 父目录）——resolve-path 对含 `/` 的 builtin slug 不可用，
  // 只读模式优先吃这个。
  path: SKILL_DIR,
  doc_path: `${SKILL_DIR}/SKILL.md`,
  description: 'Operate tables',
} as any

describe('SkillEditorDialog (read-only view mode)', () => {
  beforeEach(() => {
    publishMutateAsync.mockClear()
    toastMock.success.mockClear()
    toastMock.error.mockClear()
    ;(window as any).tabtin = makeWindowTabtin()
  })

  afterEach(() => {
    delete (window as any).tabtin
    vi.restoreAllMocks()
  })

  it('roots the tree at skill.path (builtin), shows read-only chrome, and never writes', async () => {
    await renderDialog({ skill: builtinSkill, readOnly: true })

    // 用 skill.path 作为目录（builtin 的 `app:foo/bar` slug 走不通 resolve-path）。
    await waitFor(() => expect(screen.getByTestId('file-tree-root').textContent).toBe(SKILL_DIR))
    // 标题直接是 skill 名字（无「查看 Skill 文件」说明式标题）；编辑标题不出现；只读 badge 在。
    expect(screen.getByText('Table Operator')).toBeTruthy()
    expect(screen.getByText('skills.editorDialog.readOnlyBadge')).toBeTruthy()
    expect(screen.queryByText('skills.editorDialog.title')).toBeNull()
    // 编辑器只读、无保存按钮。
    await waitFor(() => expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe(SKILL_MD_CLEAN))
    expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).not.toContain('version:')
    expect(screen.getByTestId('code-editor').getAttribute('data-readonly')).toBe('true')
    expect(screen.getByText('skills.editor.source')).toBeTruthy()
    expect(screen.queryByText('skills.editor.edit')).toBeNull()
    expect(screen.queryByText('skills.editor.save')).toBeNull()
    // 不写盘 / 不发布；resolve-path 因 skill.path 命中而未触发。
    expect((window as any).tabtin.skill.writeContent).not.toHaveBeenCalled()
    expect(publishMutateAsync).not.toHaveBeenCalled()
    expect((window as any).tabtin.skill.resolvePath).not.toHaveBeenCalled()
  })

  it('disables file-tree mutation entry points (no create/rename/delete/move) and new-item buttons', async () => {
    await renderDialog({ skill: builtinSkill, readOnly: true })
    await waitFor(() => expect(screen.getByTestId('file-tree')).toBeTruthy())

    // FileTree 不接收任何增删改 / 移动回调 → 自动只读。
    expect(fileTreeProps.current.onCreateFile).toBeUndefined()
    expect(fileTreeProps.current.onCreateDirectory).toBeUndefined()
    expect(fileTreeProps.current.onRenameFile).toBeUndefined()
    expect(fileTreeProps.current.onDeleteFile).toBeUndefined()
    expect(fileTreeProps.current.onMoveEntry).toBeUndefined()
    expect(fileTreeProps.current.onNewItemChange).toBeUndefined()
    // 顶部「新建文件 / 文件夹」按钮不渲染。
    expect(screen.queryByTitle('skills.editorDialog.newFile')).toBeNull()
    expect(screen.queryByTitle('skills.editorDialog.newFolder')).toBeNull()
  })

  it('falls back to single-file read-only view when no local dir resolves', async () => {
    // 未落盘的 team skill：skill.path 缺失 + resolve-path 命不中 → 单文件降级（读 SKILL.md 内容）。
    ;(window as any).tabtin.skill.resolvePath = vi.fn().mockResolvedValue({
      skillDir: '/data/skills/shared', mdPath: '/data/skills/shared/SKILL.md', exists: false, mdExists: false,
    })
    const teamSkill = {
      ...skill, skill_key: 'user:shared', path: undefined, doc_path: '/src/shared/SKILL.md',
    }

    await renderDialog({ skill: teamSkill, readOnly: true })

    // 降级为单文件只读：右侧只读展示 SKILL.md，左侧文件树整列隐藏（无空树栏、无提示文案），无保存。
    await waitFor(() => expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe(SKILL_MD_CLEAN))
    expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).not.toContain('version:')
    expect(screen.queryByTestId('file-tree')).toBeNull()
    expect(screen.getByTestId('code-editor').getAttribute('data-readonly')).toBe('true')
    expect(screen.queryByText('skills.editor.save')).toBeNull()
    expect((window as any).tabtin.skill.writeContent).not.toHaveBeenCalled()
  })
})
