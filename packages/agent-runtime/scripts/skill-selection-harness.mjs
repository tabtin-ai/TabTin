#!/usr/bin/env node
/**
 * skill 选择 live harness
 *
 * 目的：用**真实 SKILL.md 语料** + **真实编译产物**（dist/skills/skill-budget.js）
 * 验证「相关性打分 + 分级曝光」在真实数据上的表现，无需重启 Electron / 调 LLM。
 *
 * 走的是 Electron 主进程实际加载的同一份 dist 代码路径（truncateSkillsWithinBudget），
 * 只是把选择逻辑单独驱动出来、打印真实 `<skills>` 段，便于肉眼与断言核对。
 *
 * 复跑：
 *   node packages/agent-runtime/scripts/skill-selection-harness.mjs
 * 前置：先构建 agent-runtime（tsc）确保 dist 最新。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** 递归找出目录下所有 SKILL.md 绝对路径。 */
function findSkillMd(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findSkillMd(abs));
    else if (e.name === 'SKILL.md') out.push(abs);
  }
  return out;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '../..');

// 走真实 live 渲染路径：Electron / Daemon 都调 LocalSkillRegistry.render()，
// 内部用 renderSkillNames（静态段）+ renderRelevantTopK（动态段）。
const { renderSkillNames, renderRelevantTopK } = await import(
  path.join(pkgRoot, 'dist/skills/skill-renderer.js')
);

/** 极简 frontmatter 解析：取 name / description（支持 `>-` 折叠多行）。 */
function parseFrontmatter(text, fallbackName) {
  let name = fallbackName;
  let description = '';
  const body = text.replace(/^\uFEFF/, '');
  if (!body.startsWith('---')) return { name, description };
  const end = body.indexOf('\n---', 3);
  if (end < 0) return { name, description };
  const front = body.slice(3, end);
  const lines = front.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val === '>-' || val === '>' || val === '|' || val === '|-') {
      // 折叠块：收集后续缩进行
      const parts = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+\S/.test(lines[j])) parts.push(lines[j].trim());
        else break;
      }
      val = parts.join(' ');
    }
    if (key === 'name') name = val || fallbackName;
    else description = val;
  }
  return { name, description };
}

function loadSkills() {
  const roots = [
    path.join(repoRoot, 'packages/skills'),
    path.join(repoRoot, '.cursor/skills'),
    path.join(process.env.HOME ?? '', '.agents/skills'),
  ];
  const abses = roots.flatMap((r) => findSkillMd(r));
  const seenKey = new Set();
  const skills = [];
  let dropped = 0;
  for (const abs of abses) {
    const dirName = path.basename(path.dirname(abs));
    const { name, description } = parseFrontmatter(
      readFileSync(abs, 'utf-8'),
      dirName,
    );
    if (!description) {
      dropped++;
      continue;
    }
    // 用「祖父目录/父目录」保证 key 唯一（避免 operations 等重名塌缩）。
    const grand = path.basename(path.dirname(path.dirname(abs)));
    let key = `user:${grand}-${dirName}`;
    let n = 1;
    while (seenKey.has(key)) key = `user:${grand}-${dirName}-${n++}`;
    seenKey.add(key);
    // 构造 LocalSkill 形态（全部按 user 组，走组内相关性排序）。
    skills.push({
      canonicalKey: key,
      source: 'user',
      metaSource: 'user',
      slug: `${grand}-${dirName}`,
      name,
      description,
      docPath: abs,
      realpath: abs,
      content: `# ${name}\n${description}`,
      rootKind: 'space',
      indexedAt: 0,
    });
  }
  if (dropped) console.log(`（解析丢弃 ${dropped} 个无 description 的 SKILL.md）`);
  return skills;
}

/** 取 key，按出现顺序。兼容两种格式：列表 `- key`（静态段）与 Markdown 表 `| key |...`（动态段）。 */
function orderedKeys(rendered) {
  const keys = [];
  for (const line of rendered.split('\n')) {
    if (line.startsWith('- ')) {
      const key = line.slice(2).trim();
      if (key.includes(':')) keys.push(key);
    } else if (line.startsWith('| ') && !line.startsWith('| key ') && !line.startsWith('| ---')) {
      const key = line.split('|').slice(1, -1)[0]?.trim();
      if (key && key.includes(':')) keys.push(key);
    }
  }
  return keys;
}

const skills = loadSkills();
console.log(`\n加载真实 skill 语料：${skills.length} 个（全部按 user 组）\n`);

const BUDGET = 8_000; // 与 host 一致

// 静态段：全部名称索引（query 无关、跨轮稳定 → 可缓存）。整场只算一次。
const staticIndex = renderSkillNames(skills, { budgetChars: BUDGET });
const staticKeys = orderedKeys(staticIndex || '');
console.log('【静态段 · 名称索引（进 BP2 缓存，跨轮不变）】');
console.log(`  共 ${staticKeys.length} 个名称，前 6：${staticKeys.slice(0, 6).join(', ')}`);
console.log('');

const queries = [
  '帮我把表格里的数据导出',
  '给这个同事发一封邮件',
  '查一下我明天的日程安排',
  '把这段代码做一次 code review',
  'kubernetes 集群部署排查', // 预期：与技能语料弱相关 / 无信号
];

console.log('【动态段 · Top-8 相关性带描述（每轮随 query 变）】');
for (const q of queries) {
  // renderRelevantTopK 已异步化（ 双路召回）；harness 不注入 scorer，走词法单路。
  const dyn = await renderRelevantTopK(skills, q, BUDGET);
  console.log('════════════════════════════════════════════════════════');
  console.log(`QUERY: 「${q}」`);
  if (!dyn) {
    console.log('  （无词法信号 → 不注入动态段，仅靠静态名称索引）');
  } else {
    console.log(`  Top: ${orderedKeys(dyn).join(', ')}`);
  }
}
console.log('');
