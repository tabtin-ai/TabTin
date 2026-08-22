import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SettingsSectionCard } from './SettingsSectionCard'
import { SETTINGS_CARD_TITLE } from './settingsUi'

describe('SettingsSectionCard', () => {
  it('卡片标题使用 CARD_TITLE，高于卡片内次要文案', () => {
    render(
      <SettingsSectionCard title="账户设置">
        <div>body</div>
      </SettingsSectionCard>,
    )

    const title = screen.getByRole('heading', { name: '账户设置' })
    for (const token of SETTINGS_CARD_TITLE.split(' ')) {
      expect(title.className).toContain(token)
    }
  })

  it('flat 模式标题同样使用 CARD_TITLE', () => {
    render(
      <SettingsSectionCard flat title="账户设置">
        <div>body</div>
      </SettingsSectionCard>,
    )

    const title = screen.getByRole('heading', { name: '账户设置' })
    for (const token of SETTINGS_CARD_TITLE.split(' ')) {
      expect(title.className).toContain(token)
    }
  })
})
