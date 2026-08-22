import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const localesDir = path.resolve(scriptDir, '../src/renderer/src/i18n/locales')
const repoRoot = path.resolve(scriptDir, '../../..')
const checkedLanguages = [
  { language: 'zh-TW', referenceLanguage: 'zh-CN' },
  { language: 'ja-JP', referenceLanguage: 'en-US' },
  { language: 'ko-KR', referenceLanguage: 'en-US' },
  { language: 'de-DE', referenceLanguage: 'en-US' },
  { language: 'fr-FR', referenceLanguage: 'en-US' },
  { language: 'es-ES', referenceLanguage: 'en-US' },
]
const sharedLocaleRoots = [
  'packages/tabdoc-ui/src/locales',
  'packages/table-ui/src/i18n/locales',
  'packages/table-core/src/i18n/locales',
].map(relative => path.join(repoRoot, relative))

const listNamespaces = language => fs.readdirSync(path.join(localesDir, language))
  .filter(filename => filename.endsWith('.json'))
  .sort()

const readNamespace = (language, namespace) => JSON.parse(
  fs.readFileSync(path.join(localesDir, language, namespace), 'utf8'),
)

const leafEntries = (value, prefix = '', entries = new Map()) => {
  if (Array.isArray(value)) {
    if (value.length === 0) entries.set(prefix, { type: 'array', value })
    value.forEach((item, index) => leafEntries(item, `${prefix}[${index}]`, entries))
    return entries
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0 && prefix) entries.set(prefix, { type: 'object', value })
    for (const key of keys) leafEntries(value[key], prefix ? `${prefix}.${key}` : key, entries)
    return entries
  }
  entries.set(prefix, { type: value === null ? 'null' : typeof value, value })
  return entries
}

const interpolationTokens = value => {
  if (typeof value !== 'string') return []
  return value.match(/{{-?\s*[^{}]+?\s*}}|\$\{[^{}]+}|%[sdif]/g)?.sort() ?? []
}

const htmlTags = value => {
  if (typeof value !== 'string') return []
  return value.match(/<\/?[a-z][^>]*>/gi)?.map(tag => tag.toLowerCase()).sort() ?? []
}

const sameTokens = (left, right) => (
  left.length === right.length && left.every((token, index) => token === right[index])
)

const documentTerms = (value, language) => {
  if (typeof value !== 'string') return []
  const pattern = language === 'zh-CN'
    ? /文档|文件(?!夹)/g
    : /文檔|文件|檔案(?!夾)/g
  return value.match(pattern) ?? []
}

const hasTraditionalChineseDocumentMistranslation = (reference, actual) => {
  if (typeof reference !== 'string' || !reference.includes('文档') || typeof actual !== 'string') return false
  const referenceTerms = documentTerms(reference, 'zh-CN')
  const actualTerms = documentTerms(actual, 'zh-TW')
  if (referenceTerms.length !== actualTerms.length) return false
  return referenceTerms.some((term, index) => term === '文档' && actualTerms[index] !== '文檔')
}

const hasDeprecatedTraditionalChineseSearchTerm = value => (
  typeof value === 'string' && /查找|尋找|搜寻/.test(value)
)

const protectedBrandTokens = [
  'TabTin', '小Tin', 'TabDoc', 'TabData', 'TabChat', 'TabCode', 'TabWeb',
  'TabSlide', 'TabVideo', 'TabFiles', 'TabTracker', 'TabInbox',
]

const missingProtectedBrandTokens = (reference, actual) => {
  if (typeof reference !== 'string' || typeof actual !== 'string') return []
  return protectedBrandTokens.filter(token => reference.includes(token) && !actual.includes(token))
}

const hasSimplifiedChineseResidue = value => (
  typeof value === 'string'
  && /[这为与发个们对过还从将进见关开数页项选设长线点历应体统档语产处动务现机录节级权组织认标签显写读创删复误总户员块简网试验启闭载导报结属该请经无仅错钟别]/.test(value)
)

