/**
 * storage-migration单测：legacy platform-data → dataRoot/users/...
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { migrateLegacyPlatformDataToDataRoot } from '../storage-migration.js'
import {
  resolveOrganizationSkillDir,
  resolveOrganizationSkillsDir,
  resolveWorkspaceSessionArchiveDir,
} from '../storage-paths.js'

describe('migrateLegacyPlatformDataToDataRoot', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tabtin-storage-mig-'))
  })

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true })
  })

  it('把 legacy space skills 迁到 organization skills，并幂等跳过已存在目标', async () => {
    const legacyRoot = path.join(tmpRoot, 'platform-data', 'organizations')
    const dataRoot = path.join(tmpRoot, 'data')
    const userId = 'user-1'
    const orgId = 'org-a'
    const spaceId = 'space-1'
    const skillSlug = 'demo-skill'

    const legacySkillDir = path.join(
      legacyRoot,
      orgId,
      'spaces',
      spaceId,
      'skills',
      skillSlug,
    )
    await fsp.mkdir(legacySkillDir, { recursive: true })
    await fsp.writeFile(path.join(legacySkillDir, 'SKILL.md'), '# demo\n', 'utf-8')

    const report1 = await migrateLegacyPlatformDataToDataRoot({
      dataRoot,
      legacyPlatformDataRoot: legacyRoot,
      userId,
      markMigrated: true,
    })
    expect(report1.movedSkills).toBe(1)
    expect(report1.errors).toEqual([])

    const dest = resolveOrganizationSkillDir(dataRoot, userId, orgId, skillSlug)
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true)

    // 再跑一次：源已标 .migrated，不再重复迁移
    const report2 = await migrateLegacyPlatformDataToDataRoot({
      dataRoot,
      legacyPlatformDataRoot: legacyRoot,
      userId,
      markMigrated: true,
    })
    expect(report2.movedSkills).toBe(0)
    expect(report2.skippedSkills).toBe(0)

    // 目标目录应只有一份
    const orgSkills = resolveOrganizationSkillsDir(dataRoot, userId, orgId)
    const entries = await fsp.readdir(orgSkills)
    expect(entries).toEqual([skillSlug])
  })

  it('conversations 目标已存在时仍合并 leftover sessions', async () => {
    const legacyRoot = path.join(tmpRoot, 'platform-data', 'organizations')
    const dataRoot = path.join(tmpRoot, 'data')
    const userId = 'user-1'
    const orgId = 'org-a'
    const spaceId = 'space-1'
    const legacySessions = path.join(
      legacyRoot,
      orgId,
      'spaces',
      spaceId,
      'conversations',
      'sessions',
    )
    const destSessions = resolveWorkspaceSessionArchiveDir(dataRoot, userId, orgId, spaceId)

    await fsp.mkdir(path.join(destSessions, 'already'), { recursive: true })
    await fsp.writeFile(path.join(destSessions, 'already', 'messages.jsonl'), 'old\n', 'utf-8')
    await fsp.mkdir(path.join(legacySessions, 'leftover'), { recursive: true })
    await fsp.writeFile(path.join(legacySessions, 'leftover', 'messages.jsonl'), 'new\n', 'utf-8')
    await fsp.writeFile(
      path.join(legacyRoot, orgId, 'spaces', spaceId, '.migrated'),
      'already',
      'utf-8',
    )

    const report = await migrateLegacyPlatformDataToDataRoot({
      dataRoot,
      legacyPlatformDataRoot: legacyRoot,
      userId,
      markMigrated: true,
    })
    expect(report.movedWorkspaceSubdirs).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(path.join(destSessions, 'leftover', 'messages.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(destSessions, 'already', 'messages.jsonl'))).toBe(true)
  })

  it('userId 缺失时跳过 skill 迁移并记 error', async () => {
    const legacyRoot = path.join(tmpRoot, 'platform-data', 'organizations')
    const dataRoot = path.join(tmpRoot, 'data')
    const skillDir = path.join(
      legacyRoot,
      'org-a',
      'spaces',
      'space-1',
      'skills',
      'demo',
    )
    await fsp.mkdir(skillDir, { recursive: true })
    await fsp.writeFile(path.join(skillDir, 'SKILL.md'), '# x\n', 'utf-8')

    const report = await migrateLegacyPlatformDataToDataRoot({
      dataRoot,
      legacyPlatformDataRoot: legacyRoot,
      userId: undefined,
    })
    expect(report.movedSkills).toBe(0)
    expect(report.errors.some((e) => e.includes('userId missing'))).toBe(true)
  })
})
