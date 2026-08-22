import { describe, expect, it } from 'vitest'

import deDE from './de-DE/project.json'
import enUS from './en-US/project.json'
import esES from './es-ES/project.json'
import frFR from './fr-FR/project.json'
import jaJP from './ja-JP/project.json'
import koKR from './ko-KR/project.json'
import zhCN from './zh-CN/project.json'
import zhTW from './zh-TW/project.json'

const locales = { zhCN, enUS, zhTW, jaJP, koKR, deDE, frFR, esES }
const requiredKeys = [
  'title',
  'introduction',
  'nameLabel',
  'namePlaceholder',
  'descriptionLabel',
  'descriptionPlaceholder',
  'workspaceNotice',
  'cancel',
  'create',
  'selectOrganization',
  'nameRequired',
  'createFailed',
  'created',
] as const

describe('Create Project dialog translations', () => {
  it('provides every dialog string in all supported locales', () => {
    Object.entries(locales).forEach(([locale, resource]) => {
      requiredKeys.forEach((key) => {
        expect(resource.createProjectDialog[key], `${locale}.${key}`).toBeTruthy()
      })
    })
  })

  it('does not leave Chinese fallback copy in the English dialog', () => {
    const englishCopy = requiredKeys.map(key => enUS.createProjectDialog[key]).join(' ')
    expect(englishCopy).not.toMatch(/[\u3400-\u9fff]/u)
    expect(enUS.createProjectDialog.title).toBe('Create Project')
    expect(enUS.createProjectDialog.create).toBe('Create')
  })
})
