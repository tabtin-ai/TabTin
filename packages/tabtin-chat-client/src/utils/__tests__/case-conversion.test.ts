import { describe, expect, it } from 'vitest'
import {
  camelToSnakeKey,
  camelToSnakeObject,
  snakeToCamelKey,
  snakeToCamelObject,
} from '../case-conversion'

describe('snakeToCamelKey', () => {
  it('单段下划线转驼峰', () => {
    expect(snakeToCamelKey('artifact_id')).toBe('artifactId')
    expect(snakeToCamelKey('record_ids')).toBe('recordIds')
    expect(snakeToCamelKey('memo_id')).toBe('memoId')
  })

  it('多段下划线累积转驼峰', () => {
    expect(snakeToCamelKey('tracker_run_meta')).toBe('trackerRunMeta')
    expect(snakeToCamelKey('a_b_c_d')).toBe('aBCD')
  })

  it('无下划线原样返回', () => {
    expect(snakeToCamelKey('doc')).toBe('doc')
    expect(snakeToCamelKey('alreadyCamel')).toBe('alreadyCamel')
  })

  it('空串原样返回', () => {
    expect(snakeToCamelKey('')).toBe('')
  })

  it('连续下划线被合并为一段', () => {
    expect(snakeToCamelKey('a__b')).toBe('aB')
  })

  it('末尾下划线被忽略', () => {
    expect(snakeToCamelKey('artifact_')).toBe('artifact')
  })
})

describe('camelToSnakeKey', () => {
  it('camelCase 转下划线', () => {
    expect(camelToSnakeKey('artifactId')).toBe('artifact_id')
    expect(camelToSnakeKey('recordIds')).toBe('record_ids')
    expect(camelToSnakeKey('codePath')).toBe('code_path')
  })

  it('多大写字符各自插入下划线', () => {
    expect(camelToSnakeKey('trackerRunMeta')).toBe('tracker_run_meta')
  })

  it('无大写原样返回', () => {
    expect(camelToSnakeKey('doc')).toBe('doc')
    expect(camelToSnakeKey('already_snake')).toBe('already_snake')
  })

  it('空串原样返回', () => {
    expect(camelToSnakeKey('')).toBe('')
  })

  it('首字母大写(PascalCase)只小写化不加前导下划线', () => {
    expect(camelToSnakeKey('ArtifactId')).toBe('artifact_id')
  })
})

describe('snakeToCamelObject — TrackerRunMeta.artifact_ref schema 守护', () => {
  it('扁平 ArtifactRef schema 全字段转换', () => {
    // 对应 packages/tabtin-chat-client/src/types/session.ts artifact_ref 子对象
    // 与 apps/tabtin-electron/src/main/services/notification/types.ts ArtifactRef 同步
    const schemaInput = {
      artifact_id: 'art_001',
      memo_id: 'memo_42',
      record_ids: ['rec_a', 'rec_b'],
      doc_id: 'doc_99',
      slide_id: 'slide_1',
      code_path: '/repo/file.py',
    }

    const mapped = snakeToCamelObject(schemaInput)

    expect(mapped).toEqual({
      artifactId: 'art_001',
      memoId: 'memo_42',
      recordIds: ['rec_a', 'rec_b'],
      docId: 'doc_99',
      slideId: 'slide_1',
      codePath: '/repo/file.py',
    })
  })

  it('部分字段缺失时不引入 undefined 占位', () => {
    const partial = { memo_id: 'memo_x' }
    expect(snakeToCamelObject(partial)).toEqual({ memoId: 'memo_x' })
  })

  it('值原样保留(不递归值结构)', () => {
    const nested = {
      artifact_id: 'art_001',
      meta_payload: { nested_field: 'keep_as_is', list_value: [1, 2, 3] },
    }
    const mapped = snakeToCamelObject(nested)
    expect(mapped).toEqual({
      artifactId: 'art_001',
      // 值不递归——意图:边界只做扁平 schema,嵌套结构走对应 schema 类型
      metaPayload: { nested_field: 'keep_as_is', list_value: [1, 2, 3] },
    })
  })

  it('null / undefined / 数组输入安全降级原样返回', () => {
    expect(snakeToCamelObject(null as unknown as Record<string, unknown>)).toBe(null)
    expect(snakeToCamelObject(undefined as unknown as Record<string, unknown>)).toBe(
      undefined,
    )
    const arr = [{ artifact_id: 'x' }] as unknown as Record<string, unknown>
    // 数组直接原样返回(本工具不处理数组,调用方应该按对象边界 map)
    expect(snakeToCamelObject(arr)).toBe(arr)
  })
})

describe('camelToSnakeObject — recovery_actions / artifact_ref 反向场景', () => {
  it('扁平 ArtifactRef 反向转换', () => {
    // 模拟前端 main types(camelCase)→ chat-client schema(snake_case)
    const mainInput = {
      artifactId: 'art_001',
      memoId: 'memo_42',
      recordIds: ['rec_a'],
      docId: 'doc_99',
    }

    expect(camelToSnakeObject(mainInput)).toEqual({
      artifact_id: 'art_001',
      memo_id: 'memo_42',
      record_ids: ['rec_a'],
      doc_id: 'doc_99',
    })
  })

  it('RecoveryAction 顶层键反向转换(kind/label 等已是单词不变)', () => {
    // RecoveryAction 字段大多为单词,但模型字段 retryWithModel 是 camel
    const recoveryActionLike = {
      kind: 'retry_with_model',
      label: '换模型重试',
      modelId: 'gpt-4',
    }

    expect(camelToSnakeObject(recoveryActionLike)).toEqual({
      kind: 'retry_with_model', // 值不动,只动键
      label: '换模型重试',
      model_id: 'gpt-4',
    })
  })

  it('双向往返不丢精度(扁平场景)', () => {
    const original = {
      artifact_id: 'a',
      record_ids: ['r1'],
      memo_id: 'm',
    }
    const camelForm = snakeToCamelObject(original)
    const back = camelToSnakeObject(camelForm)
    expect(back).toEqual(original)
  })
})
