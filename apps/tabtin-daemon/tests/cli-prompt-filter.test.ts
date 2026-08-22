import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  filterTemporarilyHiddenCliPromptReference,
  isTemporarilyHiddenCliPromptCommand,
} from '../src/application/agent/runtime/cli-prompt-filter.js';

const runtimeAssemblySource = readFileSync(
  resolve(__dirname, '../src/application/agent/runtime/daemon-runtime-assembly.ts'),
  'utf8',
);

describe('#5353 Daemon CLI prompt filter', () => {
  it.each([
    'site',
    'site deploy',
    'phone',
    'phone list',
    'video',
    'video gen',
    'media video',
    'media video generate',
    'memo',
    'memo list',
    'tabtin-demo-app',
    'tabtin-demo-app list',
  ])('hides unavailable command path %s', (commandPath) => {
    expect(isTemporarilyHiddenCliPromptCommand(commandPath)).toBe(true);
  });

  it.each([
    'media',
    'media image',
    'media image generate',
    'slide create',
    'files list',
  ])('retains available command path %s', (commandPath) => {
    expect(isTemporarilyHiddenCliPromptCommand(commandPath)).toBe(false);
  });

  it('filters forwarded CLI reference line by line', () => {
    const reference = [
      '- `tabtin site`: site management',
      '- `tabtin phone list`: list devices',
      '- `tabtin video gen`: create video',
      '- `tabtin media video generate`: create video',
      '- `tabtin media image generate`: create image',
      '- `tabtin slide create`: create slide',
      '- `tabtin memo list`: list memos',
      '- `tabtin files list`: list files',
    ].join('\n');

    expect(filterTemporarilyHiddenCliPromptReference(reference)).toBe([
      '- `tabtin media image generate`: create image',
      '- `tabtin slide create`: create slide',
      '- `tabtin files list`: list files',
    ].join('\n'));
  });

  it('applies the filter to forwarded and self-loaded references', () => {
    expect(runtimeAssemblySource).toContain(
      'filterTemporarilyHiddenCliPromptReference(\n      cliReference',
    );
    expect(runtimeAssemblySource).toContain(
      'if (isTemporarilyHiddenCliPromptCommand(path)) continue;',
    );
    expect(runtimeAssemblySource).toMatch(/\.then\(\(value\)\s*=>\s*filterTemporarilyHiddenCliPromptReference\(value \?\? undefined\)\)/);
    // 发现面自加载：不含 Hidden；risk map：含 --include-hidden
    expect(runtimeAssemblySource).toContain("['commands', '--format', 'json']");
    expect(runtimeAssemblySource).toContain(
      "['commands', '--format', 'json', '--include-hidden']",
    );
    expect(runtimeAssemblySource).toContain('parseTabtinCommandsJson(stdout)');
  });
});
