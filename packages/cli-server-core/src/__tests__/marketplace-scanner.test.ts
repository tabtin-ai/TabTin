import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { scanMarketplaceManifests } from '../marketplace-scanner.js'

describe('scanMarketplaceManifests', () => {
  let root = ''

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  function writeApp(id: string, manifest: Record<string, unknown>) {
    if (!root) root = mkdtempSync(join(tmpdir(), 'mkt-scan-'))
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'app.json'), JSON.stringify(manifest), 'utf8')
  }

  it('#5353 skips marketplace apps with hasPromptSection=false', () => {
    writeApp('tabtin-demo-app', {
      id: 'tabtin-demo-app',
      distribution: 'marketplace',
      agentIntegration: { hasPromptSection: false },
      cli: { binary: 'tabtin-demo-app' },
      cliGrammar: {
        rules: [
          { pattern: 'tabtin-demo-issue.list', risk_level: 'safe', reason: 'list' },
        ],
      },
    })
    writeApp('cowart', {
      id: 'cowart',
      distribution: 'marketplace',
      agentIntegration: { hasPromptSection: true },
      cli: { binary: 'cowart' },
      cliGrammar: {
        rules: [
          { pattern: 'cowart.ping', risk_level: 'safe', reason: 'ping' },
        ],
      },
    })

    const cmds = scanMarketplaceManifests(root)
    expect(cmds.map((c) => c.extension_id)).toEqual(['cowart'])
    expect(cmds.some((c) => c.extension_id === 'tabtin-demo-app')).toBe(false)
  })
})
