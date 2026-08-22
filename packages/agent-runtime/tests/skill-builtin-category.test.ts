/**
 * 内置 Skill 分类落地回归（Skills 重构 · 分类展示）。
 *
 * 不变量：每个内置 SKILL.md 都能被 Phase A 解析器（parseSkillDoc）解析出
 * `frontmatter.category`，且该值落在 10 类合法枚举内 —— 等价于 renderer 的
 * `normalizeSkillCategory` 返回非 null，即详情页分类 badge 会显示。
 *
 * 防回归点：新增内置 Skill 忘填 `metadata.tabtin.category`，或填了枚举外的值，
 * 这个测试会直接失败。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillDoc } from '../src/skills/skill-doc-parser.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
// tests/ → agent-runtime/ → packages/ → repo root
const REPO_ROOT = join(TEST_DIR, '..', '..', '..');

/**
 * 合法分类枚举（27 类）。必须与以下两处 SSoT 保持同步：
 * - renderer: apps/tabtin-electron/.../skills/skillCategory.ts (SKILL_MARKET_CATEGORIES)
 * - backend:  apps/tabtin_django/apps/skills/services/skill_service.py (VALID_SKILL_CATEGORIES)
 *
 * 说明：分类枚举从早期 10 类扩到 27 类（消费类 17 + 能力域 10），renderer 与
 * backend 两处 SSoT 均已同步扩容，但本测试的镜像枚举漏更新——内置 Skill 用了
 * analysis / automation / workflow / knowledge / marketing 等扩容后的合法分类时
 * `normalizeCategory` 会误判为 null。此处补齐到 27 类与两处 SSoT 对齐。
 */
const VALID_CATEGORIES = new Set([
  // 消费类（通用组）
  'productivity', 'writing', 'research', 'analysis', 'project_management',
  'sales_crm', 'customer_support', 'education', 'finance', 'hr', 'legal',
  'marketing', 'design', 'developer', 'ai_media', 'lifestyle', 'other',
  // 能力域组
  'data', 'doc', 'web', 'media', 'device', 'collaboration', 'workflow',
  'knowledge', 'communication', 'automation',
]);

/** 复刻 renderer normalizeSkillCategory 的判定（trim + lowercase + 枚举成员）。 */
function normalizeCategory(value: unknown): string | null {
  const normalized = (typeof value === 'string' ? value : '').trim().toLowerCase();
  if (!normalized) return null;
  return VALID_CATEGORIES.has(normalized) ? normalized : null;
}

/** 递归收集目录下所有 SKILL.md（跳过 node_modules / dist）。 */
function walkSkillMd(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSkillMd(full, out);
    } else if (entry === 'SKILL.md') {
      out.push(full);
    }
  }
}

/** 发现全部内置 Skill 的 SKILL.md（对齐 Glob：apps/<app>/skills、bundled/platform、tabtracker、spacelayout）。 */
function discoverBuiltinSkillMd(): string[] {
  const out: string[] = [];

  // 1. App skills: packages/apps/<app>/skills/**
  const appsDir = join(REPO_ROOT, 'packages', 'apps');
  if (existsSync(appsDir)) {
    for (const app of readdirSync(appsDir)) {
      walkSkillMd(join(appsDir, app, 'skills'), out);
    }
  }

  // 2. Bundled platform skills
  walkSkillMd(join(REPO_ROOT, 'packages', 'skills', 'bundled', 'platform'), out);

  // 3. packages/skills 直挂的内置（tabtracker）
  walkSkillMd(join(REPO_ROOT, 'packages', 'skills', 'tabtracker'), out);

  // 4. spacelayout（infrastructure）
  walkSkillMd(
    join(REPO_ROOT, 'packages', 'infrastructure', 'spacelayout', 'skills'),
    out,
  );

  return out.sort();
}

describe('内置 Skill 分类落地（badge 可显示）', () => {
  const skillFiles = discoverBuiltinSkillMd();

  it('发现到内置 Skill（>= 27）', () => {
    expect(skillFiles.length).toBeGreaterThanOrEqual(27);
  });

  it.each(skillFiles)('%s 能解析出合法 category（normalize 非 null）', (file) => {
    const raw = readFileSync(file, 'utf-8');
    const dirName = basename(dirname(file));
    const parsed = parseSkillDoc(raw, { dirName, docPath: file }, () => {});

    // 解析必须成功（半成品 / frontmatter 坏会返回 null）
    expect(parsed, `${file} 解析失败（frontmatter 坏或缺 description）`).not.toBeNull();

    const category = parsed!.frontmatter.category;
    expect(
      category,
      `${file} 缺少 metadata.tabtin.category —— badge 不会显示`,
    ).toBeTruthy();

    // 等价 renderer normalizeSkillCategory：必须返回非 null
    expect(
      normalizeCategory(category),
      `${file} 的 category="${category}" 不在 10 类合法枚举内`,
    ).not.toBeNull();
  });
});
