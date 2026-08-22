/**
 * 新任务空态快速开始建议：按当前聚焦 App 切换前端维护的文案集。
 * 本期不做后端配置；未知 / 空聚焦回落 default。
 */

export type StarterSuggestionAppKey =
  | 'default'
  | 'tabdoc'
  | 'tabdata'
  | 'tabweb'
  | 'tabcode'

export type StarterSuggestionModuleKey = 'tabdoc' | 'tabdata' | 'tabweb'

export interface StarterSuggestionDef {
  id: string
  /** i18n key under chat:input.starterSuggestions.* */
  titleKey: string
  promptKey: string
  outcomeKey: string
  /** App 态选中任务后显示在欢迎区的更具场景感标题。 */
  selectedTitleKey?: string
}

export interface StarterSuggestionModuleDef {
  key: StarterSuggestionModuleKey
  labelKey: string
  suggestions: StarterSuggestionDef[]
}

const DOCUMENT_SUGGESTIONS: StarterSuggestionDef[] = [
  {
    id: 'default-doc-summary',
    titleKey: 'input.starterSuggestions.modules.tabdoc.summary.title',
    promptKey: 'input.starterSuggestions.modules.tabdoc.summary.prompt',
    outcomeKey: 'input.starterSuggestions.modules.tabdoc.summary.outcome',
  },
  {
    id: 'default-doc-notice',
    titleKey: 'input.starterSuggestions.modules.tabdoc.notice.title',
    promptKey: 'input.starterSuggestions.modules.tabdoc.notice.prompt',
    outcomeKey: 'input.starterSuggestions.modules.tabdoc.notice.outcome',
  },
  {
    id: 'default-doc-outline',
    titleKey: 'input.starterSuggestions.modules.tabdoc.outline.title',
    promptKey: 'input.starterSuggestions.modules.tabdoc.outline.prompt',
    outcomeKey: 'input.starterSuggestions.modules.tabdoc.outline.outcome',
  },
  {
    id: 'default-doc-minutes',
    titleKey: 'input.starterSuggestions.modules.tabdoc.minutes.title',
    promptKey: 'input.starterSuggestions.modules.tabdoc.minutes.prompt',
    outcomeKey: 'input.starterSuggestions.modules.tabdoc.minutes.outcome',
  },
]

const TABLE_SUGGESTIONS: StarterSuggestionDef[] = [
  {
    id: 'default-table-create',
    titleKey: 'input.starterSuggestions.modules.tabdata.create.title',
    promptKey: 'input.starterSuggestions.modules.tabdata.create.prompt',
    outcomeKey: 'input.starterSuggestions.modules.tabdata.create.outcome',
  },
  {
    id: 'default-table-task',
    titleKey: 'input.starterSuggestions.modules.tabdata.task.title',
    promptKey: 'input.starterSuggestions.modules.tabdata.task.prompt',
    outcomeKey: 'input.starterSuggestions.modules.tabdata.task.outcome',
  },
  {
    id: 'default-table-customer',
    titleKey: 'input.starterSuggestions.modules.tabdata.customer.title',
    promptKey: 'input.starterSuggestions.modules.tabdata.customer.prompt',
    outcomeKey: 'input.starterSuggestions.modules.tabdata.customer.outcome',
  },
  {
    id: 'default-table-plan',
    titleKey: 'input.starterSuggestions.modules.tabdata.plan.title',
    promptKey: 'input.starterSuggestions.modules.tabdata.plan.prompt',
    outcomeKey: 'input.starterSuggestions.modules.tabdata.plan.outcome',
  },
]

const WEB_SUGGESTIONS: StarterSuggestionDef[] = [
  {
    id: 'default-web-research',
    titleKey: 'input.starterSuggestions.modules.tabweb.research.title',
    promptKey: 'input.starterSuggestions.modules.tabweb.research.prompt',
    outcomeKey: 'input.starterSuggestions.modules.tabweb.research.outcome',
  },
  {
    id: 'default-web-pricing',
    titleKey: 'input.starterSuggestions.modules.tabweb.pricing.title',
    promptKey: 'input.starterSuggestions.modules.tabweb.pricing.prompt',
    outcomeKey: 'input.starterSuggestions.modules.tabweb.pricing.outcome',
  },
  {
    id: 'default-web-news',
    titleKey: 'input.starterSuggestions.modules.tabweb.news.title',
    promptKey: 'input.starterSuggestions.modules.tabweb.news.prompt',
    outcomeKey: 'input.starterSuggestions.modules.tabweb.news.outcome',
  },
  {
    id: 'default-web-compare',
    titleKey: 'input.starterSuggestions.modules.tabweb.compare.title',
    promptKey: 'input.starterSuggestions.modules.tabweb.compare.prompt',
    outcomeKey: 'input.starterSuggestions.modules.tabweb.compare.outcome',
  },
]

