/**
 * ：选中历史时「保存版本」应带 history_id，未选中则拍当前表。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const modalSourcePath = path.resolve(__dirname, '../TableHistoryModal.tsx')

describe('#8082 save named version from selected snapshot', () => {
  const source = fs.readFileSync(modalSourcePath, 'utf8')

  it('选中历史时 createTableNamedVersion 传入 history_id', () => {
    expect(source).toContain('history_id: activeGroupId')
    expect(source).toContain('saveVersionSnapshot')
    expect(source).toContain('saveVersionCurrent')
  })

  it('未选中时不强制 history_id（仅在 activeGroupId 存在时展开）', () => {
    expect(source).toMatch(/\.\.\.\(activeGroupId \? \{ history_id: activeGroupId \} : \{\}\)/)
  })
})