const hasUnexpectedEnglishChineseText = value => (
  typeof value === 'string'
  && /[\u3400-\u9fff]/.test(value.replaceAll('小Tin', ''))
)

const failures = []

for (const namespace of listNamespaces('en-US')) {
  const entries = leafEntries(readNamespace('en-US', namespace))
  for (const [key, entry] of entries) {
    if (hasUnexpectedEnglishChineseText(entry.value)) {
      failures.push(`en-US/${namespace}:${key || '<root>'} 英文词条残留中文：${entry.value}`)
    }
  }
}

for (const { language, referenceLanguage } of checkedLanguages) {
  const referenceNamespaces = listNamespaces(referenceLanguage)
  const actualNamespaces = listNamespaces(language)
  const missingNamespaces = referenceNamespaces.filter(ns => !actualNamespaces.includes(ns))
  const extraNamespaces = actualNamespaces.filter(ns => !referenceNamespaces.includes(ns))

  for (const namespace of missingNamespaces) failures.push(`${language}: 缺少 namespace ${namespace}`)
  for (const namespace of extraNamespaces) failures.push(`${language}: 多余 namespace ${namespace}`)

  for (const namespace of referenceNamespaces.filter(ns => actualNamespaces.includes(ns))) {
    const reference = leafEntries(readNamespace(referenceLanguage, namespace))
    const actual = leafEntries(readNamespace(language, namespace))

    for (const [key, expected] of reference) {
      const location = `${language}/${namespace}:${key || '<root>'}`
      const received = actual.get(key)
      if (!received) {
        failures.push(`${location} 缺少词条`)
        continue
      }
      if (received.type !== expected.type) {
        failures.push(`${location} 类型不一致，应为 ${expected.type}，实际为 ${received.type}`)
        continue
      }
      if (received.type === 'string' && received.value.trim() === '' && expected.value.trim() !== '') {
        failures.push(`${location} 译文为空`)
      }
      if (language === 'zh-TW' && hasTraditionalChineseDocumentMistranslation(expected.value, received.value)) {
        failures.push(`${location} 术语不准确：简体“文档”应翻译为繁体“文檔”，不能翻译为“文件”`)
      }
      if (language === 'zh-TW' && hasDeprecatedTraditionalChineseSearchTerm(received.value)) {
        failures.push(`${location} 术语不统一：繁体中文的搜索操作应统一使用“搜尋”`)
      }
      if (language === 'zh-TW' && hasSimplifiedChineseResidue(received.value)) {
        failures.push(`${location} 繁体中文词条残留简体字：${received.value}`)
      }
      const missingBrands = missingProtectedBrandTokens(expected.value, received.value)
      if (missingBrands.length > 0) {
        failures.push(`${location} 产品名不可翻译，缺少原文标识：[${missingBrands}]`)
      }
      const expectedTokens = interpolationTokens(expected.value)
      const receivedTokens = interpolationTokens(received.value)
      if (!sameTokens(expectedTokens, receivedTokens)) {
        failures.push(`${location} 插值变量不一致，应为 [${expectedTokens}]，实际为 [${receivedTokens}]`)
      }
      const expectedTags = htmlTags(expected.value)
      const receivedTags = htmlTags(received.value)
      if (!sameTokens(expectedTags, receivedTags)) {
        failures.push(`${location} HTML 标签不一致，应为 [${expectedTags}]，实际为 [${receivedTags}]`)
      }
    }

    for (const key of actual.keys()) {
      if (!reference.has(key)) failures.push(`${language}/${namespace}:${key || '<root>'} 多余词条`)
    }
  }
}

const zhTwContactTerms = new Map([
  ['externalContacts.hints.external', '已建立關係的外部聯絡人，可發起私訊或邀請加入群組聊天。'],
  ['externalContacts.addFriend', '新增外部聯絡人'],
  ['externalContacts.block', '封鎖'],
  ['externalContacts.unblock', '解除封鎖'],
])
const zhTwTabchat = leafEntries(readNamespace('zh-TW', 'tabchat.json'))
for (const [key, expected] of zhTwContactTerms) {
  const received = zhTwTabchat.get(key)?.value
  if (received !== expected) {
    failures.push(`zh-TW/tabchat.json:${key} 联系人术语不统一，应为“${expected}”，实际为“${received}”`)
  }
}

