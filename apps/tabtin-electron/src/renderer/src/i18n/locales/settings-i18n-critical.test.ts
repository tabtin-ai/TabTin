import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const localesDir = dirname(fileURLToPath(import.meta.url))

type JsonObject = Record<string, unknown>

function readSettingsLocale(locale: 'zh-CN' | 'en-US'): JsonObject {
  return JSON.parse(
    readFileSync(join(localesDir, locale, 'settings.json'), 'utf8'),
  ) as JsonObject
}

function getPath(root: JsonObject, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as JsonObject)) {
      return (acc as JsonObject)[key]
    }
    return undefined
  }, root)
}

/** 设置页高频入口：缺失会直接露出 raw key */
const CRITICAL_SETTINGS_KEYS = [
  'billing.cashWallet.title',
  'billing.cashWallet.hint',
  'billing.cashWallet.autoTopupGuidePrefix',
  'billing.cashWallet.autoTopupGuideLink',
  'billing.cashWallet.autoTopupGuideSuffix',
  'billing.autoTopup.title',
  'billing.autoTopup.enabled',
  'billing.autoTopup.enabledSaved',
  'billing.autoTopup.disabledSaved',
  'billing.autoTopup.unlimitedCapConfirmAction',
  'billing.lowBalance.warningCredits',
  'billing.lowBalance.criticalCredits',
  'billing.lowBalance.invalidCredits',
  'billing.cash.title',
  'billing.section.payment',
  'billing.section.cash',
  'settings.danger.title',
  'settings.danger.transferTitle',
  'settings.confirm.title',
  'settings.actions.delete',
  'settings.actions.leave',
  'settings.actions.transfer',
  'settings.validation.nameMismatch',
  'general.themeHint',
  'general.desktopBehaviorSection',
  'general.desktopBehaviorTray',
  'general.desktopBehaviorAutoStart',
  'membership.purchaseEntry.title',
  'membership.purchaseEntry.credits',
  'organizationServices.summary.autoTopupUnknownDescription',
  'organizationServices.summary.lowBalanceUnknownDescription',
  'pluginMarketplace.title',
  'emptySelection.title',
  'vault.list.empty',
  'myAgents.memoryTitle',
  'sections.systemCenter',
  'groupOverview.systemCenterDescResourcesOnly',
  'groupOverview.systemCenterPageDesc',
  'groupOverview.systemCenterPageDescResourcesOnly',
  'authorizationSystem.overview.refreshDone',
  'authorizationSystem.status.detection-unsupported',
  'sections.accountDevices',
  'accountDevices.subtitle',
  'accountDevices.status.online',
  'accountDevices.status.offline',
  'accountDevices.status.unknown',
  'accountDevices.lastSeen',
  'desktopCleanup.title',
  'desktopCleanup.subtitle.windows',
  'desktopCleanup.subtitle.mac',
  'desktopCleanup.uninstallAppDesc.windows',
  'desktopCleanup.uninstallAppDesc.mac',
  'desktopCleanup.errors.busy',
  'desktopCleanup.errors.permission',
  'desktopCleanup.errors.unknown',
  'desktopCleanup.relaunchingToWipe',
  'desktopCleanup.needsManualDevRestart',
  'desktopCleanup.wipeLocalDataConfirmDesc',
] as const

describe('settings i18n critical keys ', () => {
  it('中英文都提供关键词条，英文不是中文原文，中文不是 raw key', () => {
    const zh = readSettingsLocale('zh-CN')
    const en = readSettingsLocale('en-US')

    for (const key of CRITICAL_SETTINGS_KEYS) {
      const zhValue = getPath(zh, key)
      const enValue = getPath(en, key)
      expect(typeof zhValue, key).toBe('string')
      expect(typeof enValue, key).toBe('string')
      expect((zhValue as string).length, key).toBeGreaterThan(0)
      expect((enValue as string).length, key).toBeGreaterThan(0)
      expect(zhValue, key).not.toBe(key)
      expect(enValue, key).not.toBe(key)
      expect(enValue, key).not.toBe(zhValue)
      expect(enValue as string, key).not.toMatch(/[\u4e00-\u9fff]/)
    }

    expect(getPath(zh, 'billing.cashWallet.title')).toBe('现金钱包')
    expect(getPath(en, 'billing.cashWallet.title')).toBe('Cash wallet')
    expect(getPath(zh, 'pluginMarketplace.title')).toBe('插件市场')
    expect(getPath(zh, 'settings.danger.title')).toBe('危险操作')
    expect(getPath(en, 'settings.danger.title')).toBe('Danger zone')
    expect(getPath(zh, 'sections.systemCenter')).toBe('回收站')
    expect(getPath(en, 'sections.systemCenter')).toBe('Trash')
    // lowBalance 必须是 credits 阈值版，不能回退到已废弃的百分比键
    expect(getPath(zh, 'billing.lowBalance.warningPct')).toBeUndefined()
    expect(getPath(en, 'billing.lowBalance.warningPct')).toBeUndefined()
  })
})
