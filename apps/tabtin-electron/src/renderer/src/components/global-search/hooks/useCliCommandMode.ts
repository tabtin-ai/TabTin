/**
 * useCliCommandMode — Wave 4 Cmd+K 命令面板 CLI 直敲模式
 *
 * charter v1.8 §4.1 例外条款 + Wave 4 Review H1 教训:
 * 命令面板必须有"CLI 直敲模式",不许只做"自然语言转对话"。
 *
 * 判断规则:第一个 token 在已知 CLI 命令字典里 → 命令模式;
 *           否则 → 自然语言搜索 + 自然语言模式(由 Agent 转 intent)。
 *
 * 当前期支持的命令(Wave 4):
 *   tracker new "<name>" [...]   → 打开 CreateTrackerDialog 预填
 *   tracker list                  → 切到 Tabtracker 模块的列表视图
 *   task new ... (alias)          → 同 tracker new
 *
 * 解析时只解析"足够触发表单预填"的程度,不需要完美等价 Wave 3 CLI——
 * UI 表单负责给用户最终确认,所以解析容错宽。
 */

import { useMemo } from 'react'

export type CliCommandKind =
  | { kind: 'tracker_new'; preset: 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly'; atTime: string; name: string }
  | { kind: 'tracker_list' }
  | { kind: 'unknown_command'; command: string; hint: string }

/** 已知 CLI 第一个 token 列表(命令模式判别用) */
export const KNOWN_CLI_FIRST_TOKENS = ['tracker', 'task', 'search', 'agent', 'app', 'space', 'skill', 'profile']

/**
 * 简易 shell-like split:
 * - 双引号 / 单引号包围的内容当作整体
 * - 其他按空白分
 * - 不支持转义(用户场景够用)
 */
export function splitArgs(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (cur) { out.push(cur); cur = '' }
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 检测输入是否为命令模式。
 * 命令模式判定:第一个 token 在 KNOWN_CLI_FIRST_TOKENS。
 */
export function isCliCommand(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed) return false
  // 第一个 token——简单 split
  const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase()
  return KNOWN_CLI_FIRST_TOKENS.includes(firstToken)
}

/**
 * 解析命令到 CliCommandKind。input 必须先通过 isCliCommand。
 */
export function parseCliCommand(input: string): CliCommandKind {
  const tokens = splitArgs(input.trim())
  const cmd = (tokens[0] ?? '').toLowerCase()
  const sub = (tokens[1] ?? '').toLowerCase()

  if ((cmd === 'tracker' || cmd === 'task') && sub === 'new') {
    // tracker new "<name>" [--schedule X] [--at HH:MM]
    type Preset = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly'
    const VALID_PRESETS: readonly Preset[] = ['manual', 'hourly', 'daily', 'weekdays', 'weekly']
    let name = tokens[2] ?? ''
    let preset: Preset = 'manual'
    let atTime = '09:00'

    // 解析 --schedule / --at
    for (let i = 2; i < tokens.length; i++) {
      const tk = tokens[i]
      if (tk === '--schedule' && tokens[i + 1]) {
        const candidate = tokens[i + 1].toLowerCase()
        if ((VALID_PRESETS as readonly string[]).includes(candidate)) {
          preset = candidate as Preset
        }
        i++
      } else if (tk === '--at' && tokens[i + 1]) {
        atTime = tokens[i + 1]
        i++
      } else if (tk.startsWith('--')) {
        // 忽略未知 flag(避免错误占位)
        if (tokens[i + 1] && !tokens[i + 1].startsWith('--')) i++
      } else if (i === 2 && !tk.startsWith('--')) {
        // 第一个非 flag 参数当 name(已上面赋值)
        name = tk
      }
    }

    return { kind: 'tracker_new', preset, atTime, name }
  }

  if ((cmd === 'tracker' || cmd === 'task') && sub === 'list') {
    return { kind: 'tracker_list' }
  }

  // 已知命令但不支持的子命令
  return {
    kind: 'unknown_command',
    command: input.trim(),
    hint: cmd === 'tracker' || cmd === 'task'
      ? '支持的子命令: new "<名称>" [--schedule manual|hourly|daily|weekdays|weekly] [--at HH:MM] / list'
      : `命令 "${cmd}" 暂不支持。`,
  }
}

/**
 * Hook:基于输入实时返回命令模式状态。
 */
export function useCliCommandMode(input: string): {
  isCommand: boolean
  parsed: CliCommandKind | null
} {
  return useMemo(() => {
    if (!isCliCommand(input)) {
      return { isCommand: false, parsed: null }
    }
    return { isCommand: true, parsed: parseCliCommand(input) }
  }, [input])
}
