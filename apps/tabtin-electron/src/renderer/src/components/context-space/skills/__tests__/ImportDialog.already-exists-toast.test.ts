import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('ImportDialog already_exists toast contract', () => {
  const source = readFileSync(
    resolve(__dirname, '../ImportDialog.tsx'),
    'utf8',
  )

  it('routes npm / url / single-folder reuse through toastImportOutcome', () => {
    expect(source).toContain("from './toastImportOutcome'")
    expect(source).toContain('toastImportOutcome(')
    expect(source).toContain('anyImportedAlreadyExists(importedResults)')
    expect(source).toContain('if (batch?.already_exists) anyAlreadyExists = true')
    // npm 不得再无脑 success(importSuccess)
    expect(source).not.toMatch(
      /importedResults\.length > 0\) \{\s*toast\.success\(t\('skills\.importSuccess'\)\)/,
    )
  })
})
