import { resolveProjectTaskRuntimeContext } from '@tabtin/agent-host/hooks'

interface ProjectTaskAppContext {
  appType?: string | null
  appMeta?: Record<string, unknown> | null
}

const TABTIN_PROJECT_SKILL_KEY = 'app:tabtin-project/tabtin-project'

/** Prompt-only visibility policy; skill tools remain registered normally. */
export function shouldInjectProjectTaskSkill(
  skillKey: string,
  appContext: ProjectTaskAppContext | null | undefined,
): boolean {
  if (skillKey !== TABTIN_PROJECT_SKILL_KEY) return true
  return resolveProjectTaskRuntimeContext(appContext) !== null
}
