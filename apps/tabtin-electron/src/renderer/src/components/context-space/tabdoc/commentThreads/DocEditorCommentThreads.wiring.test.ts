/**
 * Task 4 接线回归：能力回退、入口、事件白名单、窄屏抽屉依赖。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMENT_RAIL_BREAKPOINT_PX, resolveCommentRailLayout } from '@tabtin/tabdoc-ui/api-client'
import {
  DOC_COMMENT_MESSAGE_EVENT,
  DOC_COMMENT_THREAD_EVENT,
  isDocCommentThreadRealtimeEvent,
} from './commentThreadEvents'

const root = process.cwd()
const docEditorViewSource = readFileSync(
  join(root, 'src/renderer/src/components/context-space/tabdoc/components/DocEditorView.tsx'),
  'utf8',
)
const eventStreamSource = readFileSync(
  join(root, 'src/renderer/src/components/context-space/tabdoc/adapters/electronTabDocEventStreamPort.ts'),
  'utf8',
)
const useDocEventStreamSource = readFileSync(
  join(root, 'src/renderer/src/hooks/useDocEventStream.ts'),
  'utf8',
)
const hostSource = readFileSync(
  join(root, 'src/renderer/src/components/context-space/tabdoc/commentThreads/DocumentCommentThreadsHost.tsx'),
  'utf8',
)

describe('DocEditor comment threads wiring ( Task 4)', () => {
  it('评论侧栏通过 aside 槽位参与 TabDoc 布局，不覆盖正文', () => {
    expect(docEditorViewSource).toContain('asideContent={')
    expect(docEditorViewSource).toContain('railContainer={commentRailContainer}')
    expect(hostSource).toContain('createPortal(rail, railContainer)')
    expect(hostSource).toContain('const isEmbeddedRail = railContainer !== undefined')
    expect(hostSource).toContain('(isEmbeddedRail ? null : rail)')
    expect(docEditorViewSource).toContain('h-full min-h-0 shrink-0 self-stretch')
  })

  it('能力检测后挂载线程宿主，legacy 回退旧底部评论', () => {
    expect(docEditorViewSource).toContain('DocumentCommentThreadsHost')
    expect(docEditorViewSource).toContain("commentCapabilityMode === 'legacy'")
    expect(docEditorViewSource).toContain('DocumentCommentsContainer')
    // 能力探测在 Host 内完成，DocEditorView 只消费 mode
    expect(docEditorViewSource.includes('hasCommentThreadsCapability')).toBe(false)
    expect(hostSource).toContain('hasCommentThreadsCapability')
    expect(hostSource).toContain("onCapabilityModeChangeRef.current?.('legacy')")
  })

  it('浮动工具条 / 区块菜单 / Mod+Alt+M 发起评论', () => {
    expect(docEditorViewSource).toContain('StartCommentButton')
    expect(docEditorViewSource).toContain('onCommentBlock')
    expect(docEditorViewSource).toContain('buildCommentAnchorFromSelection')
    expect(docEditorViewSource).toContain('buildCommentAnchorFromBlockPos')
    expect(docEditorViewSource).toContain("key === 'm'")
    expect(docEditorViewSource).toContain('startCommentFromSelection')
  })

  it('右栏与全文区分开创建，并解析附件短时预览', () => {
    expect(hostSource).toContain('handleCreateAnchoredThread')
    expect(hostSource).toContain('handleCreateDocumentThread')
    expect(hostSource).toContain('resolveDocumentThreadAttachmentPreviews')
    expect(hostSource).toContain('documentScopeOnly')
  })

  it('全文评论选择只更新底部选中态并收起右侧栏', () => {
    expect(hostSource).toContain('activeDocumentThreadId')
    expect(hostSource).toContain("if (thread.scope === 'document')")
    expect(hostSource).toContain('setActiveDocumentThreadId(thread.id)')
    expect(hostSource).toContain('onRailOpenChange(false)')
    expect(hostSource).toContain('activeThreadId={activeDocumentThreadId}')
  })

  it('挂载装饰扩展与双向定位入口', () => {
    expect(docEditorViewSource).toContain('createCommentDecorationsExtension')
    expect(docEditorViewSource).toContain('findCommentThreadsAtEditorPos')
    expect(hostSource).toContain('setCommentDecorationThreads')
    expect(hostSource).toContain('focusCommentAnchorInEditor')
  })

  it('事件白名单含 comment_thread / comment_message', () => {
    expect(eventStreamSource).toContain("'doc.events.comment_thread'")
    expect(eventStreamSource).toContain("'doc.events.comment_message'")
    expect(useDocEventStreamSource).toContain("'doc.events.comment_thread'")
    expect(useDocEventStreamSource).toContain("'doc.events.comment_message'")
    expect(isDocCommentThreadRealtimeEvent(DOC_COMMENT_THREAD_EVENT)).toBe(true)
    expect(isDocCommentThreadRealtimeEvent(DOC_COMMENT_MESSAGE_EVENT)).toBe(true)
  })

  it('私有附件上传走 presign → PUT → confirm', () => {
    expect(hostSource).toContain('uploadCommentAttachmentImage')
    expect(hostSource).toContain('onUploadImage')
    const uploadSource = readFileSync(
      join(root, 'src/renderer/src/components/context-space/tabdoc/commentThreads/commentAttachmentUpload.ts'),
      'utf8',
    )
    expect(uploadSource).toContain('presignCommentAttachmentUpload')
    expect(uploadSource).toContain('putPresignedObjectViaMainProcess')
    expect(uploadSource).toContain('confirmCommentAttachmentUpload')
    expect(uploadSource).toContain("validateUploadFile(file, 'IMAGE')")
    expect(uploadSource).toContain('isSignedCommentPreviewUrl')
  })

  it('窄屏抽屉布局断点与 CommentRail 一致', () => {
    expect(resolveCommentRailLayout(COMMENT_RAIL_BREAKPOINT_PX)).toBe('rail')
    expect(resolveCommentRailLayout(COMMENT_RAIL_BREAKPOINT_PX - 1)).toBe('drawer')
    expect(hostSource).toContain('viewportWidth')
    expect(hostSource).toContain('onCollapseOutlineChange')
    expect(docEditorViewSource).toContain('outlineCollapsed={outlineCollapsedForComments}')
  })
})
