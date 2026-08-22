/**
 * Shell 路径转义工具
 *
 * 在将文件路径写入终端（PTY）前，必须转义 shell 特殊字符，
 * 否则空格、括号等会被 shell 误解析。
 *
 * 约定：对话 C 创建，对话 B 等其他对话可直接 import。
 */

const SHELL_SPECIAL_CHARS = /([ '"\\$!&(){}|<>?*#~`;[\]])/g

/** 转义路径中的 shell 特殊字符 */
export function shellEscapePath(path: string): string {
  return path.replace(SHELL_SPECIAL_CHARS, '\\$1')
}

/** 多路径转义并用空格连接 */
export function shellEscapePaths(paths: string[]): string {
  return paths.map(shellEscapePath).join(' ')
}
