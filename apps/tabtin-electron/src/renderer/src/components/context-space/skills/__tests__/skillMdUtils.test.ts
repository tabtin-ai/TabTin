import { describe, it, expect } from 'vitest'
import {
  parseSkillMd,
  generateSkillSkeleton,
  stripSkillMdFileVersion,
  ensureSkillMdDescription,
  ensureSkillMdName,
  applySkillDisplayNameToSkillMd,
} from '../skillMdUtils'

const OLD_FORMAT = `---
name: Table Operator
description: 表格结构与数据操作
version: 0.4.0
---

# Table Operator

body
`

const NEW_FORMAT = `---
name: table-operator
description: 表格结构与数据操作
metadata:
  version: 0.4.0
  tabtin:
    displayName: Table Operator
    category: productivity
---

# Table Operator

body
`

describe('parseSkillMd 归一化双读', () => {
  it('旧格式：顶层 name=Title / version', () => {
    const r = parseSkillMd(OLD_FORMAT)
    expect(r.name).toBe('Table Operator')
    expect(r.displayName).toBe('Table Operator')
    expect(r.version).toBe('0.4.0')
    expect(r.description).toBe('表格结构与数据操作')
    expect(r.body.startsWith('# Table Operator')).toBe(true)
  })

  it('新格式：name=kebab / metadata.version / metadata.tabtin.displayName', () => {
    const r = parseSkillMd(NEW_FORMAT)
    expect(r.name).toBe('table-operator')
    expect(r.displayName).toBe('Table Operator')
    expect(r.version).toBe('0.4.0')
    expect(r.description).toBe('表格结构与数据操作')
  })

  it('新旧格式归一化结果一致（display/version）', () => {
    const oldP = parseSkillMd(OLD_FORMAT)
    const newP = parseSkillMd(NEW_FORMAT)
    expect(newP.displayName).toBe(oldP.displayName)
    expect(newP.version).toBe(oldP.version)
  })

  it('kebab name 无 displayName → slug 美化兜底', () => {
    const md = `---
name: weekly-report
description: d
metadata:
  version: 1.0.0
---
body`
    const r = parseSkillMd(md)
    expect(r.name).toBe('weekly-report')
    expect(r.displayName).toBe('Weekly Report')
    expect(r.version).toBe('1.0.0')
  })

  it('无 frontmatter', () => {
    const r = parseSkillMd('just body')
    expect(r.name).toBe('')
    expect(r.displayName).toBe('')
    expect(r.version).toBe('')
    expect(r.body).toBe('just body')
  })
})

describe('generateSkillSkeleton 新标准格式', () => {
  it('输出 metadata 命名空间 + name=slug + displayName，不写文件级版本', () => {
    const md = generateSkillSkeleton('Table Operator', '做表格', 'productivity', 'table-operator')
    expect(md).toContain('name: table-operator')
    expect(md).toContain('metadata:')
    expect(md).toContain('    displayName: "Table Operator"')
    expect(md).toContain('    category: productivity')
    expect(md).toContain('# Table Operator')
    expect(md).not.toContain('version:')
  })

  it('缺省 slug 时按展示名归一化', () => {
    const md = generateSkillSkeleton('My Weekly Report', 'd')
    expect(md).toContain('name: my-weekly-report')
    const parsed = parseSkillMd(md)
    expect(parsed.name).toBe('my-weekly-report')
    expect(parsed.displayName).toBe('My Weekly Report')
  })

  it('往返解析得到归一化字段', () => {
    const md = generateSkillSkeleton('Table Operator', '做表格', 'productivity', 'table-operator')
    const parsed = parseSkillMd(md)
    expect(parsed.name).toBe('table-operator')
    expect(parsed.displayName).toBe('Table Operator')
    expect(parsed.version).toBe('')
  })
})

describe('stripSkillMdFileVersion', () => {
  it('移除顶层 version 和 metadata.version，但保留 metadata.tabtin', () => {
    const cleaned = stripSkillMdFileVersion(`---
name: demo
description: Demo
version: 0.0.1-draft
metadata:
  version: 1.2.3
  tabtin:
    displayName: Demo
    category: productivity
---

# Demo
`)

    expect(cleaned).toContain('metadata:')
    expect(cleaned).toContain('  tabtin:')
    expect(cleaned).toContain('    displayName: Demo')
    expect(cleaned).not.toContain('version:')
    expect(cleaned).toContain('# Demo')
  })

  it('没有 frontmatter 时保持原文', () => {
    expect(stripSkillMdFileVersion('# Demo\n')).toBe('# Demo\n')
  })
})

describe('ensureSkillMdDescription', () => {
  it('空 description 时用 displayName 兜底', () => {
    const raw = `---
name: weekly-report
description: ""
metadata:
  tabtin:
    displayName: "Weekly Report"
---

# Weekly Report
`
    const fixed = ensureSkillMdDescription(raw)
    expect(parseSkillMd(fixed).description).toBe('Weekly Report')
  })
})

describe('ensureSkillMdName', () => {
  it('把顶层 name 改成唯一 slug，保留正文与其它 frontmatter', () => {
    const raw = `---
name: algorithmic-art
description: art
license: MIT
---

# Art
`
    const fixed = ensureSkillMdName(raw, 'algorithmic-art-2')
    expect(parseSkillMd(fixed).name).toBe('algorithmic-art-2')
    expect(fixed).toContain('description: art')
    expect(fixed).toContain('license: MIT')
    expect(fixed).toContain('# Art')
  })

  it('非法 slug 时保持原文', () => {
    const raw = '---\nname: demo\ndescription: d\n---\n'
    expect(ensureSkillMdName(raw, 'Bad Name')).toBe(raw)
  })
})

describe('applySkillDisplayNameToSkillMd', () => {
  it('同步 displayName / 同名 description / 首个 H1；纯中文不改机器 name', () => {
    const raw = `---
name: skill-test-update-name
description: "技能测试修改名称"
metadata:
  tabtin:
    displayName: "技能测试修改名称"
    category: writing
---

# 技能测试修改名称

## 什么时候用这个 Skill
`
    const next = applySkillDisplayNameToSkillMd(raw, '新技能名称')
    const parsed = parseSkillMd(next)
    expect(parsed.name).toBe('skill-test-update-name')
    expect(parsed.displayName).toBe('新技能名称')
    expect(parsed.description).toBe('新技能名称')
    expect(next).toContain('# 新技能名称')
    expect(next).toContain('## 什么时候用这个 Skill')
    expect(next).toContain('category: writing')
  })

  it('英文名可同步机器 name；自定义 description 不被覆盖', () => {
    const raw = `---
name: demo-skill
description: "这是自定义说明"
metadata:
  tabtin:
    displayName: "Demo Skill"
---

# Demo Skill
`
    const next = applySkillDisplayNameToSkillMd(raw, 'Renamed Skill')
    const parsed = parseSkillMd(next)
    expect(parsed.displayName).toBe('Renamed Skill')
    expect(parsed.description).toBe('这是自定义说明')
    expect(parsed.name).toBe('renamed-skill')
    expect(next).toContain('# Renamed Skill')
  })
})
