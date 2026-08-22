import type { CrawlspaceConfig } from '@stores/useCrawlTabStore'
import i18n from '@/i18n'

type WorkspaceDefaults = Pick<CrawlspaceConfig, 'profile' | 'runPrefix' | 'uiConfig'>

const DEFAULTS_BY_PLUGIN: Record<string, WorkspaceDefaults> = {
}

const DEFAULT_AGENT_WORKSPACE: WorkspaceDefaults = {
  profile: 'agent-workspace',
  runPrefix: 'agent',
  uiConfig: {
    enableMultiView: true,
    showToolbar: false,
    showPanel: true,
    showTabs: false,
    defaultTitle: '',
  },
}

const DEFAULT_TITLE_KEYS: Record<string, string> = {
}

const AGENT_WORKSPACE_TITLE_KEY = 'sidebar:actions.agentWorkspace'

export function getWorkspaceDefaults(pluginId: string): WorkspaceDefaults | null {
  const defaults = DEFAULTS_BY_PLUGIN[pluginId]
  if (!defaults) {
    return null
  }
  const titleKey = DEFAULT_TITLE_KEYS[pluginId]
  const resolvedTitle = titleKey ? i18n.t(titleKey) : defaults.uiConfig?.defaultTitle
  return {
    ...defaults,
    uiConfig: {
      ...defaults.uiConfig,
      defaultTitle: resolvedTitle,
    },
  }
}

export function getAgentWorkspaceDefaults(): WorkspaceDefaults {
  return {
    ...DEFAULT_AGENT_WORKSPACE,
    uiConfig: {
      ...DEFAULT_AGENT_WORKSPACE.uiConfig,
      defaultTitle: i18n.t(AGENT_WORKSPACE_TITLE_KEY),
    },
  }
}
