import type { SkillIndexEntry } from '@/skills/types'
import { isRecommendedMarketPackSkill } from './skillMarketTaxonomy'

type SkillPresentation = {
  display_name: string
  description: string
}

/**
 * The marketplace API currently returns the source SKILL.md metadata verbatim.
 * Official recommended packs are authored in Chinese, so their catalog copy must
 * be localized in the client until the catalog API exposes locale-aware fields.
 *
 * Keep this map keyed by the stable skill slug and apply it only to the six
 * official recommended packs. User-published skills must always retain the copy
 * supplied by their author.
 */
const ENGLISH_RECOMMENDED_SKILL_CATALOG: Readonly<Record<string, SkillPresentation>> = {
  'humanizer-zh': {
    display_name: 'Remove AI Writing Traces',
    description: 'Rewrite AI-generated text so it sounds natural and human. Detects and fixes inflated symbolism, promotional language, vague attribution, overused dashes, repetitive patterns, AI vocabulary, and excessive transitions.',
  },
  'gantt-chart-builder': {
    display_name: 'Gantt Chart & Critical Path',
    description: 'Create an interactive HTML Gantt chart from tasks and dependencies, with critical path analysis, project timelines, dependency visualization, and float calculations.',
  },
  'iteration-planner': {
    display_name: 'Sprint Planning',
    description: 'Plan agile sprints using team capacity and historical velocity. Select scope, break down and estimate work, analyze dependencies, balance workload, and produce an actionable sprint plan.',
  },
  'meeting-recap': {
    display_name: 'Meeting Recap',
    description: 'Turn meeting transcripts, notes, or chat records into structured minutes with topics, key discussion points, decisions, owners, deadlines, and follow-up actions.',
  },
  'work-report-writer': {
    display_name: 'Weekly & Monthly Reports',
    description: 'Turn scattered work notes and git logs into structured weekly or monthly reports in data-driven, narrative, or OKR-aligned formats.',
  },
  'dataset-health-audit': {
    display_name: 'Dataset Health Audit',
    description: 'Audit CSV, Excel, TSV, and JSON datasets across 12 quality dimensions, then produce a quality score, issue details, and practical remediation suggestions.',
  },
  'outlier-scan': {
    display_name: 'Outlier Scan',
    description: 'Scan CSV data for anomalies using Z-score, IQR, and moving-average deviation, classify findings as explainable or requiring attention, and export a detailed JSON report.',
  },
  'regression-insight': {
    display_name: 'Regression Insights',
    description: 'Run linear (OLS) or logistic regression on CSV and Excel data, then explain coefficients, R², p-values, VIF, and other statistical results in plain language.',
  },
  'split-test-evaluator': {
    display_name: 'Split Test Evaluator',
    description: 'Analyze A/B tests with conversion-rate comparisons, significance tests, confidence intervals, statistical power, and minimum sample-size estimates.',
  },
  'legal-risk-analyzer': {
    display_name: 'Legal Risk Assessment',
    description: 'Assess legal risk using a severity-by-likelihood framework, assign a color-coded risk level, and recommend actions from monitoring to escalation or outside counsel.',
  },
  'okr-planner': {
    display_name: 'OKR Planning & Review',
    description: 'Create, break down, align, score, and review OKRs. Improve objectives and key results, plan quarterly goals, and turn broad targets into measurable outcomes.',
  },
  'saas-analyzer': {
    display_name: 'SaaS Metrics Analysis',
    description: 'Analyze MRR, customer count, acquisition cost, and other inputs to calculate ARR, churn, LTV, CAC, and NRR, benchmark performance, and recommend priority actions.',
  },
  'lp-proto-gen': {
    display_name: 'Landing Page Prototype',
    description: 'Generate a self-contained HTML landing-page prototype with hero, social proof, features, pricing, and call-to-action sections, ready to preview in a browser.',
  },
  'theme-kit': {
    display_name: 'Theme Style Kit',
    description: 'Apply professional visual themes to presentations, documents, reports, and HTML pages using 10 built-in color-and-type presets or a custom theme.',
  },
  'code-safety-audit': {
    display_name: 'Code Security Audit',
    description: 'Scan code for dependency vulnerabilities, exposed secrets, OWASP risks, SQL injection, XSS, and other common security issues.',
  },
  'code-to-chart': {
    display_name: 'Code Architecture Diagrams',
    description: 'Analyze imports and dependencies to generate architecture, flow, and organization diagrams as Mermaid text or SVG for Python, JavaScript, TypeScript, Go, and Java projects.',
  },
  'smart-commit-gen': {
    display_name: 'Conventional Commit Generator',
    description: 'Analyze git diffs and generate Conventional Commits messages with automatic scope detection and intelligent commit-type selection.',
  },
}

function resolveStableSkillSlug(skill: Pick<SkillIndexEntry, 'slug' | 'skill_key' | 'name'>): string {
  const explicitSlug = skill.slug?.trim()
  if (explicitSlug) return explicitSlug

  const canonicalKey = skill.skill_key?.trim()
  if (canonicalKey) {
    const lastSegment = canonicalKey.split('/').filter(Boolean).pop()
    if (lastSegment) return lastSegment
  }

  return skill.name?.trim() || ''
}

export function localizeRecommendedMarketSkill<T extends SkillIndexEntry>(
  skill: T,
  language: string | null | undefined,
): T {
  const normalizedLanguage = language?.toLowerCase() || ''
  // Source pack metadata is Simplified Chinese. Until the catalog API exposes
  // per-locale fields, use maintained English copy for every non-Chinese UI.
  if (normalizedLanguage.startsWith('zh')) return skill
  if (!isRecommendedMarketPackSkill(skill)) return skill

  const presentation = ENGLISH_RECOMMENDED_SKILL_CATALOG[resolveStableSkillSlug(skill)]
  if (!presentation) return skill

  return {
    ...skill,
    display_name: presentation.display_name,
    description: presentation.description,
  }
}
