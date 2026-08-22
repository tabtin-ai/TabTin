import type {
  TableGridKeyboardEventLike,
  TableGridShortcutBinding,
  TableGridShortcutPhase,
  TableGridShortcutPlatform,
} from './types'

export const DEFAULT_TABLE_GRID_SHORTCUT_BINDINGS: ReadonlyArray<TableGridShortcutBinding> = [
  {
    id: 'select-all',
    key: 'a',
    modifiers: ['meta'],
    platform: 'mac',
    phase: 'gridFocused',
    preventDefault: true,
    description: 'Select all rows or cells',
  },
  {
    id: 'select-all',
    key: 'a',
    modifiers: ['ctrl'],
    platform: 'windows',
    phase: 'gridFocused',
    preventDefault: true,
    description: 'Select all rows or cells',
  },
  {
    id: 'select-all',
    key: 'a',
    modifiers: ['ctrl'],
    platform: 'linux',
    phase: 'gridFocused',
    preventDefault: true,
    description: 'Select all rows or cells',
  },
  {
    id: 'copy',
    key: 'c',
    modifiers: ['meta'],
    platform: 'mac',
    phase: 'gridFocused',
    description: 'Copy selected cells',
  },
  {
    id: 'copy',
    key: 'c',
    modifiers: ['ctrl'],
    platform: 'windows',
    phase: 'gridFocused',
    description: 'Copy selected cells',
  },
  {
    id: 'copy',
    key: 'c',
    modifiers: ['ctrl'],
    platform: 'linux',
    phase: 'gridFocused',
    description: 'Copy selected cells',
  },
  {
    id: 'cut',
    key: 'x',
    modifiers: ['meta'],
    platform: 'mac',
    phase: 'gridFocused',
    description: 'Cut selected cells',
  },
  {
    id: 'cut',
    key: 'x',
    modifiers: ['ctrl'],
    platform: 'windows',
    phase: 'gridFocused',
    description: 'Cut selected cells',
  },
  {
    id: 'cut',
    key: 'x',
    modifiers: ['ctrl'],
    platform: 'linux',
    phase: 'gridFocused',
    description: 'Cut selected cells',
  },
  {
    id: 'paste',
    key: 'v',
    modifiers: ['meta'],
    platform: 'mac',
    phase: 'gridFocused',
    description: 'Paste into selected cells',
  },
  {
    id: 'paste',
    key: 'v',
    modifiers: ['ctrl'],
    platform: 'windows',
    phase: 'gridFocused',
    description: 'Paste into selected cells',
  },
  {
    id: 'paste',
    key: 'v',
    modifiers: ['ctrl'],
    platform: 'linux',
    phase: 'gridFocused',
    description: 'Paste into selected cells',
  },
  {
    id: 'undo',
    key: 'z',
    modifiers: ['meta'],
    platform: 'mac',
    phase: 'gridFocused',
    preventDefault: true,
    description: 'Undo latest change',
  },
  {
    id: 'undo',
    key: 'z',
    modifiers: ['ctrl'],
    platform: 'windows',
    phase: 'gridFocused',
    preventDefault: true,
    description: 'Undo latest change',
  },
  {
    id: 'undo',
    key: 'z',
    modifiers: ['ctrl'],
    platform: 'linux',
    phase: 'gridFocused',
    preventDefault: true,
    description: 'Undo latest change',
  },
  {
    id: 'redo',
    key: 'z',
    modifiers: ['meta', 'shift'],
    platform: 'mac',
    phase: 'gridFocused',
    preventDefault: true,
    description: 'Redo latest change',
  },
  {
    id: 'redo',
    key: 'y',
    modifiers: ['ctrl'],
    platform: 'windows',
    phase: 'gridFocused',
    preventDefault: true,
    description: 'Redo latest change',
  },
  {
    id: 'redo',
    key: 'y',
    modifiers: ['ctrl'],
    platform: 'linux',
    phase: 'gridFocused',
    preventDefault: true,
    description: 'Redo latest change',
  },
  {
    id: 'redo',
    key: 'z',
    modifiers: ['ctrl', 'shift'],
    platform: 'windows',
    phase: 'gridFocused',
    preventDefault: true,
    description: 'Redo latest change',
  },
  {
    id: 'redo',
    key: 'z',
    modifiers: ['ctrl', 'shift'],
    platform: 'linux',
    phase: 'gridFocused',
    preventDefault: true,
    description: 'Redo latest change',
  },
]

