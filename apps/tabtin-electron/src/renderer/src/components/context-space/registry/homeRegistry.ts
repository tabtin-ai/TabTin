import { homeSectionRegistry } from './instance'
import {
  HIDDEN_APPS,
  HOME_SECTION_ORDER,
  orderIndex,
  stemFromPath,
} from './moduleRegistryUtils'
import type { HomeSectionHandler } from './types'

// 排除同目录 *.test.tsx，避免 eager glob 把单测挂进运行时注册
const homeSectionModules = import.meta.glob(
  ['./homeSections/*.tsx', '!./homeSections/*.test.tsx'],
  { eager: true },
) as Record<string, Record<string, unknown>>

const sectionEntries: Array<[string, HomeSectionHandler]> = []
for (const [path, mod] of Object.entries(homeSectionModules)) {
  const stem = stemFromPath(path)
  if (stem === 'ResourceListSection' || stem === 'HomeGridCard' || stem === 'StructuredPreviews') continue
  for (const val of Object.values(mod)) {
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && 'appId' in item && 'Component' in item) {
          sectionEntries.push([(item as HomeSectionHandler).appId, item as HomeSectionHandler])
        }
      }
      break
    }
    if (val && typeof val === 'object' && 'appId' in val && 'Component' in val) {
      sectionEntries.push([stem, val as HomeSectionHandler])
      break
    }
  }
}

sectionEntries.sort((a, b) => orderIndex(a[0], HOME_SECTION_ORDER) - orderIndex(b[0], HOME_SECTION_ORDER))
for (const [stem, section] of sectionEntries) {
  if (HIDDEN_APPS.has(stem)) continue
  homeSectionRegistry.register(section)
}

export { homeSectionRegistry }
