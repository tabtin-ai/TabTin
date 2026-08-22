#!/usr/bin/env node
'use strict';

/**
 * prepack 门禁：skills/manifest.json 必须存在，公开名均以 tabtin- 开头且唯一。
 */
const fs = require('node:fs');
const path = require('node:path');

const skillsDir = path.join(__dirname, '..', 'skills');
const manifestPath = path.join(skillsDir, 'manifest.json');

function die(msg) {
  process.stderr.write(`[check-skills-bundle] ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(manifestPath)) {
  die(`缺少 ${manifestPath}；请先 node scripts/generate-skills-bundle.cjs`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!manifest.bundle_version || !manifest.cli_version) {
  die('manifest 缺少 bundle_version / cli_version');
}
if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
  die('manifest.skills 为空');
}

const seen = new Set();
for (const s of manifest.skills) {
  if (!s.name || !s.name.startsWith('tabtin-')) {
    die(`公开名必须以 tabtin- 开头: ${JSON.stringify(s.name)}`);
  }
  if (seen.has(s.name)) die(`重复公开名: ${s.name}`);
  seen.add(s.name);
  if (!s.content_sha256 || !s.canonical_name) {
    die(`skill ${s.name} 缺少 content_sha256 / canonical_name`);
  }
  const dir = path.join(skillsDir, s.name);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
    die(`缺少 ${s.name}/SKILL.md`);
  }
  const bins = s.requires && s.requires.bins;
  if (!Array.isArray(bins) || !bins.includes('tabtin')) {
    die(`skill ${s.name} requires.bins 必须包含 tabtin`);
  }
}

if (manifest.skill_count !== manifest.skills.length) {
  die(`skill_count=${manifest.skill_count} 与 skills.length=${manifest.skills.length} 不一致`);
}

process.stdout.write(
  `[check-skills-bundle] ok: ${manifest.skills.length} skills, bundle_version=${manifest.bundle_version}\n`,
);
