/**
 * ChatInput - 消息输入框组件
 *
 * 整合了：
 * - 文本输入
 * - 附件上传（按钮 + 粘贴 + 拖拽）
 * - 附件预览区
 * - @提及系统 + 上下文引用 chip
 * - 模型选择、任务模式切换
 * - 发送 / 停止按钮
 */

import React from 'react'
import { ChatInputChrome } from './ChatInputChrome'
import { useChatInputOrchestration } from './useChatInputOrchestration'
import type { ChatInputProps, ChatInputSendOptions } from './chatInputTypes'

export type { ChatInputSendOptions, ChatInputProps }

export const ChatInput: React.FC<ChatInputProps> = (props) => {
  const chromeProps = useChatInputOrchestration(props)
  return <ChatInputChrome {...chromeProps} />
}
