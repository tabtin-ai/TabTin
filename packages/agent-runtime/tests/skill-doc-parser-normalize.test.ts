/**
 * skill-doc-parser 归一化双读回归（Phase A frontmatter 标准对齐）。
 *
 * 关键不变量：`frontmatter.version` 必须归一化（metadata.version 优先，回退顶层），
 * 否则 skill-preinstaller.readSkillVersion 在 SKILL.md 迁移到新格式后会读不到版本，
 * sandbox 升级判定会全 skip。
 */
import { describe, it, expect } from 'vitest';
import { parseSkillDoc } from '../src/skills/skill-doc-parser.js';

const OPTS = { dirName: 'table-operator', docPath: '/x/table-operator/SKILL.md' };

const OLD_FORMAT = `---
name: Table Operator
description: 表格结构与数据操作
version: 0.4.0
tools:
  - run_terminal_command
---
# Table Operator
body`;

const NEW_FORMAT = `---
name: table-operator
description: 表格结构与数据操作
metadata:
  version: 0.4.0
  tabtin:
    displayName: Table Operator
    tools: [run_terminal_command]
---
# Table Operator
body`;

describe('parseSkillDoc 归一化双读', () => {
  it('旧格式：顶层 version / name=Title', () => {
    const r = parseSkillDoc(OLD_FORMAT, OPTS, () => {});
    expect(r).not.toBeNull();
    expect(r!.frontmatter.version).toBe('0.4.0');
    expect(r!.frontmatter.displayName).toBe('Table Operator');
    expect(r!.frontmatter.slug).toBe('table-operator');
    expect(r!.frontmatter.tools).toEqual(['run_terminal_command']);
  });

  it('新格式：metadata.version + metadata.tabtin.displayName/tools', () => {
    const r = parseSkillDoc(NEW_FORMAT, OPTS, () => {});
    expect(r).not.toBeNull();
    // 关键：version 归一化到 metadata.version，供 preinstaller 读取
    expect(r!.frontmatter.version).toBe('0.4.0');
    expect(r!.frontmatter.name).toBe('table-operator');
    expect(r!.frontmatter.displayName).toBe('Table Operator');
    expect(r!.frontmatter.tools).toEqual(['run_terminal_command']);
  });

  it('category：metadata.tabtin.category 提升到 frontmatter.category', () => {
    const md = `---
name: table-operator
description: d
metadata:
  version: 0.4.0
  tabtin:
    category: data
    displayName: Table Operator
---
body`;
    const r = parseSkillDoc(md, OPTS, () => {});
    expect(r!.frontmatter.category).toBe('data');
  });

  it('category：顶层 category 也读得到', () => {
    const md = `---
name: foo
description: d
category: developer
metadata:
  version: 1.0.0
---
body`;
    const r = parseSkillDoc(md, { dirName: 'foo', docPath: '/x/SKILL.md' }, () => {});
    expect(r!.frontmatter.category).toBe('developer');
  });

  it('category：缺失时为 undefined（旧格式无 category）', () => {
    const r = parseSkillDoc(OLD_FORMAT, OPTS, () => {});
    expect(r!.frontmatter.category).toBeUndefined();
  });

  it('kebab name 无 displayName → slug 美化兜底', () => {
    const md = `---
name: weekly-report
description: d
metadata:
  version: 1.0.0
---
body`;
    const r = parseSkillDoc(md, { dirName: 'weekly-report', docPath: '/x/SKILL.md' }, () => {});
    expect(r!.frontmatter.displayName).toBe('Weekly Report');
    expect(r!.frontmatter.version).toBe('1.0.0');
  });
});
