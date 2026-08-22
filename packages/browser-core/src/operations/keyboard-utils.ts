/**
 * keyboard-utils — CDP 键盘操作纯工具函数
 *
 * 从 CDPOperationHelper 提取的无状态工具函数：
 * - splitKeyCombo: 拆分组合键字符串 (e.g. "Cmd+A" → ["Cmd", "A"])
 * - normalizeModifier: 统一修饰键名称 (e.g. "cmd" → "Meta")
 * - buildKeyDescriptor: 键名到 CDP key descriptor 映射
 */

export interface KeyDescriptor {
  key: string
  code: string
  text?: string
  windowsVirtualKeyCode?: number
}

const NAMED_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter:     { code: 'Enter',      keyCode: 13,  text: '\r' },
  Tab:       { code: 'Tab',        keyCode: 9,   text: '\t' },
  Backspace: { code: 'Backspace',  keyCode: 8 },
  Delete:    { code: 'Delete',     keyCode: 46 },
  Escape:    { code: 'Escape',     keyCode: 27 },
  ArrowUp:   { code: 'ArrowUp',    keyCode: 38 },
  ArrowDown: { code: 'ArrowDown',  keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft',  keyCode: 37 },
  ArrowRight:{ code: 'ArrowRight', keyCode: 39 },
  Home:      { code: 'Home',       keyCode: 36 },
  End:       { code: 'End',        keyCode: 35 },
  PageUp:    { code: 'PageUp',     keyCode: 33 },
  PageDown:  { code: 'PageDown',   keyCode: 34 },
  Space:     { code: 'Space',      keyCode: 32,  text: ' ' },
  Alt:       { code: 'AltLeft',    keyCode: 18 },
  Control:   { code: 'ControlLeft',keyCode: 17 },
  Meta:      { code: 'MetaLeft',   keyCode: 91 },
  Shift:     { code: 'ShiftLeft',  keyCode: 16 },
}

const MODIFIER_MAP: Record<string, string> = {
  cmd: 'Meta', command: 'Meta', meta: 'Meta',
  ctrl: 'Control', control: 'Control',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
}

export function splitKeyCombo(key: string): string[] {
  if (key === '+') return ['+']
  const parts: string[] = []
  let buf = ''
  for (const ch of key) {
    if (ch === '+' && buf) {
      parts.push(buf)
      buf = ''
    } else {
      buf += ch
    }
  }
  if (buf) parts.push(buf)
  return parts
}

export function normalizeModifier(key: string): string {
  return MODIFIER_MAP[key.toLowerCase()] ?? key
}

export function buildKeyDescriptor(key: string): KeyDescriptor {
  const named = NAMED_KEYS[key]
  if (named) {
    return {
      key,
      code: named.code,
      text: named.text,
      windowsVirtualKeyCode: named.keyCode,
    }
  }

  if (key.length === 1) {
    const upper = key.toUpperCase()
    return {
      key,
      code: `Key${upper}`,
      text: key,
      windowsVirtualKeyCode: upper.charCodeAt(0),
    }
  }

  return { key, code: key }
}
