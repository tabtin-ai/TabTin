import { getApiClient } from '@/api/tabtin-client'

export interface PromptItem {
  scene_key: string
  bundle_path: string
  capability_domain: string
  has_system_md: boolean
  has_user_template: boolean
  system_char_count: number
  template_variables: string[]
}

export const promptsApi = {
  async list(): Promise<{ prompts: PromptItem[]; total: number }> {
    return getApiClient().raw('GET', '/services/llm/admin/prompts')
  },

  async detail(sceneKey: string) {
    return getApiClient().raw('GET', `/services/llm/admin/prompts/${sceneKey}`)
  },
}
