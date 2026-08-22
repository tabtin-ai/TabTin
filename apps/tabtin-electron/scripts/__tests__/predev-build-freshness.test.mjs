/**
 * predev-build 新鲜度判定回归测试
 *
 * 钉死「stat 指纹」判定：对 src 文件 (路径+size+mtime) 集合 + 配置 + 上游依赖指纹
 * 取哈希存进 .build-stamp，按「与上次记录不一致即重建」判定。重点覆盖旧 mtime
 * 「更晚」判定漏掉的 case：内容变化但 mtime 不更晚（git rebase/切分支的真实情形）。
 *
 * 零运行依赖：node:test + 临时 fixture，不触发真实包构建，可在 --no-install worktree 跑。
 *   node --test apps/tabtin-electron/scripts/__tests__/predev-build-freshness.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeFingerprint, isFresh, markBuilt } from '../predev-build.mjs';

function mkPkg(root, name, deps = []) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), `export const x = '${name}'\n`);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, main: 'dist/index.js', types: 'dist/index.d.ts' }),
  );
  // isFresh 的「产物存在性兜底」要求 manifest 声明的 dist 入口存在
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), '')
  fs.writeFileSync(path.join(dir, 'dist', 'index.d.ts'), '')
  void deps
  return dir;
}

function mkCtx(specs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'predev-fp-'));
  const nameToDir = new Map();
  const nameToManifest = new Map();
  const depMapFull = new Map();
  for (const [name, deps] of Object.entries(specs)) {
    const dir = mkPkg(root, name, deps);
    nameToDir.set(name, dir);
    nameToManifest.set(name, JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')));
    depMapFull.set(name, deps);
  }
  return { root, ctx: { nameToDir, nameToManifest, depMapFull } };
}

function setMtime(p, date) {
  fs.utimesSync(p, date, date);
}

test('markBuilt 后立即 isFresh = true（指纹一致）', () => {
  const { ctx } = mkCtx({ a: [] });
  markBuilt('a', ctx);
  assert.equal(isFresh('a', ctx), true);
});

test('内容变化但 mtime 设为更早，仍判 stale（修复  核心）', () => {
  const { ctx } = mkCtx({ a: [] });
  markBuilt('a', ctx);
  const src = path.join(ctx.nameToDir.get('a'), 'src', 'index.ts');
  // 模拟 git rebase/切分支：内容变了，但 mtime 落到过去（旧逻辑 src mtime «不晚于» stamp → 误判 fresh）
  fs.writeFileSync(src, 'export const x = "changed-but-older"\n');
  setMtime(src, new Date(Date.now() - 60 * 60 * 1000));
  assert.equal(isFresh('a', ctx), false);
});

test('新增 src 文件判 stale', () => {
  const { ctx } = mkCtx({ a: [] });
  markBuilt('a', ctx);
  fs.writeFileSync(path.join(ctx.nameToDir.get('a'), 'src', 'extra.ts'), 'export const y = 1\n');
  assert.equal(isFresh('a', ctx), false);
});

test('dist 入口缺失判 stale（产物存在性兜底）', () => {
  const { ctx } = mkCtx({ a: [] });
  markBuilt('a', ctx);
  fs.rmSync(path.join(ctx.nameToDir.get('a'), 'dist', 'index.js'));
  assert.equal(isFresh('a', ctx), false);
});

test('空 / 旧格式 stamp 判 stale（升级首跑触发一次重建）', () => {
  const { ctx } = mkCtx({ a: [] });
  fs.writeFileSync(path.join(ctx.nameToDir.get('a'), 'dist', '.build-stamp'), '');
  assert.equal(isFresh('a', ctx), false);
});

test('上游依赖重建会级联使下游 stale', () => {
  const { ctx } = mkCtx({ a: [], b: ['a'] });
  markBuilt('a', ctx);
  markBuilt('b', ctx);
  assert.equal(isFresh('b', ctx), true);

  // a 改源并重建 → a 的 stamp 指纹变化 → b 的指纹（含 a stamp）随之变化 → b stale
  fs.writeFileSync(path.join(ctx.nameToDir.get('a'), 'src', 'index.ts'), 'export const x = "a2"\n');
  markBuilt('a', ctx);
  assert.equal(isFresh('b', ctx), false);

  // b 重建后重新一致
  markBuilt('b', ctx);
  assert.equal(isFresh('b', ctx), true);
});

test('未变化时指纹稳定（幂等，warm restart 跳过）', () => {
  const { ctx } = mkCtx({ a: [] });
  markBuilt('a', ctx);
  const fp1 = computeFingerprint('a', ctx);
  const fp2 = computeFingerprint('a', ctx);
  assert.equal(fp1, fp2);
  assert.equal(isFresh('a', ctx), true);
});
