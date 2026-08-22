import { describe, expect, it } from 'vitest'

import deChat from './de-DE/chat.json'
import deTabchat from './de-DE/tabchat.json'
import enChat from './en-US/chat.json'
import enTabchat from './en-US/tabchat.json'
import esChat from './es-ES/chat.json'
import esTabchat from './es-ES/tabchat.json'
import frChat from './fr-FR/chat.json'
import frTabchat from './fr-FR/tabchat.json'
import jaChat from './ja-JP/chat.json'
import jaTabchat from './ja-JP/tabchat.json'
import koChat from './ko-KR/chat.json'
import koTabchat from './ko-KR/tabchat.json'
import zhCNChat from './zh-CN/chat.json'
import zhCNTabchat from './zh-CN/tabchat.json'
import zhTWChat from './zh-TW/chat.json'
import zhTWTabchat from './zh-TW/tabchat.json'

const tabchatLocales = [
  zhCNTabchat,
  enTabchat,
  zhTWTabchat,
  jaTabchat,
  koTabchat,
  deTabchat,
  frTabchat,
  esTabchat,
]

const chatLocales = [
  zhCNChat,
  enChat,
  zhTWChat,
  jaChat,
  koChat,
  deChat,
  frChat,
  esChat,
]

describe('session share picker translations', () => {
  it('provides picker, empty-state, and relative-time copy in every locale', () => {
    tabchatLocales.forEach((resource) => {
      expect(resource.sessionSharePickerCount).toBeTruthy()
      expect(resource.sessionSharePickerSearchEmpty).toBeTruthy()
      expect(resource.sessionSharePickerEmptyScope).toBeTruthy()
      Object.values(resource.sessionSharePicker).forEach(value => expect(value).toBeTruthy())
      Object.values(resource.sessionList).forEach(value => expect(value).toBeTruthy())
    })
  })

  it('provides all share modes in every locale', () => {
    chatLocales.forEach((resource) => {
      Object.values(resource.shareTier).forEach(value => expect(value).toBeTruthy())
    })
  })

  it('renders the reported Korean UI without Chinese fallbacks', () => {
    expect(koTabchat.sessionSharePicker.scopeRecent).toBe('최근')
    expect(koTabchat.sessionSharePicker.noMessages).toBe('메시지 없음')
    expect(koTabchat.sessionList.relMinutes.replace('{{n}}', '8')).toBe('8분')
    expect(koChat.shareTier.viewTitle).toBe('실시간 보기')
  })
})
