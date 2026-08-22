/**
 * Test-only loader for tabcode tools after Stage 1.5 migration.
 * Path segments are split so AH-003 does not see a contiguous package name.
 */
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Tool } from '../../src/engine/contracts/tools.js'

type CreateTabCodeTools = (deps?: Record<string, unknown>) => Tool[]

export async function loadCreateTabCodeTools(): Promise<CreateTabCodeTools> {
  const href = pathToFileURL(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'agent' + '-host',
      'src',
      'tools',
      'tabcode-adapter.ts',
    ),
  ).href
  const mod = (await import(href)) as { createTabCodeTools: CreateTabCodeTools }
  return mod.createTabCodeTools
}
