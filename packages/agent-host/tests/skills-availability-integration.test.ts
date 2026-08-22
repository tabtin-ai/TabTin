import { describe, expect, it, vi } from 'vitest'
import type { EngineState, ToolContext } from '@tabtin/agent-runtime/engine'
import { renderSkillNames, type LocalSkill } from '@tabtin/agent-runtime/skills'
import { SkillsCap } from '../src/capabilities/skills.js'
import { SkillsStore } from '../src/state/skills/skills-store.js'
import {
  makeBeforeModelCtx,
  makeRunCtx,
  sectionContent,
} from './fixtures/fake-capabilities.js'
import { SYSTEM_SECTION_NAMES } from '@tabtin/agent-runtime/engine'

const SKILL: LocalSkill = {
  canonicalKey: 'platform:visualization/tabtin-widget',
  source: 'platform',
  scope: 'shared',
  slug: 'tabtin-widget',
  name: 'TabTin Widget',
  description: 'Render a widget',
  docPath: '/skills/tabtin-widget/SKILL.md',
  realpath: '/skills/tabtin-widget/SKILL.md',
  content: '# TabTin Widget',
  rootKind: 'builtin/shared',
  indexedAt: 1,
}

function toolContext(runId: string): ToolContext {
  return {
    threadId: 'thread-1',
    runtimeId: 'runtime-1',
    agentRunId: runId,
    toolUseId: 'tool-1',
    abortSignal: new AbortController().signal,
    messages: [],
  }
}

describe('Skill availability Run integration', () => {
  it('刷新失败的新 Run 只注入最小 Prompt header，read 返回 skill_not_ready', async () => {
    const fetchMap = vi.fn()
      .mockResolvedValueOnce({ [SKILL.canonicalKey]: true })
      .mockRejectedValueOnce(new Error('offline'))
    const store = new SkillsStore(fetchMap)
    const cap = new SkillsCap({
      beginRun: (ctx) => store.beginRun(ctx.runId, 'agent-1', {
        catalog: { registrySkills: [SKILL] },
      }),
      endRun: (ctx) => store.endRun(ctx.runId),
      getSkill: (key, ctx) => {
        const resolution = store.peekRun(ctx?.agentRunId)?.resolve(key)
        if (!resolution) return { status: 'not_ready', retryable: true }
        return resolution.status === 'available'
          ? resolution
          : {
              status: resolution.status,
              ...(resolution.status === 'not_ready' ? { retryable: true as const } : {}),
            }
      },
      search: (_query, _options, ctx) => {
        const snapshot = store.peekRun(ctx?.agentRunId)
        return snapshot?.enabledMap
          ? [...snapshot.availableSkills]
          : { status: 'not_ready', retryable: true }
      },
      fetchSkills: async ({ runId }) => {
        const snapshot = store.peekRun(runId)
        if (!snapshot?.enabledMap) {
          return {
            staticIndex: renderSkillNames([], { budgetChars: 8_000 }),
            dynamicTopK: null,
          }
        }
        return {
          staticIndex: snapshot.availableSkills.map(skill => skill.canonicalKey).join('\n'),
          dynamicTopK: null,
        }
      },
    })
    const hooks = cap.hooks()!
    const read = cap.tools().find(tool => tool.name === 'skills_read')!

    const availableState = { messages: [] } as unknown as EngineState
    await hooks.beforeRun!({ ...makeRunCtx(availableState), runId: 'run-available' })
    const availablePrompt = makeBeforeModelCtx(availableState)
    await hooks.beforeModel!(availablePrompt)
    expect(sectionContent(
      availablePrompt.sections,
      SYSTEM_SECTION_NAMES.skills_index,
    )).toContain(SKILL.canonicalKey)
    await expect(read.execute(
      { key: SKILL.canonicalKey },
      toolContext('run-available'),
    )).resolves.toMatchObject({ content: SKILL.content })

    store.enablement.forAgent('agent-1').invalidate()
    const offlineState = { messages: [] } as unknown as EngineState
    await hooks.beforeRun!({ ...makeRunCtx(offlineState), runId: 'run-offline' })
    const offlinePrompt = makeBeforeModelCtx(offlineState)
    await hooks.beforeModel!(offlinePrompt)
    expect(sectionContent(
      offlinePrompt.sections,
      SYSTEM_SECTION_NAMES.skills_index,
    )).toContain('以下列表是你所携带的技能')
    expect(sectionContent(
      offlinePrompt.sections,
      SYSTEM_SECTION_NAMES.skills_index,
    )).not.toContain(SKILL.canonicalKey)

    const result = await read.execute(
      { key: SKILL.canonicalKey },
      toolContext('run-offline'),
    )
    expect(JSON.parse(result.content as string)).toMatchObject({
      success: false,
      error_kind: 'skill_not_ready',
      retryable: true,
    })
  })
})
