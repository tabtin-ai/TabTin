import { describe, it, expect } from 'vitest'
import * as ts from 'typescript'
import { readFileSync } from 'fs'
import { join } from 'path'

const PRELOAD_PATH = join(__dirname, '../../../preload/index.ts')

function getTabtinApiTypeSource(): string {
  return readFileSync(PRELOAD_PATH, 'utf-8')
}

describe('TL-008: preload TabtinAPI type consistency', () => {
  const source = getTabtinApiTypeSource()

  it('auth interface must NOT declare getRefreshToken (removed in SS-31)', () => {
    const authBlock = extractInterfaceBlock(source, 'auth')
    expect(authBlock).not.toContain('getRefreshToken')
  })

  it('auth interface must declare refreshAccessToken', () => {
    const authBlock = extractInterfaceBlock(source, 'auth')
    expect(authBlock).toContain('refreshAccessToken')
  })

  it('onWriteTable callback data must include organizationId', () => {
    const tinsBlock = extractInterfaceBlock(source, 'tins')
    const onWriteTableLine = tinsBlock
      .split('\n')
      .find((l) => l.includes('onWriteTable'))
    expect(onWriteTableLine).toBeDefined()
    expect(onWriteTableLine).toContain('organizationId')
  })

  it('preload implementation must NOT expose getRefreshToken', () => {
    const implBlock = extractImplementationBlock(source)
    const authImplLines = extractNestedBlock(implBlock, 'auth:')
    expect(authImplLines).not.toContain('getRefreshToken')
    expect(authImplLines).not.toContain("auth:getRefreshToken")
  })
})

function extractInterfaceBlock(src: string, fieldName: string): string {
  const regex = new RegExp(`${fieldName}:\\s*\\{`)
  const match = regex.exec(src)
  if (!match) return ''
  let depth = 0
  let start = match.index + match[0].length - 1
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    if (src[i] === '}') depth--
    if (depth === 0) return src.slice(start, i + 1)
  }
  return ''
}

function extractImplementationBlock(src: string): string {
  const marker = 'contextBridge.exposeInMainWorld'
  const idx = src.indexOf(marker)
  if (idx < 0) return src
  return src.slice(idx)
}

function extractNestedBlock(src: string, marker: string): string {
  const idx = src.indexOf(marker)
  if (idx < 0) return ''
  const start = Math.max(0, idx - 200)
  const end = Math.min(src.length, idx + 800)
  return src.slice(start, end)
}
