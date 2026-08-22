/**
 * ：协作远端同步的 `/` 不得新开本机 slash 菜单。
 *
 * 不导入 novel（会拉 react-tweet CSS）；用与 createSlashCommand 相同的
 * origin gate + @tiptap/suggestion + Collaboration 双 Editor 桥接复现。
 * createSlashCommand 接线契约见 slash-command.test.ts。
 *
 * 注意：@tiptap/suggestion@2.27 的 plugin view.update 是 async，
 * onStart 在 microtask 后触发，断言前需 flush。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Editor, Extension } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import StarterKit from '@tiptap/starter-kit'
import Suggestion from '@tiptap/suggestion'
import * as Y from 'yjs'

import {
  createSlashRemoteOriginGate,
  shouldAllowSlashSuggestion,
} from './slash-command-origin'

const REMOTE_ORIGIN = 'tabdoc-slash-test-remote'

async function flushSuggestionRender() {
  // suggestion view.update 内部 `await items(...)`，即使 items 同步也会落入 microtask
  await Promise.resolve()
  await Promise.resolve()
}

function createMenuTracker() {
  let active = false
  let startCount = 0
  let exitCount = 0

  return {
    get active() {
      return active
    },
    get startCount() {
      return startCount
    },
    get exitCount() {
      return exitCount
    },
    render: () => ({
      onStart: () => {
        active = true
        startCount += 1
      },
      onUpdate: () => {},
      onExit: () => {
        active = false
        exitCount += 1
      },
      onKeyDown: () => false,
    }),
  }
}

/** 镜像 createSlashCommand 的 origin gate + suggestion allow 接线。 */
function createOriginGatedSlashExtension(menu: ReturnType<typeof createMenuTracker>) {
  const { gate, plugin: remoteOriginPlugin } = createSlashRemoteOriginGate()

  return Extension.create({
    name: 'slash-command',
    addProseMirrorPlugins() {
      return [
        remoteOriginPlugin,
        Suggestion({
          editor: this.editor,
          char: '/',
          items: () => [{ title: 'Text' }],
          render: menu.render,
          allow: ({ isActive }) =>
            shouldAllowSlashSuggestion({
              isRemoteOrigin: gate.isRemoteOrigin,
              isActive,
            }),
          command: ({ editor, range, props }) => {
            props.command({ editor, range })
          },
        }),
      ]
    },
  })
}

function bridgeYDocs(a: Y.Doc, b: Y.Doc) {
  a.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN) return
    Y.applyUpdate(b, update, REMOTE_ORIGIN)
  })
  b.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN) return
    Y.applyUpdate(a, update, REMOTE_ORIGIN)
  })
}

function createCollabEditor(ydoc: Y.Doc, menu: ReturnType<typeof createMenuTracker>) {
  const element = document.createElement('div')
  document.body.appendChild(element)

  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ history: false }),
      Collaboration.configure({ document: ydoc }),
      createOriginGatedSlashExtension(menu),
    ],
  })

  return { editor, element }
}

const liveEditors: Editor[] = []
const liveElements: HTMLElement[] = []

afterEach(() => {
  while (liveEditors.length) {
    liveEditors.pop()?.destroy()
  }
  while (liveElements.length) {
    liveElements.pop()?.remove()
  }
  document.body.replaceChildren()
})

describe('shouldAllowSlashSuggestion', () => {
  it('远端事务在菜单未激活时禁止新开', () => {
    expect(shouldAllowSlashSuggestion({ isRemoteOrigin: true, isActive: false })).toBe(false)
  })

  it('本机事务允许打开或保持', () => {
    expect(shouldAllowSlashSuggestion({ isRemoteOrigin: false, isActive: false })).toBe(true)
    expect(shouldAllowSlashSuggestion({ isRemoteOrigin: false, isActive: true })).toBe(true)
  })

  it('远端事务在本机菜单已激活且仍匹配时不强制关闭', () => {
    expect(shouldAllowSlashSuggestion({ isRemoteOrigin: true, isActive: true })).toBe(true)
  })
})

describe('slash collaboration origin gate ', () => {
  it('A 本地输入 / 只开 A 的菜单；同步到 B 后 B 不弹菜单且不因同步新开', async () => {
    const ydocA = new Y.Doc()
    const ydocB = new Y.Doc()
    bridgeYDocs(ydocA, ydocB)

    const menuA = createMenuTracker()
    const menuB = createMenuTracker()
    const a = createCollabEditor(ydocA, menuA)
    const b = createCollabEditor(ydocB, menuB)
    liveEditors.push(a.editor, b.editor)
    liveElements.push(a.element, b.element)

    // 先让两端有可编辑段落，并把 B 光标放到文档末尾（同段共编场景）
    a.editor.chain().focus().insertContent({ type: 'paragraph' }).run()
    await flushSuggestionRender()
    b.editor.commands.focus('end')

    a.editor.chain().focus('end').insertContent('/').run()
    await flushSuggestionRender()

    expect(menuA.startCount).toBe(1)
    expect(menuA.active).toBe(true)
    expect(a.editor.getText()).toContain('/')

    // 远端同步后 B 正文有 `/`，但不得新开 slash 菜单
    expect(b.editor.getText()).toContain('/')
    await flushSuggestionRender()
    expect(menuB.startCount).toBe(0)
    expect(menuB.active).toBe(false)
  })

  it('A 菜单已开时，B 在别处协作编辑不会在 B 新开，也不会无故关闭 A 的菜单', async () => {
    const ydocA = new Y.Doc()
    const ydocB = new Y.Doc()
    bridgeYDocs(ydocA, ydocB)

    const menuA = createMenuTracker()
    const menuB = createMenuTracker()
    const a = createCollabEditor(ydocA, menuA)
    const b = createCollabEditor(ydocB, menuB)
    liveEditors.push(a.editor, b.editor)
    liveElements.push(a.element, b.element)

    a.editor.chain().focus().insertContent('/hea').run()
    await flushSuggestionRender()
    expect(menuA.active).toBe(true)
    expect(menuA.startCount).toBe(1)

    b.editor
      .chain()
      .focus('end')
      .insertContent({ type: 'paragraph', content: [{ type: 'text', text: 'remote note' }] })
      .run()
    await flushSuggestionRender()

    expect(b.editor.getText()).toContain('remote note')
    expect(menuB.startCount).toBe(0)
    expect(menuB.active).toBe(false)
    expect(menuA.active).toBe(true)
    expect(menuA.exitCount).toBe(0)
  })

  it('B 随后本机输入 / 仍能正常打开菜单', async () => {
    const ydocA = new Y.Doc()
    const ydocB = new Y.Doc()
    bridgeYDocs(ydocA, ydocB)

    const menuA = createMenuTracker()
    const menuB = createMenuTracker()
    const a = createCollabEditor(ydocA, menuA)
    const b = createCollabEditor(ydocB, menuB)
    liveEditors.push(a.editor, b.editor)
    liveElements.push(a.element, b.element)

    a.editor.chain().focus().insertContent('/').run()
    await flushSuggestionRender()
    expect(menuA.startCount).toBe(1)
    expect(menuB.startCount).toBe(0)

    b.editor
      .chain()
      .focus('end')
      .insertContent({ type: 'paragraph' })
      .insertContent('/')
      .run()
    await flushSuggestionRender()

    expect(menuB.startCount).toBe(1)
    expect(menuB.active).toBe(true)
  })
})
