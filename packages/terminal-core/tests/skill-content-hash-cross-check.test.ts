/**
 * D11 Python ↔ TS 黄金对照测试。
 *
 * 在固定路径 ``/tmp/skill-cross-check/demo`` 下构造已知文件，验证 TS 端
 * `computeSkillContentHash` 输出与 Python 端 `compute_skill_content_hash`
 * 的输出完全一致。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import { computeSkillContentHash } from '../src/skill-content-hash'

const FIXTURE_DIR = '/tmp/skill-cross-check/demo'

beforeAll(async () => {
  if (existsSync(FIXTURE_DIR)) {
    await rm(FIXTURE_DIR, { recursive: true, force: true })
  }
  await mkdir(FIXTURE_DIR, { recursive: true })
  await writeFile(`${FIXTURE_DIR}/SKILL.md`, 'hello\nworld\n\n')
  await mkdir(`${FIXTURE_DIR}/scripts`)
  await writeFile(`${FIXTURE_DIR}/scripts/main.py`, "print('hi')\n")
})

describe('Python ↔ TS 字面对齐', () => {
  it('produces same hash as Python compute_skill_content_hash', async () => {
    const tsHash = await computeSkillContentHash(FIXTURE_DIR)
    // Python 端在相同 fixture 下产出（手工运行 python -c 验证过）
    // 注意：Python ``echo -e "hello\\nworld\\n"`` 实际写入 ``hello\nworld\n\n``
    // （换行 + 末尾 echo 自带的 newline）。TS 端 writeFile 写入相同字节序列
    // 才能字面对齐。
    expect(tsHash).toBe('8107a97e8a1ddf50b3622334a3d092db6d7865fdeea34e45812469b9d0320618')
  })
})
