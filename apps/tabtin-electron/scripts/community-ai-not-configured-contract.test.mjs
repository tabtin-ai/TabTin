import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const rendererRoot = new URL('../src/renderer/src/', import.meta.url)

function read(relativePath) {
  return readFileSync(new URL(relativePath, rendererRoot), 'utf8')
}

test('Community no-model copy points to the existing BYOK settings while SaaS copy stays unchanged', () => {
  const zh = JSON.parse(read('i18n/locales/zh-CN/chat.json'))
  const en = JSON.parse(read('i18n/locales/en-US/chat.json'))

  assert.match(zh.input.disabled_community_no_chat_model, /AI NOT CONFIGURED/)
  assert.match(zh.input.disabled_community_no_chat_model, /设置.*模型配置.*BYOK/)
  assert.match(zh.errors.communityModelNotConfigured, /AI NOT CONFIGURED/)
  assert.match(en.errors.communityModelNotConfigured, /AI NOT CONFIGURED/)
  assert.doesNotMatch(zh.errors.communityModelNotConfigured, /AdminDash/)
  assert.doesNotMatch(en.errors.communityModelNotConfigured, /AdminDash/)

  assert.match(zh.errors.modelNotConfigured, /AdminDash/)
  assert.match(en.errors.modelNotConfigured, /AdminDash/)
})

test('Community copy selection is edition-aware at every no-model surface', () => {
  const distribution = read('config/distribution.ts')
  assert.match(distribution, /VITE_DISTRIBUTION_KIND/)
  assert.match(distribution, /community_no_chat_model/)

  for (const file of [
    'stores/chat/messages/runtime/applyBlockedSubmissionFeedback.ts',
    'components/chat/hooks/useChatCallbacks.ts',
    'components/chat/panel/ChatContent.tsx',
    'components/chat/hooks/useChatPanelLifecycle.ts',
    'components/chat/hooks/useSessionScopedComposerModel.ts',
  ]) {
    assert.match(read(file), /isCommunityDistribution/, `${file} must use the Community boundary`)
  }
})
