/**
 * desktop-key-safety — 键盘安全纯函数
 *
 * 提供键名映射、危险组合键检测、修饰键归一化等纯函数。
 * 所有函数仅依赖传入的 Key enum 和 process.platform，不依赖 class 实例。
 */

// ---------------------------------------------------------------------------
// Key name → nut-js Key enum mapping (lazy, built on first use)
// ---------------------------------------------------------------------------

let _keyMap: Record<string, number> | null = null

export function getKeyMap(Key: Record<string, number>): Record<string, number> {
  if (_keyMap) return _keyMap
  _keyMap = {
    // Modifiers
    cmd: Key.LeftCmd, command: Key.LeftCmd,
    ctrl: Key.LeftControl, control: Key.LeftControl,
    alt: Key.LeftAlt, option: Key.LeftAlt,
    shift: Key.LeftShift,
    fn: Key.Fn,
    meta: Key.LeftMeta, super: Key.LeftSuper, win: Key.LeftWin,

    // Navigation
    enter: Key.Enter, return: Key.Return,
    tab: Key.Tab,
    space: Key.Space,
    backspace: Key.Backspace,
    delete: Key.Delete,
    escape: Key.Escape, esc: Key.Escape,

    // Arrows
    up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right,

    // Page
    home: Key.Home, end: Key.End, pageup: Key.PageUp, pagedown: Key.PageDown,

    // Function keys
    f1: Key.F1, f2: Key.F2, f3: Key.F3, f4: Key.F4,
    f5: Key.F5, f6: Key.F6, f7: Key.F7, f8: Key.F8,
    f9: Key.F9, f10: Key.F10, f11: Key.F11, f12: Key.F12,

    // Symbols
    minus: Key.Minus, equal: Key.Equal,
    comma: Key.Comma, period: Key.Period,
    slash: Key.Slash, backslash: Key.Backslash,
    semicolon: Key.Semicolon, quote: Key.Quote,
    grave: Key.Grave,
    leftbracket: Key.LeftBracket, rightbracket: Key.RightBracket,

    // Numbers (main keyboard)
    '0': Key.Num0, '1': Key.Num1, '2': Key.Num2, '3': Key.Num3,
    '4': Key.Num4, '5': Key.Num5, '6': Key.Num6, '7': Key.Num7,
    '8': Key.Num8, '9': Key.Num9,

    // Letters
    a: Key.A, b: Key.B, c: Key.C, d: Key.D, e: Key.E,
    f: Key.F, g: Key.G, h: Key.H, i: Key.I, j: Key.J,
    k: Key.K, l: Key.L, m: Key.M, n: Key.N, o: Key.O,
    p: Key.P, q: Key.Q, r: Key.R, s: Key.S, t: Key.T,
    u: Key.U, v: Key.V, w: Key.W, x: Key.X, y: Key.Y, z: Key.Z,

    // Misc
    capslock: Key.CapsLock, numlock: Key.NumLock,
    scrolllock: Key.ScrollLock, pause: Key.Pause,
    insert: Key.Insert, print: Key.Print,
  }
  return _keyMap
}

export function resolveKey(name: string, Key: Record<string, number>): number {
  const map = getKeyMap(Key)
  let lower = name.toLowerCase()
  // Windows/Linux: cmd/command → ctrl (Agent says "cmd c" meaning "copy")
  if (process.platform !== 'darwin' && (lower === 'cmd' || lower === 'command')) {
    lower = 'ctrl'
  }
  const resolved = map[lower]
  if (resolved !== undefined) return resolved

  throw new Error(
    `按键名称无效："${name}" 不在可识别的键名列表中。` +
    `本次按键 / 快捷键未执行。` +
    `请改用以下任一键名（不区分大小写）：${Object.keys(map).join(', ')}。`,
  )
}

// ---------------------------------------------------------------------------
// Dangerous key combo detection
// ---------------------------------------------------------------------------

let _dangerousKeyCombos: ReadonlySet<string> | null = null

export function getDangerousKeyCombos(Key: Record<string, number>): ReadonlySet<string> {
  if (_dangerousKeyCombos) return _dangerousKeyCombos
  const combos = [
    [Key.LeftAlt, Key.F4],
    [Key.LeftCmd, Key.Q],
    [Key.LeftControl, Key.Q],
    [Key.LeftCmd, Key.Q, Key.LeftShift],
    [Key.LeftControl, Key.Q, Key.LeftShift],
    [Key.LeftCmd, Key.Escape, Key.LeftAlt],
    [Key.LeftAlt, Key.LeftControl, Key.Delete],
    [Key.LeftCmd, Key.W],
    [Key.LeftControl, Key.W],
  ]
  if (process.platform !== 'darwin') {
    for (const superKey of [Key.LeftSuper, Key.LeftWin, Key.LeftMeta].filter(k => k !== undefined)) {
      combos.push([superKey, Key.L])
    }
    combos.push([Key.LeftControl, Key.LeftAlt, Key.T])
  }
  _dangerousKeyCombos = new Set(combos.map(c => [...c].sort((a, b) => a - b).join(',')))
  return _dangerousKeyCombos
}

export function normalizeModifierKey(keyCode: number, Key: Record<string, number>): number {
  if (Key.RightCmd !== undefined && keyCode === Key.RightCmd) return Key.LeftCmd
  if (Key.RightControl !== undefined && keyCode === Key.RightControl) return Key.LeftControl
  if (Key.RightAlt !== undefined && keyCode === Key.RightAlt) return Key.LeftAlt
  if (Key.RightShift !== undefined && keyCode === Key.RightShift) return Key.LeftShift
  if (process.platform === 'darwin') {
    const metaLikeKeys = [Key.LeftMeta, Key.LeftSuper, Key.LeftWin, Key.RightMeta, Key.RightSuper, Key.RightWin]
    if (metaLikeKeys.some(k => k !== undefined && k === keyCode)) {
      return Key.LeftCmd
    }
  }
  return keyCode
}
