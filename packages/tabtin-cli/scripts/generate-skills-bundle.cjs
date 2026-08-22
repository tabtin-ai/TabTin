#!/usr/bin/env node
/**
 * 确定性 Skill bundle 生成器。
 *
 * 从 packages/apps 与 packages/skills 收集 SKILL.md，生成前缀化外部副本到
 * packages/tabtin-cli/skills/，并写出 manifest.json。
 *
 * 外部名：tabtin-<canonical name>；内部 canonical 不变。
 * 导出字段（requires.bins / cliHelp / runtime）只写在副本与 manifest，不改源文件。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_DIR = __dirname;
const PKG_DIR = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const OUT_DIR = path.join(PKG_DIR, 'skills');
const BUNDLE_VERSION = '1';

const LOCAL_CATEGORIES = new Set([
  'web',
  'browser',
  'desktop',
  'terminal',
  'phone',
  'device',
]);
const CLOUD_CATEGORIES = new Set([
  'doc',
  'data',
  'table',
  'drive',
  'storage',
  'collaboration',
]);

const CATEGORY_CLI_DOMAIN = {
  doc: 'doc',
  data: 'table',
  table: 'table',
  web: 'browser',
  browser: 'browser',
  desktop: 'desktop',
  terminal: 'terminal',
  phone: 'phone',
  device: 'device',
  drive: 'drive',
  storage: 'drive',
  collaboration: 'skill',
  code: 'code',
  memo: 'memo',
  slide: 'slide',
  video: 'video',
  media: 'media',
  design: 'design',
};

function die(msg) {
  process.stderr.write(`[generate-skills-bundle] ${msg}\n`);
  process.exit(1);
}

function readPackageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  return pkg.version || '0.0.0';
}

function listSkillRoots() {
  const roots = [];
  const appsDir = path.join(REPO_ROOT, 'packages', 'apps');
  if (!fs.existsSync(appsDir)) die(`missing ${appsDir}`);

  for (const app of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const skillsRoot = path.join(appsDir, app.name, 'skills');
    if (!fs.existsSync(skillsRoot)) continue;
    collectSkillDirs(skillsRoot, roots);
  }

  const platformSkills = path.join(REPO_ROOT, 'packages', 'skills');
  if (fs.existsSync(platformSkills)) {
    collectSkillDirs(platformSkills, roots);
  }

  roots.sort((a, b) => a.localeCompare(b));
  return roots;
}

/** 递归找含 SKILL.md 的目录（skill 根）。 */
function collectSkillDirs(dir, out) {
  const skillMd = path.join(dir, 'SKILL.md');
  if (fs.existsSync(skillMd) && fs.statSync(skillMd).isFile()) {
    out.push(dir);
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    collectSkillDirs(path.join(dir, ent.name), out);
  }
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { fm: {}, body: text, rawFm: '' };
  }
  const nl = text.startsWith('---\r\n') ? '\r\n' : '\n';
  const end = text.indexOf(`${nl}---${nl}`, 4);
  if (end < 0) {
    return { fm: {}, body: text, rawFm: '' };
  }
  const rawFm = text.slice(4, end);
  const body = text.slice(end + `${nl}---${nl}`.length);
  return { fm: parseSimpleYaml(rawFm), body, rawFm };
}

/** 够用的 frontmatter 解析：标量 + 单层 metadata.tabtin / 数组。 */
function parseSimpleYaml(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    i += 1;
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (trimmed.startsWith('- ')) {
      // 当前父应是数组；若刚开键值为 null，转数组
      continue;
    }

    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();

    if (value === '>' || value === '|') {
      const collected = [];
      while (i < lines.length) {
        const next = lines[i];
        const nextIndent = next.match(/^ */)[0].length;
        if (next.trim() === '' || nextIndent > indent) {
          collected.push(next.trim());
          i += 1;
          continue;
        }
        break;
      }
      parent[key] = collected.filter(Boolean).join(' ');
      continue;
    }

    if (value === '') {
      // 看下一非空行判断 map / list
      let j = i;
      while (j < lines.length && !lines[j].trim()) j += 1;
      if (j < lines.length) {
        const next = lines[j];
        const nextIndent = next.match(/^ */)[0].length;
        if (nextIndent > indent && next.trim().startsWith('- ')) {
          const arr = [];
          while (i < lines.length) {
            const l = lines[i];
            if (!l.trim()) {
              i += 1;
              continue;
            }
            const ind = l.match(/^ */)[0].length;
            if (ind <= indent) break;
            const t = l.trim();
            if (t.startsWith('- ')) {
              arr.push(stripQuotes(t.slice(2).trim()));
              i += 1;
              continue;
            }
            break;
          }
          parent[key] = arr;
          continue;
        }
        if (nextIndent > indent) {
          const child = {};
          parent[key] = child;
          stack.push({ indent, obj: child });
          continue;
        }
      }
      parent[key] = '';
      continue;
    }

    parent[key] = stripQuotes(value);
  }

  return root;
}

