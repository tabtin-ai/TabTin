import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TEMPLATES_ROOT = path.resolve(
  __dirname,
  '../../../../../packages/tabsite-templates',
);
const TEMPLATE_NAMES = ['blank', 'dashboard'];

describe('tabsite-templates vite config', () => {
  for (const name of TEMPLATE_NAMES) {
    const configPath = path.join(TEMPLATES_ROOT, name, 'vite.config.ts');

    describe(`${name}/vite.config.ts`, () => {
      it('exists', () => {
        expect(fs.existsSync(configPath)).toBe(true);
      });

      it('uses relative base path for OSS subpath deployment (DU-002)', () => {
        const content = fs.readFileSync(configPath, 'utf-8');
        expect(content).toContain("base: './'");
      });

      it('explicitly sets build.outDir to align with CLI --output default (DU-014)', () => {
        const content = fs.readFileSync(configPath, 'utf-8');
        expect(content).toContain("outDir: 'dist'");
      });
    });
  }
});

describe('tabsite-templates dist treated as build artifact (DU-003)', () => {
  for (const name of TEMPLATE_NAMES) {
    it(`${name}/dist/ 如本地存在，必须只是构建产物目录`, () => {
      const distDir = path.join(TEMPLATES_ROOT, name, 'dist');
      if (fs.existsSync(distDir)) {
        expect(fs.statSync(distDir).isDirectory()).toBe(true);
      }
    });

    it(`${name}/.gitignore should exclude dist/`, () => {
      const gitignorePath = path.join(TEMPLATES_ROOT, name, '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('dist/');
    });
  }
});
