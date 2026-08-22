export type {
  SectionDescriptor,
  SectionCategory,
  SectionLanguage,
  SectionInjectionTiming,
  SectionRole,
  SectionPosition,
  ToolRiskTier,
  AgentMode,
  HostCoverage,
  RenderCondition,
  PresenceInProduction,
} from './section-descriptor.js';

export { SECTION_REGISTRY, REGISTRY_ENTRIES } from './registry.js';

export {
  checkPresenceInvariants,
  checkSectionCharBudget,
  detectLanguage,
  checkLanguageDiscipline,
  checkCacheDiscipline,
  checkToolHardContract,
  checkNoDeprecatedTerms,
  HARD_CONTRACT_KEYWORDS,
  DEPRECATED_PARAM_TERMS,
  // 阶段 6 议题 3 新增：inputSchema 字段 description 治理
  collectInputSchemaFieldDescriptions,
  isHighRiskKeyField,
  getFieldBudget,
  checkFieldCharBudget,
  checkFieldLanguageDiscipline,
} from './audit-helpers.js';
export type {
  PresenceInvariantsResult,
  CharBudgetResult,
  DetectedLanguage,
  LanguageDisciplineResult,
  CacheDisciplineResult,
  ToolHardContractResult,
  HardContractTopic,
  ToolHardContractTopicMiss,
  DeprecatedParamTerm,
  DeprecatedTermHit,
  NoDeprecatedTermsResult,
  InputSchemaFieldDescription,
  FieldCharBudgetResult,
  FieldLanguageDisciplineResult,
} from './audit-helpers.js';
