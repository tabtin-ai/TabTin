export {
  buildCommentAnchorFromBlockPos,
  buildCommentAnchorFromSelection,
  enrichCommentAnchorWithNodeId,
  buildReanchorPayload,
  clampSelectionToDoc,
  markAnchorDetachedStatus,
  resolveCommentAnchor,
} from './anchor'
export type {
  BuildCommentAnchorOptions,
  BuildCommentAnchorResult,
  CommentAnchorResolveStrategy,
  ResolveCommentAnchorOptions,
  ResolvedCommentAnchor,
} from './anchor'

export {
  createDefaultYjsCodec,
  createYjsCodecFromModule,
} from './yjs-codec'
export type { CommentYjsCodec, YProsemirrorModule } from './yjs-codec'

export {
  COMMENT_BLOCK_BADGE_CLASS,
  COMMENT_HIGHLIGHT_ACTIVE_CLASS,
  COMMENT_HIGHLIGHT_CLASS,
  commentDecorationsPluginKey,
  computeCommentDecorations,
  createCommentDecorationsExtension,
  getCommentDecorationAnchorStatuses,
  setActiveCommentThread,
  setCommentDecorationThreads,
} from './decorations'
export type {
  CommentDecorationThreadInput,
  CommentDecorationsMeta,
  CommentDecorationsOptions,
  CommentDecorationsPluginState,
} from './decorations'

export {
  findCommentThreadsAtEditorPos,
  findCommentThreadsAtPos,
  focusCommentAnchorInEditor,
} from './locate'
export type { FocusCommentAnchorInEditorResult } from './locate'

export {
  MAX_COMMENT_IMAGES,
  canSubmitCommentComposer,
  clearCommentComposerImages,
  collectImageFilesFromDataTransfer,
  isImageFile,
  markCommentComposerImage,
  mergeCommentComposerImages,
  readyAttachmentIds,
  removeCommentComposerImage,
} from './composer-images'

export {
  applyComposerMention,
  detectComposerMention,
  filterComposerMentionCandidates,
  mergeMentionUserIds,
} from './composer-mentions'
export type { CommentComposerMentionState } from './composer-mentions'
export type {
  CommentComposerImageDraft,
  CommentComposerImageStatus,
} from './composer-images'

export { CommentComposer } from './CommentComposer'
export type { CommentComposerLabels, CommentComposerProps } from './CommentComposer'

export { CommentThreadCard } from './CommentThreadCard'
export type {
  CommentAttachmentPreviewRequest,
  CommentThreadCardLabels,
  CommentThreadCardProps,
} from './CommentThreadCard'

export { CommentRail } from './CommentRail'
export type { CommentRailLabels, CommentRailProps } from './CommentRail'

export { useCommentRailController } from './useCommentRailController'
export type { CommentRailController } from './useCommentRailController'

export { DocumentCommentThreadsSection } from './DocumentCommentThreadsSection'
export type {
  DocumentCommentThreadsSectionLabels,
  DocumentCommentThreadsSectionProps,
} from './DocumentCommentThreadsSection'
