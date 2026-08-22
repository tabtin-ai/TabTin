/**
 * @tabtin/tool-errors registry contracts.
 *
 * Locks: stable TOOL_LAYER_ERROR_KINDS order/uniqueness, catalog default
 * coverage, i18n key inventory, bridges, and codegen:verify freshness.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  TOOL_LAYER_ERROR_KINDS,
  TOOL_ERROR_CATALOG_DEFAULTS,
  TOOL_ERROR_I18N_KEYS,
  BROWSER_TO_RUNTIME_ERROR_KIND,
  bridgeBrowserErrorCodeToRuntimeKind,
  MISSING_REQUIRED_PARAM,
  NETWORK_FAILED,
  SPAWN_FAILURE,
  OLD_STRING_NOT_FOUND,
  REQUIRES_CLIENT_APPROVAL,
  ALREADY_PENDING,
} from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '../..');
const REPO_ROOT = resolve(PKG_ROOT, '../..');

/** Historical TOOL_ERROR_KINDS prefix (file-pipeline kinds appended by agent-runtime). */
const EXPECTED_TOOL_LAYER_KINDS = [
  'missing_required_param',
  'invalid_param_format',
  'param_too_large',
  'mutually_exclusive_params',
  'no_ui_session',
  'runtime_misconfig',
  'host_unsupported',
  'network_failed',
  'request_timeout',
  'auth_failed',
  'permission_denied',
  'resource_not_found',
  'document_not_ready',
  'rate_limited',
  'upstream_error',
  'skill_unsupported_prefix',
  'skill_not_found',
  'skill_disabled',
  'skill_not_ready',
  'skill_not_installed',
  'version_conflict',
  'tool_stale_read',
  'old_string_not_found',
  'old_string_not_unique',
  'command_blocked_by_policy',
  'command_denied_by_validator',
  'mode_restricted',
  'cwd_not_found',
  'spawn_failure',
  'os_access_error',
  'widget_render_failed',
  'internal_error',
  'requires_client_approval',
  'already_pending',
  'todo_list_already_open',
  'todo_list_not_open',
  'todo_item_frozen',
  'todo_invalid_items',
] as const;