const TABDOC_SUGGESTIONS: StarterSuggestionDef[] = [
  {
    id: 'tabdoc-outline',
    titleKey: 'input.starterSuggestions.tabdoc.outline.title',
    promptKey: 'input.starterSuggestions.tabdoc.outline.prompt',
    outcomeKey: 'input.starterSuggestions.tabdoc.outline.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabdoc.outline.selectedTitle',
  },
  {
    id: 'tabdoc-formalize',
    titleKey: 'input.starterSuggestions.tabdoc.formalize.title',
    promptKey: 'input.starterSuggestions.tabdoc.formalize.prompt',
    outcomeKey: 'input.starterSuggestions.tabdoc.formalize.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabdoc.formalize.selectedTitle',
  },
  {
    id: 'tabdoc-action-items',
    titleKey: 'input.starterSuggestions.tabdoc.actionItems.title',
    promptKey: 'input.starterSuggestions.tabdoc.actionItems.prompt',
    outcomeKey: 'input.starterSuggestions.tabdoc.actionItems.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabdoc.actionItems.selectedTitle',
  },
  {
    id: 'tabdoc-summary',
    titleKey: 'input.starterSuggestions.tabdoc.summary.title',
    promptKey: 'input.starterSuggestions.tabdoc.summary.prompt',
    outcomeKey: 'input.starterSuggestions.tabdoc.summary.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabdoc.summary.selectedTitle',
  },
]

const TABDATA_SUGGESTIONS: StarterSuggestionDef[] = [
  {
    id: 'tabdata-design',
    titleKey: 'input.starterSuggestions.tabdata.design.title',
    promptKey: 'input.starterSuggestions.tabdata.design.prompt',
    outcomeKey: 'input.starterSuggestions.tabdata.design.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabdata.design.selectedTitle',
  },
  {
    id: 'tabdata-stats',
    titleKey: 'input.starterSuggestions.tabdata.stats.title',
    promptKey: 'input.starterSuggestions.tabdata.stats.prompt',
    outcomeKey: 'input.starterSuggestions.tabdata.stats.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabdata.stats.selectedTitle',
  },
  {
    id: 'tabdata-insights',
    titleKey: 'input.starterSuggestions.tabdata.insights.title',
    promptKey: 'input.starterSuggestions.tabdata.insights.prompt',
    outcomeKey: 'input.starterSuggestions.tabdata.insights.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabdata.insights.selectedTitle',
  },
  {
    id: 'tabdata-view',
    titleKey: 'input.starterSuggestions.tabdata.view.title',
    promptKey: 'input.starterSuggestions.tabdata.view.prompt',
    outcomeKey: 'input.starterSuggestions.tabdata.view.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabdata.view.selectedTitle',
  },
]

const TABWEB_SUGGESTIONS: StarterSuggestionDef[] = [
  {
    id: 'tabweb-summarize',
    titleKey: 'input.starterSuggestions.tabweb.summarize.title',
    promptKey: 'input.starterSuggestions.tabweb.summarize.prompt',
    outcomeKey: 'input.starterSuggestions.tabweb.summarize.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabweb.summarize.selectedTitle',
  },
  {
    id: 'tabweb-collect-table',
    titleKey: 'input.starterSuggestions.tabweb.collectTable.title',
    promptKey: 'input.starterSuggestions.tabweb.collectTable.prompt',
    outcomeKey: 'input.starterSuggestions.tabweb.collectTable.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabweb.collectTable.selectedTitle',
  },
  {
    id: 'tabweb-to-doc',
    titleKey: 'input.starterSuggestions.tabweb.toDoc.title',
    promptKey: 'input.starterSuggestions.tabweb.toDoc.prompt',
    outcomeKey: 'input.starterSuggestions.tabweb.toDoc.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabweb.toDoc.selectedTitle',
  },
  {
    id: 'tabweb-compare',
    titleKey: 'input.starterSuggestions.tabweb.compare.title',
    promptKey: 'input.starterSuggestions.tabweb.compare.prompt',
    outcomeKey: 'input.starterSuggestions.tabweb.compare.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabweb.compare.selectedTitle',
  },
]

