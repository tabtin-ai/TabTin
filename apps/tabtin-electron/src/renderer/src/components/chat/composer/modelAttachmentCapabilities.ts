/**
 * Composer / send 路径共用的模型附件能力解析。
 *
 * 模型能力只描述原生送模通道，不得限制 Agent 资源附件上传。
 */

import { presetToAcceptString } from '@/constants/upload'

/**
 * 文件选择器不受模型视觉、文档或压缩包能力影响。
 */
export function computeComposerAcceptTypes(): string {
  return presetToAcceptString('FILE')
}
