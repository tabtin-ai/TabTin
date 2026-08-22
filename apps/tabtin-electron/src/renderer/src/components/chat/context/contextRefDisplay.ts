/**
 * contextRefDisplay — 上下文引用卡片 / chip 的来源展示名推导。
 *
 * 关键约束（ 根因）：code_file / code_selection 的 `preview`
 * 存的是文件原文，可能含 HTML / Markdown 标记（如 README 开头的
 * `<div align="center">`）。它只能用于「展开后的内容预览」，绝不能拿来
 * 当卡片头部的来源标题——来源标题必须用 file_path 的文件名。
 */

/** 取路径最后一段作为文件名，兼容 `/` 与 `\` 分隔 */
export function refBasename(filePath: string): string {
  return filePath.split(/[/\\]/).filter(Boolean).pop() || filePath
}

/** getRefSourceLabel 读取的结构化子集，避免与 ContextRefCard 形成类型环依赖 */
export interface RefSourceFields {
  type?: string
  preview?: string
  file_path?: string
  start_line?: number
  end_line?: number
  plan_name?: string
}

/**
 * 推导引用卡片头部的来源标识。仅 code_file / code_selection 的 preview 是文件原文、
 * 必须改用 file_path 文件名；其余类型沿用 preview 首行（与历史行为一致）。
 */
export function getRefSourceLabel(block: RefSourceFields): string {
  const firstLine = (block.preview || '').split('\n')[0]
  switch (block.type) {
    case 'code_file':
      return block.file_path ? refBasename(block.file_path) : firstLine
    case 'code_selection': {
      if (!block.file_path) return firstLine
      const name = refBasename(block.file_path)
      return block.start_line && block.end_line
        ? `${name}:${block.start_line}-${block.end_line}`
        : name
    }
    case 'plan':
      // ：计划引用卡头部显示 plan 名（file 载体的 preview 也可能是路径，不用它）。
      return block.plan_name || (block.file_path ? refBasename(block.file_path) : firstLine)
    default:
      return firstLine
  }
}
