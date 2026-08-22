/**
 * Prompt section assembler —— owns section registration, canonical ordering,
 * and final materialization of runtime-contributed system prompt sections.
 *
 * Core loop/hook code should only collect section contributions. The assembler
 * is the single place that knows how sections are ordered and rendered, keeping
 * prompt-cache byte stability out of the run state machine.
 */
import type {
  SystemBlock,
} from '../contracts/conversation.js';
import type {
  SystemSection,
  SystemSectionName,
} from '../contracts/wire-protocol.js';
import {
  SYSTEM_SECTION_NAMES,
} from '../contracts/wire-protocol.js';
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '../contracts/model-llm.js';
import { flattenSystemPrompt } from './system-prompt-text.js';

export type PromptSectionPlacement = 'static' | 'dynamic';

export interface PromptSectionDefinition {
  name: SystemSectionName;
  placement: PromptSectionPlacement;
  cacheStable: boolean;
  rank: number;
}

export interface PromptSectionContribution {
  name: SystemSectionName;
  source: string;
  content: string;
  charCount: number;
}

export interface PromptSectionRegistry {
  getDefinition(name: SystemSectionName): PromptSectionDefinition | undefined;
  compare(a: PromptSectionContribution, b: PromptSectionContribution): number;
}

const DEFAULT_SECTION_ORDER: readonly SystemSectionName[] = [
  // Static area: stable across turns and safe for prompt cache reuse.
  SYSTEM_SECTION_NAMES.skills_index,
  SYSTEM_SECTION_NAMES.mcp_servers,
  SYSTEM_SECTION_NAMES.cli_commands,
  SYSTEM_SECTION_NAMES.tool_call_metadata,
  // Dynamic area: turn-sensitive guidance after the boundary.
  SYSTEM_SECTION_NAMES.convergence_hint,
  SYSTEM_SECTION_NAMES.project_task_context,
  SYSTEM_SECTION_NAMES.skills_listing,
  SYSTEM_SECTION_NAMES.budget_warn_system,
  SYSTEM_SECTION_NAMES.budget_grace_system,
  SYSTEM_SECTION_NAMES.stall_detection,
  SYSTEM_SECTION_NAMES.repetition_detection,
];

function buildDefaultDefinitions(): Map<SystemSectionName, PromptSectionDefinition> {
  const definitions = new Map<SystemSectionName, PromptSectionDefinition>();
  DEFAULT_SECTION_ORDER.forEach((name, rank) => {
    definitions.set(name, {
      name,
      rank,
      placement: rank < 4 ? 'static' : 'dynamic',
      cacheStable: rank < 4,
    });
  });
  return definitions;
}

export function createPromptSectionRegistry(
  extraDefinitions: readonly PromptSectionDefinition[] = [],
): PromptSectionRegistry {
  const definitions = buildDefaultDefinitions();
  for (const definition of extraDefinitions) {
    definitions.set(definition.name, definition);
  }
  return {
    getDefinition: (name) => definitions.get(name),
    compare: (a, b) => {
      const aRank = definitions.get(a.name)?.rank ?? DEFAULT_SECTION_ORDER.length;
      const bRank = definitions.get(b.name)?.rank ?? DEFAULT_SECTION_ORDER.length;
      return aRank - bRank;
    },
  };
}

const DEFAULT_PROMPT_SECTION_REGISTRY = createPromptSectionRegistry();

/**
 * Append a runtime-generated instruction (reactive condense reminder /
 * convergence hint) to the effective system prompt.
 *
 * Preserves the original form (string stays string, `SystemBlock[]` stays
 * `SystemBlock[]`). When a `SystemBlock[]` is used, the appended block becomes
 * the final ephemeral segment at provider projection time.
 */
function appendSystemInstruction(
  current: string | SystemBlock[] | undefined,
  injection: string,
): string | SystemBlock[] {
  if (!current) return injection;
  if (typeof current === 'string') {
    return `${current}\n\n${injection}`;
  }
  return [...current, { type: 'text', text: injection } satisfies SystemBlock];
}

function wrapWithSectionMarker(
  name: SystemSectionName,
  content: string,
  source: string,
): string {
  return `<!-- section:${name} source:${source} -->\n${content}\n<!-- /section:${name} -->`;
}

function sortCanonical(
  sections: PromptSectionContribution[],
  registry: PromptSectionRegistry,
): PromptSectionContribution[] {
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => registry.compare(a.section, b.section) || (a.index - b.index))
    .map((entry) => entry.section);
}

export interface PromptAssemblyState {
  /** Host-configured base prompt, preserved as-is until materialization. */
  base: string | SystemBlock[] | undefined;
  /** Static section bucket, before the dynamic boundary. */
  staticSections: PromptSectionContribution[];
  /** Dynamic section bucket, after the dynamic boundary. */
  dynamicSections: PromptSectionContribution[];
}

export function createPromptAssembly(
  systemPromptRaw: string | SystemBlock[] | undefined,
): PromptAssemblyState {
  return { base: systemPromptRaw, staticSections: [], dynamicSections: [] };
}

export interface MaterializedPrompt {
  effectiveSystemPrompt: string | SystemBlock[] | undefined;
  sectionRegistry: SystemSection[];
}

export function materializePrompt(
  assembly: PromptAssemblyState,
  registry: PromptSectionRegistry = DEFAULT_PROMPT_SECTION_REGISTRY,
): MaterializedPrompt {
  const sectionRegistry: SystemSection[] = [];
  if (assembly.base) {
    const baseText = flattenSystemPrompt(assembly.base);
    if (baseText.length > 0) {
      sectionRegistry.push({
        name: SYSTEM_SECTION_NAMES.base_prompt,
        source: 'config',
        content: baseText,
        charCount: baseText.length,
      });
    }
  }
  let target = assembly.base;
  for (const section of sortCanonical(assembly.staticSections, registry)) {
    target = appendSystemInstruction(
      target,
      wrapWithSectionMarker(section.name, section.content, section.source),
    );
    sectionRegistry.push(section);
  }
  const dynamicSections = sortCanonical(assembly.dynamicSections, registry);
  if (dynamicSections.length > 0 && target) {
    target = appendSystemInstruction(target, SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  }
  for (const section of dynamicSections) {
    target = appendSystemInstruction(
      target,
      wrapWithSectionMarker(section.name, section.content, section.source),
    );
    sectionRegistry.push(section);
  }
  return { effectiveSystemPrompt: target, sectionRegistry };
}