function stripQuotes(s) {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function externalName(canonical) {
  if (canonical.startsWith('tabtin-')) return canonical;
  return `tabtin-${canonical}`;
}

function inferRuntime(category, autoActivateFor) {
  const cat = String(category || '').toLowerCase();
  if (LOCAL_CATEGORIES.has(cat)) return 'local';
  if (CLOUD_CATEGORIES.has(cat)) return 'cloud';
  const apps = Array.isArray(autoActivateFor) ? autoActivateFor : [];
  for (const a of apps) {
    const x = String(a).toLowerCase();
    if (
      x.includes('web') ||
      x.includes('browser') ||
      x.includes('desktop') ||
      x.includes('terminal') ||
      x.includes('phone')
    ) {
      return 'local';
    }
  }
  return 'hybrid';
}

function inferCliDomain(category, autoActivateFor) {
  const cat = String(category || '').toLowerCase();
  if (CATEGORY_CLI_DOMAIN[cat]) return CATEGORY_CLI_DOMAIN[cat];
  const apps = Array.isArray(autoActivateFor) ? autoActivateFor : [];
  for (const a of apps) {
    const x = String(a).toLowerCase().replace(/^tab/, '');
    if (CATEGORY_CLI_DOMAIN[x]) return CATEGORY_CLI_DOMAIN[x];
    if (x === 'tabdoc' || x === 'doc') return 'doc';
    if (x === 'tabdata' || x === 'data') return 'table';
    if (x === 'tabweb') return 'browser';
  }
  return '';
}

function hashDir(dir) {
  const hash = crypto.createHash('sha256');
  const files = [];
  walkFiles(dir, files);
  files.sort();
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function walkFiles(dir, out, prefix = '') {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.DS_Store' || ent.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      walkFiles(path.join(dir, ent.name), out, rel);
    } else if (ent.isFile()) {
      out.push(rel.replace(/\\/g, '/'));
    }
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.DS_Store' || ent.name === 'node_modules') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rewriteSkillMd(text, extName, runtime, cliDomain) {
  const { fm, body, rawFm } = parseFrontmatter(text);
  if (!rawFm) die('SKILL.md missing frontmatter');

  const canonical = String(fm.name || '').trim();
  if (!canonical) die('SKILL.md missing name');

  // 保留原 frontmatter 结构，只替换 name，并追加导出 metadata 块到 frontmatter 末尾
  let newFm = rawFm.replace(
    /^name:\s*.+$/m,
    `name: ${extName}`,
  );

  // 注入/覆盖导出字段：在 metadata: 下追加 requires / cliHelp / runtime
  // 若无 metadata，追加整块
  const exportBlock = [
    '  # --- tabtin export (generated; do not edit source) ---',
    `  runtime: ${runtime}`,
    '  requires:',
    '    bins:',
    '      - tabtin',
    cliDomain
      ? `  cliHelp: "tabtin commands ${cliDomain} --format json"`
      : '  cliHelp: "tabtin commands --format json"',
    `  canonicalName: ${canonical}`,
  ].join('\n');

  if (/^metadata:\s*$/m.test(newFm) || /^metadata:/m.test(newFm)) {
    // 插到 metadata 块末尾（文件 frontmatter 结束前）
    newFm = `${newFm.trimEnd()}\n${exportBlock}\n`;
  } else {
    newFm = `${newFm.trimEnd()}\nmetadata:\n${exportBlock}\n`;
  }

  return `---\n${newFm.trimEnd()}\n---\n${body}`;
}

function validateRelativeRefs(skillDir, extName) {
  const errors = [];
  const files = [];
  walkFiles(skillDir, files);
  for (const rel of files) {
    if (!rel.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(skillDir, rel), 'utf8');
    const re = /\]\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(text))) {
      const href = m[1].trim();
      if (
        !href ||
        href.startsWith('http') ||
        href.startsWith('tabtin://') ||
        href.startsWith('mailto:') ||
        href.startsWith('file:') ||
        href.startsWith('#')
      ) {
        continue;
      }
      // 示例占位（如 markdown 表格里的 `url`）不是真实相对路径
      if (!href.includes('/') && !href.includes('.')) {
        continue;
      }
      if (href.startsWith('../')) {
        // 跨 skill：要求指向另一个 tabtin-* 或可解析路径；仅警告式记入（生成器硬失败仅路径穿越）
        if (href.includes('..') && href.split('/').filter((p) => p === '..').length > 2) {
          errors.push(`${extName}/${rel}: suspicious relative ref ${href}`);
        }
        continue;
      }
      const target = path.resolve(path.dirname(path.join(skillDir, rel)), href.split('#')[0]);
      const root = path.resolve(skillDir);
      if (!target.startsWith(root + path.sep) && target !== root) {
        errors.push(`${extName}/${rel}: path escape ${href}`);
        continue;
      }
      if (!fs.existsSync(target)) {
        errors.push(`${extName}/${rel}: missing ref ${href}`);
      }
    }
  }
  return errors;
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function main() {
  const cliVersion = readPackageVersion();
  const skillDirs = listSkillRoots();
  if (skillDirs.length === 0) die('no SKILL.md found');

  const staging = path.join(PKG_DIR, '.skills-staging');
  rmrf(staging);
  fs.mkdirSync(staging, { recursive: true });

  const byExternal = new Map();
  const manifestSkills = [];
  const refErrors = [];

  for (const srcDir of skillDirs) {
    const skillMdPath = path.join(srcDir, 'SKILL.md');
    const text = fs.readFileSync(skillMdPath, 'utf8');
    const { fm } = parseFrontmatter(text);
    const canonical = String(fm.name || '').trim();
    if (!canonical) die(`missing name in ${skillMdPath}`);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(canonical)) {
      die(`invalid skill name ${canonical} in ${skillMdPath}`);
    }

    const ext = externalName(canonical);
    if (byExternal.has(ext)) {
      die(`duplicate external name ${ext}:\n  ${byExternal.get(ext)}\n  ${srcDir}`);
    }
    byExternal.set(ext, srcDir);

    const tabtin = (fm.metadata && fm.metadata.tabtin) || {};
    const category = tabtin.category || '';
    const autoActivateFor = tabtin.autoActivateFor || [];
    const version = (fm.metadata && fm.metadata.version) || tabtin.version || '0.0.0';
    const description = String(fm.description || '').trim();
    const runtime = inferRuntime(category, autoActivateFor);
    const cliDomain = inferCliDomain(category, autoActivateFor);

    const destDir = path.join(staging, ext);
    copyDir(srcDir, destDir);
    const rewritten = rewriteSkillMd(text, ext, runtime, cliDomain);
    fs.writeFileSync(path.join(destDir, 'SKILL.md'), rewritten, 'utf8');

    refErrors.push(...validateRelativeRefs(destDir, ext));

    const contentSha = hashDir(destDir);
    const relSource = path.relative(REPO_ROOT, srcDir).replace(/\\/g, '/');

    manifestSkills.push({
      name: ext,
      canonical_name: canonical,
      description,
      version: String(version),
      source: relSource,
      content_sha256: contentSha,
      runtime,
      requires: { bins: ['tabtin'] },
      cli_help: cliDomain
        ? `tabtin commands ${cliDomain} --format json`
        : 'tabtin commands --format json',
      cli_domain: cliDomain || null,
      category: category || null,
      auto_activate_for: Array.isArray(autoActivateFor) ? autoActivateFor : [],
    });
  }

  // sibling：同 category 或共享 autoActivateFor
  const byCategory = new Map();
  const byApp = new Map();
  for (const s of manifestSkills) {
    if (s.category) {
      if (!byCategory.has(s.category)) byCategory.set(s.category, []);
      byCategory.get(s.category).push(s.name);
    }
    for (const a of s.auto_activate_for || []) {
      if (!byApp.has(a)) byApp.set(a, []);
      byApp.get(a).push(s.name);
    }
  }
  for (const s of manifestSkills) {
    const sib = new Set();
    for (const n of byCategory.get(s.category) || []) {
      if (n !== s.name) sib.add(n);
    }
    for (const a of s.auto_activate_for || []) {
      for (const n of byApp.get(a) || []) {
        if (n !== s.name) sib.add(n);
      }
    }
    s.siblings = [...sib].sort();
  }

  manifestSkills.sort((a, b) => a.name.localeCompare(b.name));

  if (refErrors.length > 0) {
    // 相对引用缺失在存量 skill 里可能存在——只对 path escape 硬失败
    const hard = refErrors.filter((e) => e.includes('path escape'));
    for (const e of refErrors) {
      process.stderr.write(`[generate-skills-bundle] warn: ${e}\n`);
    }
    if (hard.length > 0) die(`path escape in bundle:\n${hard.join('\n')}`);
  }

  const manifest = {
    bundle_version: BUNDLE_VERSION,
    cli_version: cliVersion,
    skill_count: manifestSkills.length,
    generated_at: new Date().toISOString(),
    skills: manifestSkills,
  };

  fs.writeFileSync(
    path.join(staging, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  // 原子替换 OUT_DIR
  const backup = `${OUT_DIR}.bak-${process.pid}`;
  if (fs.existsSync(OUT_DIR)) {
    rmrf(backup);
    fs.renameSync(OUT_DIR, backup);
  }
  fs.renameSync(staging, OUT_DIR);
  rmrf(backup);

  process.stdout.write(
    `[generate-skills-bundle] wrote ${manifestSkills.length} skills → ${OUT_DIR}\n`,
  );
}

main();
