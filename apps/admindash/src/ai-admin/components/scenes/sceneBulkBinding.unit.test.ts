import { describe, expect, it } from 'vitest'
import type { SceneItem } from '../../api/scenes'
import {
  areAllGroupsConfigured,
  buildBulkBindingUpdates,
  buildBulkCandidateSceneKeys,
  getInitialModelByDomain,
  groupSelectedScenes,
  toggleSceneSelection,
  toggleVisibleSceneSelection,
} from './sceneBulkBinding'

function scene(
  sceneKey: string,
  capabilityDomain: string,
  options: { isSystem?: boolean } = {}
): SceneItem {
  return {
    scene_key: sceneKey,
    display_name: sceneKey,
    description: '',
    capability_domain: capabilityDomain,
    capability_requirements: {},
    is_system: options.isSystem ?? false,
    binding: null,
    capability_validation: 'unsatisfied',
    last_call_at: null,
  }
}

describe('场景批量换绑选择', () => {
  const chatScene = scene('chat-scene', 'chat')
  const visionScene = scene('vision-scene', 'vision')
  const hiddenScene = scene('hidden-scene', 'chat')
  const systemScene = scene('system-scene', 'chat', { isSystem: true })

  it('将混合选择按能力类型分组并忽略系统场景', () => {
    const groups = groupSelectedScenes(
      [chatScene, visionScene, systemScene],
      new Set(['chat-scene', 'vision-scene', 'system-scene'])
    )

    expect(groups).toEqual([
      { capabilityDomain: 'chat', scenes: [chatScene] },
      { capabilityDomain: 'vision', scenes: [visionScene] },
    ])
  })

  it('全选和取消全选只改变当前可见的非系统场景', () => {
    const selected = new Set(['hidden-scene'])

    const selectedAll = toggleVisibleSceneSelection(
      selected,
      [chatScene, visionScene, systemScene],
      true
    )
    expect([...selectedAll]).toEqual(['hidden-scene', 'chat-scene', 'vision-scene'])

    const clearedVisible = toggleVisibleSceneSelection(
      selectedAll,
      [chatScene, visionScene, systemScene],
      false
    )
    expect([...clearedVisible]).toEqual(['hidden-scene'])
  })

  it('单行选择不会选中系统场景', () => {
    expect([...toggleSceneSelection(new Set(), chatScene)]).toEqual(['chat-scene'])
    expect([...toggleSceneSelection(new Set(), systemScene)]).toEqual([])
  })

  it('每个场景映射本能力组模型且不携带其它绑定字段', () => {
    const updates = buildBulkBindingUpdates(
      [
        { capabilityDomain: 'chat', scenes: [chatScene, hiddenScene] },
        { capabilityDomain: 'vision', scenes: [visionScene] },
      ],
      { chat: 'chat-model-id', vision: 'vision-model-id' }
    )

    expect(updates).toEqual([
      { scene_key: 'chat-scene', primary_model_id: 'chat-model-id' },
      { scene_key: 'hidden-scene', primary_model_id: 'chat-model-id' },
      { scene_key: 'vision-scene', primary_model_id: 'vision-model-id' },
    ])
  })

  it('候选模型查询包含每个能力组内的所有已选场景', () => {
    const sceneKeys = buildBulkCandidateSceneKeys([
      { capabilityDomain: 'chat', scenes: [chatScene, hiddenScene] },
      { capabilityDomain: 'vision', scenes: [visionScene] },
    ])

    expect(sceneKeys).toEqual(['chat-scene', 'hidden-scene', 'vision-scene'])
  })

  it('仅在同组场景当前模型一致时预填并要求每组都选择模型', () => {
    const sharedModel = {
      id: 'shared-model',
      display_name: 'Shared Model',
      model_name: 'shared-model',
    }
    const sharedBinding = {
      id: 'binding-id',
      scene_key: 'chat-scene',
      primary_model: sharedModel,
      fallback_models: [],
      default_params: {},
      timeout_sec: null,
      created_at: null,
      updated_at: null,
    }
    const firstChat = { ...chatScene, binding: sharedBinding }
    const secondChat = {
      ...hiddenScene,
      binding: {
        ...sharedBinding,
        id: 'another-binding-id',
        scene_key: 'hidden-scene',
        primary_model: { ...sharedModel, id: 'another-model' },
      },
    }
    const groups = [
      { capabilityDomain: 'chat', scenes: [firstChat, secondChat] },
      { capabilityDomain: 'vision', scenes: [visionScene] },
    ]

    expect(getInitialModelByDomain(groups)).toEqual({ chat: '', vision: '' })
    expect(areAllGroupsConfigured(groups, { chat: 'chat-model', vision: '' })).toBe(false)
    expect(areAllGroupsConfigured(groups, { chat: 'chat-model', vision: 'vision-model' })).toBe(
      true
    )
  })
})
