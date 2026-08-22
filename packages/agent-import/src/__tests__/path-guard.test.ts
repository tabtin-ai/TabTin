import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeImportIO } from '../io.js'
import { assertImportSourcePath, isForbiddenPath } from '../paths.js'

describe('isForbiddenPath', () => {
  it('拦截红线凭据文件', () => {
    expect(isForbiddenPath(`${os.homedir()}/.codex/auth.json`)).toBe(true)
    expect(isForbiddenPath(`${os.homedir()}/.cursor/cli-config.json`)).toBe(true)
    expect(
      isForbiddenPath(
        path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'Cookies'),
      ),
    ).toBe(true)
  })

  it('普通会话 jsonl 不拦', () => {
    expect(isForbiddenPath(`${os.homedir()}/.codex/sessions/rollout.jsonl`)).toBe(false)
  })
})

describe('assertImportSourcePath', () => {
  const io = new NodeImportIO()
  const tmpFiles: string[] = []

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fs.rmSync(f, { force: true })
      } catch {
        /* ignore */
      }
    }
    tmpFiles.length = 0
  })

  it('拒绝 /tmp 下伪造路径（审阅复现）', () => {
    const probe = path.join(os.tmpdir(), `pr7801-private-${process.pid}.jsonl`)
    fs.writeFileSync(probe, '{"content":"PRIVATE-PROBE-CONTENT"}\n', 'utf8')
    tmpFiles.push(probe)
    expect(() => assertImportSourcePath(io, 'codex', probe)).toThrow(/白名单根目录/)
  })

  it('拒绝红线路径', () => {
    expect(() =>
      assertImportSourcePath(io, 'codex', path.join(os.homedir(), '.codex', 'auth.json')),
    ).toThrow(/红线/)
  })

  it('接受落在 codex 根下的路径', () => {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
    const inside = path.join(codexHome, 'sessions', 'ok.jsonl')
    // 文件不必真实存在：assert 用 resolve 回退
    expect(() => assertImportSourcePath(io, 'codex', inside)).not.toThrow()
  })
})
