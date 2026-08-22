/**
 * 双端 parse byte-equal 守门测试。
 *
 * fixture 文件 `fixtures/parse-cross-lang.fixtures.json` 是 SSOT；
 * Python 镜像 `apps/tabtin_django/apps/services/common/resource_pointer.py`
 * 通过 pytest 读同一份 fixture 跑同样断言。
 *
 * 任一端产出与 fixture 不一致 = parser 行为发生分裂 = D5 双轨双向覆盖失守。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { parseResourcePointer } from '../src/parser.js'
import type { ResourcePointer } from '../src/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface FixtureCase {
  name: string
  uri: string
  expected: {
    scheme: string
    type: string | null
    id: string
    raw: string
    hint: string | null
    meta?: Record<string, unknown>
  }
}

interface FixtureFile {
  samples: FixtureCase[]
}

const fixtures: FixtureFile = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/parse-cross-lang.fixtures.json'), 'utf-8'),
)

describe('parseResourcePointer cross-lang fixtures', () => {
  it('has at least 30 samples (W2 北极星阈值)', () => {
    expect(fixtures.samples.length).toBeGreaterThanOrEqual(30)
  })

  for (const sample of fixtures.samples) {
    it(sample.name, () => {
      const got = parseResourcePointer(sample.uri)
      assertSamplesEqual(got, sample)
    })
  }
})

function assertSamplesEqual(got: ResourcePointer, sample: FixtureCase): void {
  expect(got.scheme).toBe(sample.expected.scheme)
  expect(got.type).toBe(sample.expected.type)
  expect(got.id).toBe(sample.expected.id)
  expect(got.raw).toBe(sample.expected.raw)
  expect(got.hint).toBe(sample.expected.hint)

  // meta 比对采用 normalize：未声明等价于无 meta；存在则比对结构
  const expectedMeta = sample.expected.meta
  if (expectedMeta === undefined) {
    expect(got.meta).toBeUndefined()
  } else {
    expect(got.meta).toEqual(expectedMeta)
  }
}