const TABCODE_SUGGESTIONS: StarterSuggestionDef[] = [
  {
    id: 'tabcode-structure',
    titleKey: 'input.starterSuggestions.tabcode.structure.title',
    promptKey: 'input.starterSuggestions.tabcode.structure.prompt',
    outcomeKey: 'input.starterSuggestions.tabcode.structure.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabcode.structure.selectedTitle',
  },
  {
    id: 'tabcode-debug',
    titleKey: 'input.starterSuggestions.tabcode.debug.title',
    promptKey: 'input.starterSuggestions.tabcode.debug.prompt',
    outcomeKey: 'input.starterSuggestions.tabcode.debug.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabcode.debug.selectedTitle',
  },
  {
    id: 'tabcode-small-change',
    titleKey: 'input.starterSuggestions.tabcode.smallChange.title',
    promptKey: 'input.starterSuggestions.tabcode.smallChange.prompt',
    outcomeKey: 'input.starterSuggestions.tabcode.smallChange.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabcode.smallChange.selectedTitle',
  },
  {
    id: 'tabcode-tests',
    titleKey: 'input.starterSuggestions.tabcode.tests.title',
    promptKey: 'input.starterSuggestions.tabcode.tests.prompt',
    outcomeKey: 'input.starterSuggestions.tabcode.tests.outcome',
    selectedTitleKey: 'input.starterSuggestions.tabcode.tests.selectedTitle',
  },
]

export const STARTER_SUGGESTION_MODULES: StarterSuggestionModuleDef[] = [
  {
    key: 'tabdoc',
    labelKey: 'input.starterSuggestions.modules.tabdoc.label',
    suggestions: DOCUMENT_SUGGESTIONS,
  },
  {
    key: 'tabdata',
    labelKey: 'input.starterSuggestions.modules.tabdata.label',
    suggestions: TABLE_SUGGESTIONS,
  },
  {
    key: 'tabweb',
    labelKey: 'input.starterSuggestions.modules.tabweb.label',
    suggestions: WEB_SUGGESTIONS,
  },
]

const SUGGESTIONS_BY_APP: Record<StarterSuggestionAppKey, StarterSuggestionDef[]> = {
  tabdoc: TABDOC_SUGGESTIONS,
  tabdata: TABDATA_SUGGESTIONS,
  tabweb: TABWEB_SUGGESTIONS,
  tabcode: TABCODE_SUGGESTIONS,
  default: DOCUMENT_SUGGESTIONS,
}

/** 同 App 内换资源标题不换建议集；tabfolder 与 tabcode 共用代码向建议。 */
export function resolveStarterSuggestionAppKey(
  activeContextType: string | null | undefined,
): StarterSuggestionAppKey {
  switch (activeContextType) {
    case 'tabdoc':
      return 'tabdoc'
    case 'tabdata':
      return 'tabdata'
    case 'tabweb':
      return 'tabweb'
    case 'tabcode':
    case 'tabfolder':
      return 'tabcode'
    default:
      return 'default'
  }
}

export function resolveStarterSuggestions(
  activeContextType: string | null | undefined,
): { appKey: StarterSuggestionAppKey; suggestions: StarterSuggestionDef[] } {
  const appKey = resolveStarterSuggestionAppKey(activeContextType)
  return {
    appKey,
    suggestions: SUGGESTIONS_BY_APP[appKey],
  }
}

/** 打开 App 时欢迎标题用的语境标签 key（chat:input.starterSuggestions.contextLabel.*） */
export function resolveStarterContextLabelKey(
  appKey: StarterSuggestionAppKey,
): string | null {
  if (appKey === 'default') return null
  return `input.starterSuggestions.contextLabel.${appKey}`
}
