/**
 * Composer 预设块 → prompt 文本 / skill 调用。
 * 实现已下沉到 `@tabtin/agent-host`；本文件仅 re-export。
 */

export {
  resolveComposerPresetPrompt,
  resolveComposerPresetSkillInvoke,
} from '@tabtin/agent-host/conversation'