const expectedDefaultWorkspaceNames = new Map([
  ['en-US', 'Default Workspace'],
  ['zh-TW', '預設工作空間'],
  ['ja-JP', 'デフォルトワークスペース'],
  ['ko-KR', '기본 작업 공간'],
  ['de-DE', 'Standardarbeitsbereich'],
  ['fr-FR', 'Espace de travail par défaut'],
  ['es-ES', 'Espacio de trabajo predeterminado'],
])
for (const [language, expected] of expectedDefaultWorkspaceNames) {
  const received = leafEntries(readNamespace(language, 'workspace.json')).get('welcome.defaultAgentName')?.value
  if (received !== expected) {
    failures.push(`${language}/workspace.json:welcome.defaultAgentName 默认工作空间名称错误，应为“${expected}”，实际为“${received}”`)
  }
}

for (const sharedRoot of sharedLocaleRoots) {
  const englishEntries = leafEntries(JSON.parse(fs.readFileSync(path.join(sharedRoot, 'en-US.json'), 'utf8')))
  for (const [key, entry] of englishEntries) {
    if (hasUnexpectedEnglishChineseText(entry.value)) {
      failures.push(`${path.relative(repoRoot, sharedRoot)}/en-US.json:${key} 英文词条残留中文：${entry.value}`)
    }
  }
  for (const { language, referenceLanguage } of checkedLanguages) {
    const reference = leafEntries(JSON.parse(fs.readFileSync(path.join(sharedRoot, `${referenceLanguage}.json`), 'utf8')))
    const actual = leafEntries(JSON.parse(fs.readFileSync(path.join(sharedRoot, `${language}.json`), 'utf8')))
    const label = `${path.relative(repoRoot, sharedRoot)}/${language}.json`
    for (const [key, expected] of reference) {
      const received = actual.get(key)
      if (!received) {
        failures.push(`${label}:${key} 缺少词条`)
        continue
      }
      if (received.type !== expected.type) failures.push(`${label}:${key} 类型不一致`)
      if (language === 'zh-TW' && hasTraditionalChineseDocumentMistranslation(expected.value, received.value)) {
        failures.push(`${label}:${key} 术语不准确：简体“文档”应翻译为繁体“文檔”，不能翻译为“文件”`)
      }
      if (language === 'zh-TW' && hasDeprecatedTraditionalChineseSearchTerm(received.value)) {
        failures.push(`${label}:${key} 术语不统一：繁体中文的搜索操作应统一使用“搜尋”`)
      }
      if (language === 'zh-TW' && hasSimplifiedChineseResidue(received.value)) {
        failures.push(`${label}:${key} 繁体中文词条残留简体字：${received.value}`)
      }
      const missingBrands = missingProtectedBrandTokens(expected.value, received.value)
      if (missingBrands.length > 0) {
        failures.push(`${label}:${key} 产品名不可翻译，缺少原文标识：[${missingBrands}]`)
      }
      if (!sameTokens(interpolationTokens(expected.value), interpolationTokens(received.value))) {
        failures.push(`${label}:${key} 插值变量不一致`)
      }
      if (!sameTokens(htmlTags(expected.value), htmlTags(received.value))) {
        failures.push(`${label}:${key} HTML 标签不一致`)
      }
    }
    for (const key of actual.keys()) {
      if (!reference.has(key)) failures.push(`${label}:${key} 多余词条`)
    }
  }
}

if (failures.length > 0) {
  console.error(`i18n 完整性校验失败（${failures.length} 项）：`)
  for (const failure of failures.slice(0, 200)) console.error(`- ${failure}`)
  if (failures.length > 200) console.error(`- 其余 ${failures.length - 200} 项已省略`)
  process.exit(1)
}

console.log(`i18n 完整性校验通过：${checkedLanguages.map(item => item.language).join(', ')} 的桌面端与共享资源均完整。`)
