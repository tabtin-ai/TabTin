import { describe, expect, it } from 'vitest'

import zhCN from './zh-CN/context.json'
import enUS from './en-US/context.json'
import zhTW from './zh-TW/context.json'
import jaJP from './ja-JP/context.json'
import koKR from './ko-KR/context.json'
import deDE from './de-DE/context.json'
import frFR from './fr-FR/context.json'
import esES from './es-ES/context.json'

const locales = { zhCN, enUS, zhTW, jaJP, koKR, deDE, frFR, esES }

describe('conversation asset rail i18n', () => {
  it('all supported locales provide the conversation assets and files labels', () => {
    for (const [locale, context] of Object.entries(locales)) {
      expect(context.canvasRail.conversationAssets, `${locale}: conversationAssets`).toEqual(expect.any(String))
      expect(context.canvasRail.conversationAssets.trim(), `${locale}: conversationAssets`).not.toBe('')
      expect(context.canvasRail.assetFiles, `${locale}: assetFiles`).toEqual(expect.any(String))
      expect(context.canvasRail.assetFiles.trim(), `${locale}: assetFiles`).not.toBe('')
    }
  })

  it('English labels do not fall back to Chinese defaults', () => {
    expect(enUS.canvasRail.conversationAssets).toBe('Conversation assets')
    expect(enUS.canvasRail.assetFiles).toBe('Files')
    expect(enUS.canvasRail.conversationAssets).not.toMatch(/[\u3400-\u9fff]/)
    expect(enUS.canvasRail.assetFiles).not.toMatch(/[\u3400-\u9fff]/)
  })
})
