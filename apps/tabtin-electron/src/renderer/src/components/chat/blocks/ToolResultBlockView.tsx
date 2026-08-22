/**
 * ToolResultBlockView — tool_result 是对应 tool_use 卡片的数据输入。
 *
 * tool_use + tool_result 的用户心智是一件事："这个工具调用做了什么、结果怎样"。
 * `ToolUseBlockView` 已经按 tool_call_id 读取 result 内容并交给 ToolStepCard
 * 展示，所以这里不再渲染独立折叠面板。否则失败时会出现"终端执行卡片"和
 * "工具结果（失败）"两张卡显示同一份错误，造成  的重复信息。
 */

import React from 'react'
import { blockEntryEqual, type BlockRendererProps } from './types'

export const ToolResultBlockView: React.FC<BlockRendererProps> = React.memo(() => null, blockEntryEqual)
ToolResultBlockView.displayName = 'ToolResultBlockView'