describe('@tabtin/tool-errors registry', () => {
  it('TOOL_LAYER_ERROR_KINDS matches historical order, no duplicates', () => {
    expect([...TOOL_LAYER_ERROR_KINDS]).toEqual([...EXPECTED_TOOL_LAYER_KINDS]);
    expect(new Set(TOOL_LAYER_ERROR_KINDS).size).toBe(TOOL_LAYER_ERROR_KINDS.length);
    expect(MISSING_REQUIRED_PARAM).toBe('missing_required_param');
    expect(NETWORK_FAILED).toBe('network_failed');
  });

  it('does not embed file-pipeline-specific kinds (re-export merge stays in agent-runtime)', () => {
    const filePipelineSpecific = [
      'file_not_found',
      'file_too_large',
      'encrypted',
      'corrupted',
      'scanned_pdf',
      'garbled_text_layer',
      'unsupported_format',
      'parse_timeout',
      'image_resize_failed',
    ];
    for (const kind of filePipelineSpecific) {
      expect(TOOL_LAYER_ERROR_KINDS).not.toContain(kind);
    }
    // Catalog defaults DO cover file-pipeline specific kinds for Electron.
    for (const kind of filePipelineSpecific) {
      expect(
        TOOL_ERROR_CATALOG_DEFAULTS[kind],
        `missing catalog default for file-pipeline kind ${kind}`,
      ).toBeDefined();
      expect(TOOL_ERROR_CATALOG_DEFAULTS[kind].translatable).toBe(true);
    }
  });

  it('catalog defaults cover every tool-layer kind; prior catalog-miss kinds stay non-translatable', () => {
    for (const kind of TOOL_LAYER_ERROR_KINDS) {
      expect(
        TOOL_ERROR_CATALOG_DEFAULTS[kind],
        `missing catalog default for ${kind}`,
      ).toBeDefined();
    }
    // Preserve pre-Wave-2 helper fallbacks for kinds that were absent from catalog.
    expect(TOOL_ERROR_CATALOG_DEFAULTS[SPAWN_FAILURE].translatable).toBe(false);
    expect(TOOL_ERROR_CATALOG_DEFAULTS[OLD_STRING_NOT_FOUND].translatable).toBe(false);
    expect(TOOL_ERROR_CATALOG_DEFAULTS.old_string_not_unique.translatable).toBe(false);
  });

  it('catalogs mode-switch flow errors as soft non-anomalous fallbacks', () => {
    expect(REQUIRES_CLIENT_APPROVAL).toBe('requires_client_approval');
    expect(ALREADY_PENDING).toBe('already_pending');
    for (const kind of [REQUIRES_CLIENT_APPROVAL, ALREADY_PENDING]) {
      expect(TOOL_ERROR_CATALOG_DEFAULTS[kind]).toMatchObject({
        soft: true,
        translatable: false,
        countsAsAnomaly: false,
        userInitiated: false,
      });
    }
  });

  it('runtime top-level kinds have catalog defaults', () => {
    for (const kind of [
      'budget_skipped',
      'aborted',
      'aborted_by_user',
      'tool_timeout',
      'execute_error',
      'unknown_tool',
      'schema_invalid',
      'validate_input',
      'plan_guard_deny',
      'permission_denied',
    ]) {
      expect(TOOL_ERROR_CATALOG_DEFAULTS[kind], `missing ${kind}`).toBeDefined();
    }
  });

  it('i18n key inventory covers translatable defaults; Electron locales have those keys', () => {
    expect(TOOL_ERROR_I18N_KEYS.length).toBeGreaterThan(10);
    expect(TOOL_ERROR_I18N_KEYS).toContain('network_failed');
    expect(TOOL_ERROR_I18N_KEYS).toContain('aborted');
    // Alias key itself is not a separate i18n entry requirement.
    expect(TOOL_ERROR_I18N_KEYS).not.toContain('aborted_by_user');
    // Non-translatable kinds excluded.
    expect(TOOL_ERROR_I18N_KEYS).not.toContain('spawn_failure');
    expect(TOOL_ERROR_I18N_KEYS).not.toContain('unknown_tool');

    for (const locale of ['zh-CN', 'en-US']) {
      const chatPath = resolve(
        REPO_ROOT,
        `apps/tabtin-electron/src/renderer/src/i18n/locales/${locale}/chat.json`,
      );
      const chat = JSON.parse(readFileSync(chatPath, 'utf-8')) as {
        toolError: Record<string, string>;
      };
      for (const key of TOOL_ERROR_I18N_KEYS) {
        expect(
          chat.toolError[key],
          `${locale}/chat.json missing toolError.${key}`,
        ).toBeTruthy();
      }
    }
  });

  it('bridges express browser → runtime kinds without unifying network_error/network_failed', () => {
    expect(BROWSER_TO_RUNTIME_ERROR_KIND.network_error).toBe('network_failed');
    expect(BROWSER_TO_RUNTIME_ERROR_KIND.invalid_parameter).toBe('invalid_param_format');
    expect(BROWSER_TO_RUNTIME_ERROR_KIND.timeout).toBe('request_timeout');
    expect(BROWSER_TO_RUNTIME_ERROR_KIND.stale_read).toBe('tool_stale_read');
    expect(bridgeBrowserErrorCodeToRuntimeKind('network_error')).toBe('network_failed');
    expect(bridgeBrowserErrorCodeToRuntimeKind('not_a_real_code')).toBeUndefined();
    // Literals remain distinct — bridge does not collapse the from-side key away.
    expect(Object.keys(BROWSER_TO_RUNTIME_ERROR_KIND)).toContain('network_error');
    expect(Object.values(BROWSER_TO_RUNTIME_ERROR_KIND)).toContain('network_failed');
  });

  it('codegen:verify fails when a generated file is stale', () => {
    const target = resolve(PKG_ROOT, 'src/_generated/kinds.generated.ts');
    const backup = `${target}.bak-verify`;
    copyFileSync(target, backup);
    try {
      writeFileSync(target, `${readFileSync(target, 'utf-8')}\n// stale\n`, 'utf-8');
      expect(() =>
        execFileSync('pnpm', ['exec', 'tsx', 'codegen/generate.ts', '--verify'], {
          cwd: PKG_ROOT,
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).toThrow();
    } finally {
      copyFileSync(backup, target);
      unlinkSync(backup);
    }
  });

  it('codegen:verify passes on clean generated tree', () => {
    const output = execFileSync('pnpm', ['exec', 'tsx', 'codegen/generate.ts', '--verify'], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
    });
    expect(output).toContain('[codegen:verify] Clean');
  });
});
