/**
 * 外部 Agent 历史导入——内嵌全屏页（对齐技能库 / 自动化 StandaloneModulePage 结构）。
 */
import React from 'react'
import { DownloadCloud } from 'lucide-react'
import { StandaloneModulePage } from '@components/context-space/StandaloneModulePage'
import { ExternalImportFlow } from './ExternalImportWizard'

export const ExternalImportPanel: React.FC = () => (
  <StandaloneModulePage
    icon={<DownloadCloud className="h-7 w-7 text-accent" strokeWidth={1.75} aria-hidden />}
    title="导入数据"
    description="把本机 Claude Code、Cursor、Codex、WorkBuddy 的项目目录和历史对话搬过来，在 TabTin 接着聊。"
    testId="external-import-panel"
  >
    <ExternalImportFlow />
  </StandaloneModulePage>
)
