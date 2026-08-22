/**
 * getMonacoLanguage 映射回归 — 防 TabFolder / TabCode / TextFileEditor 语言回退
 */
import { describe, it, expect } from 'vitest'
import { getMonacoLanguage } from '@components/shared/file-utils'

describe('getMonacoLanguage', () => {
  it.each([
    ['script.py', 'python'],
    ['module.ts', 'typescript'],
    ['app.tsx', 'typescript'],
    ['Makefile', 'makefile'],
    ['.env.local', 'ini'],
    ['config.yaml', 'yaml'],
    ['docker-compose.yml', 'yaml'],
    ['README', 'plaintext'],
    ['notes.txt', 'plaintext'],
    ['package.json', 'json'],
    ['styles.scss', 'scss'],
    ['index.html', 'html'],
    ['query.sql', 'sql'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
  ])('%s → %s', (filename, expected) => {
    expect(getMonacoLanguage(filename)).toBe(expected)
  })

  it('无扩展名文件名回退 plaintext', () => {
    expect(getMonacoLanguage('LICENSE')).toBe('plaintext')
  })

  it('.env 前缀文件映射 ini', () => {
    expect(getMonacoLanguage('.env')).toBe('ini')
    expect(getMonacoLanguage('.env.production')).toBe('ini')
  })
})