interface NavigatorLike {
  platform?: string
  userAgent?: string
}

const normalizeKey = (key: string): string => key.trim().toLowerCase()

const hasModifier = (event: TableGridKeyboardEventLike, modifier: 'meta' | 'ctrl' | 'alt' | 'shift'): boolean => {
  switch (modifier) {
    case 'meta':
      return Boolean(event.metaKey)
    case 'ctrl':
      return Boolean(event.ctrlKey)
    case 'alt':
      return Boolean(event.altKey)
    case 'shift':
      return Boolean(event.shiftKey)
  }
}

const isModifierSetExact = (event: TableGridKeyboardEventLike, modifiers: ReadonlySet<string>): boolean => {
  const expectedMeta = modifiers.has('meta')
  const expectedCtrl = modifiers.has('ctrl')
  const expectedAlt = modifiers.has('alt')
  const expectedShift = modifiers.has('shift')

  return (
    Boolean(event.metaKey) === expectedMeta &&
    Boolean(event.ctrlKey) === expectedCtrl &&
    Boolean(event.altKey) === expectedAlt &&
    Boolean(event.shiftKey) === expectedShift
  )
}

const doesPlatformMatch = (
  bindingPlatform: TableGridShortcutPlatform | undefined,
  runtimePlatform: TableGridShortcutPlatform
): boolean => {
  if (!bindingPlatform || bindingPlatform === 'all') {
    return true
  }
  return bindingPlatform === runtimePlatform
}

const doesPhaseMatch = (
  bindingPhase: TableGridShortcutPhase | undefined,
  runtimePhase: TableGridShortcutPhase
): boolean => {
  if (!bindingPhase || bindingPhase === 'always') {
    return true
  }
  if (runtimePhase === 'always') {
    return true
  }
  return bindingPhase === runtimePhase
}

export const detectTableGridShortcutPlatform = (
  nav: NavigatorLike | null = typeof navigator !== 'undefined' ? navigator : null
): TableGridShortcutPlatform => {
  const platform = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`.toLowerCase()

  if (platform.includes('mac') || platform.includes('iphone') || platform.includes('ipad')) {
    return 'mac'
  }
  if (platform.includes('win')) {
    return 'windows'
  }
  return 'linux'
}

export interface MatchesTableGridShortcutOptions {
  platform?: TableGridShortcutPlatform
  phase?: TableGridShortcutPhase
}

export const matchesTableGridShortcut = (
  event: TableGridKeyboardEventLike,
  binding: TableGridShortcutBinding,
  options: MatchesTableGridShortcutOptions = {}
): boolean => {
  const runtimePlatform = options.platform ?? detectTableGridShortcutPlatform()
  const runtimePhase = options.phase ?? 'gridFocused'

  if (!doesPlatformMatch(binding.platform, runtimePlatform)) {
    return false
  }
  if (!doesPhaseMatch(binding.phase, runtimePhase)) {
    return false
  }

  if (normalizeKey(binding.key) !== normalizeKey(event.key)) {
    return false
  }

  const modifiers = new Set(binding.modifiers ?? [])
  if (!isModifierSetExact(event, modifiers)) {
    return false
  }

  if (modifiers.size === 0) {
    return true
  }

  return (
    hasModifier(event, 'meta') ||
    hasModifier(event, 'ctrl') ||
    hasModifier(event, 'alt') ||
    hasModifier(event, 'shift')
  )
}

export interface ResolveTableGridShortcutOptions extends MatchesTableGridShortcutOptions {
  defaultBindings?: ReadonlyArray<TableGridShortcutBinding>
}

export const resolveTableGridShortcut = (
  event: TableGridKeyboardEventLike,
  bindings: ReadonlyArray<TableGridShortcutBinding>,
  options: ResolveTableGridShortcutOptions = {}
): TableGridShortcutBinding | null => {
  const allBindings = [
    ...(options.defaultBindings ?? []),
    ...bindings,
  ]

  for (const binding of allBindings) {
    if (matchesTableGridShortcut(event, binding, options)) {
      return binding
    }
  }

  return null
}
