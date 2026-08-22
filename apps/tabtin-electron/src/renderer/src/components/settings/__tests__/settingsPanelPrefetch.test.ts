import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsSidebarItem } from '../settingsNavigation'
import {
  prefetchSettingsPanel,
  resetSettingsPanelPrefetchForTests,
} from '../settingsPanelPrefetch'

vi.mock('../panels/UserProfilePanel', () => ({
  UserProfilePanel: () => null,
}))

vi.mock('../panels/AccountDevicesPanel', () => ({
  AccountDevicesPanel: () => null,
}))

vi.mock('../panels/SettingsGroupComposites', () => ({
  CredentialsComposite: () => null,
}))

vi.mock('../panels/CredentialsAiPanel', () => ({
  CredentialsAiPanel: () => null,
}))

const accountItem: SettingsSidebarItem = {
  category: 'profile',
  section: 'account',
  icon: (() => null) as SettingsSidebarItem['icon'],
  labelKey: 'sections.accountGroup',
}

const credentialsItem: SettingsSidebarItem = {
  category: 'profile',
  section: 'credentials',
  icon: (() => null) as SettingsSidebarItem['icon'],
  labelKey: 'sections.credentialsGroup',
}

const devicesItem: SettingsSidebarItem = {
  category: 'profile',
  section: 'devices',
  icon: (() => null) as SettingsSidebarItem['icon'],
  labelKey: 'sections.accountDevices',
}

describe('prefetchSettingsPanel', () => {
  beforeEach(() => {
    resetSettingsPanelPrefetchForTests()
  })

  it('loads account panel chunk once per sidebar item key', async () => {
    prefetchSettingsPanel(accountItem)
    prefetchSettingsPanel(accountItem)

    await vi.waitFor(async () => {
      await import('../panels/UserProfilePanel')
    })

    const firstLoad = await import('../panels/UserProfilePanel')
    const secondLoad = await import('../panels/UserProfilePanel')
    expect(firstLoad).toBe(secondLoad)
  })

  it('prefetches the account devices panel chunk', async () => {
    prefetchSettingsPanel(devicesItem)

    await vi.waitFor(async () => {
      await import('../panels/AccountDevicesPanel')
    })

    expect(await import('../panels/AccountDevicesPanel')).toBeDefined()
  })

  it('prefetches composite bundle and default inner tab for group sections', async () => {
    prefetchSettingsPanel(credentialsItem)

    await vi.waitFor(async () => {
      await Promise.all([
        import('../panels/SettingsGroupComposites'),
        import('../panels/CredentialsAiPanel'),
      ])
    })

    const [composite, inner] = await Promise.all([
      import('../panels/SettingsGroupComposites'),
      import('../panels/CredentialsAiPanel'),
    ])
    expect(composite).toBeDefined()
    expect(inner).toBeDefined()
  })
})
