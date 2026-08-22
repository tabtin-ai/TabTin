import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { JsonExporter } from '../src/exporters/JsonExporter'
import { JsonImporter } from '../src/importers/JsonImporter'

describe('JSON required-field contract', () => {
  it('exports and imports columns as non-required', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tabtin-json-'))
    const filePath = join(directory, 'table.json')
    const data = {
      columns: [{ id: 'name', name: 'Name', type: 'text' as const, required: true }],
      rows: [{ id: 'row-1', data: { name: 'Ada' }, createdAt: '2026-01-01T00:00:00.000Z' }],
    }

    try {
      const exported = await new JsonExporter().export(data, {
        format: 'json',
        filePath,
        jsonStructure: 'table',
      })
      expect(exported.success).toBe(true)
      expect(JSON.parse(readFileSync(filePath, 'utf8')).columns[0].required).toBe(false)

      const imported = await new JsonImporter().import(filePath, { format: 'json' })
      expect(imported.success).toBe(true)
      expect(imported.data?.columns[0]?.required).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
