import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  resolveAppIconPresentation,
  resolveAppIconUrl,
  SidebarTypeEmoji,
  TabTypeEmoji,
} from './sidebarTypeEmoji'

describe('app icon assets', () => {
  it('maps confirmed App concepts to the custom SVG family', () => {
    expect(resolveAppIconUrl('tabdoc')).toEqual(expect.any(String))
    expect(resolveAppIconUrl('table')).toBe(resolveAppIconUrl('tabdata'))
    expect(resolveAppIconUrl('desktop_home')).toEqual(expect.any(String))
    expect(resolveAppIconUrl('desktop-apps')).toEqual(expect.any(String))
    expect(resolveAppIconPresentation('tabdoc')).toBe('selfContained')
  })

  it('keeps directory entry and opened directory tab visually distinct', () => {
    expect(resolveAppIconUrl('folder', 'entry')).toBe(resolveAppIconUrl('tabfolder', 'entry'))
    expect(resolveAppIconUrl('tabfolder', 'entry')).not.toBe(resolveAppIconUrl('tabfolder', 'tab'))
  })

  it('maps IDE aliases to the approved TabCode icon', () => {
    expect(resolveAppIconUrl('tabcode')).toEqual(expect.any(String))
    expect(resolveAppIconUrl('code')).toBe(resolveAppIconUrl('tabcode'))
    expect(resolveAppIconUrl('IDE')).toBe(resolveAppIconUrl('tabcode'))
    expect(resolveAppIconPresentation('tabcode')).toBe('selfContained')
  })

  it('renders confirmed entry icons as images and keeps emoji fallback', () => {
    const confirmed = render(<SidebarTypeEmoji appIdOrType="tabdoc" />)
    expect(confirmed.container.querySelector('img')?.getAttribute('src')).toBe(resolveAppIconUrl('tabdoc'))
    confirmed.unmount()

    const tabcode = render(<SidebarTypeEmoji appIdOrType="tabcode" />)
    expect(tabcode.container.querySelector('img')?.getAttribute('src')).toBe(resolveAppIconUrl('tabcode'))
  })

  it('uses the opened-directory artwork in tab context', () => {
    const { container } = render(<TabTypeEmoji appIdOrType="tabfolder" />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(resolveAppIconUrl('tabfolder', 'tab'))
  })
})
