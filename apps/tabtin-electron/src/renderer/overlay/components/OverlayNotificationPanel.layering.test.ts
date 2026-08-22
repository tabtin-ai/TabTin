import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('OverlayNotificationPanel category menu contract', () => {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const panelSource = readFileSync(join(currentDir, 'OverlayNotificationPanel.tsx'), 'utf8')
  const itemSource = readFileSync(
    join(currentDir, '../../src/components/notification/NotificationCenterItem.tsx'),
    'utf8',
  )

  it('keeps the portalled category menu above the global notification layer', () => {
    expect(panelSource).toContain('fixed inset-0 z-global')
    expect(panelSource).toMatch(
      /<SelectContent[^>]*style=\{\{ zIndex: 'var\(--z-above-global\)' \}\}/,
    )
  })

  it('offers every product category even when the notification result is empty', () => {
    expect(panelSource).toContain('<SelectItem value="all">')
    expect(panelSource).toContain('<SelectItem value="automation">')
    expect(panelSource).toContain('<SelectItem value="collaboration">')
    expect(panelSource).toContain('<SelectItem value="organization">')
    expect(panelSource).toContain('<SelectItem value="account">')
    expect(panelSource).not.toContain('<SelectItem value="general">')
  })

  it('keeps the compact popover hierarchy aligned with the approved notification layout', () => {
    expect(panelSource).toContain('min-h-[58px]')
    expect(panelSource).toContain('h-[29px] min-w-12')
    expect(panelSource).toContain('h-[34px] w-28')
    expect(panelSource).toContain('flex flex-col gap-2 p-2')
    expect(panelSource).toContain('min-h-[220px]')
    expect(panelSource).not.toContain('text-title')

    expect(itemSource).toContain('grid-cols-[52px_minmax(0,1fr)]')
    expect(itemSource).toContain('min-h-[88px]')
    expect(itemSource).toContain("'h-7 w-[52px] rounded-lg text-caption'")
  })
})
