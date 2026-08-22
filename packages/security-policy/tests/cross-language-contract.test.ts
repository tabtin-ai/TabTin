/**
 * Cross-language device action contract consistency test
 *
 * Reads the embedded SSoT from `src/cross-platform-permission-contract.ts`
 * and grep-asserts the 3 enforcement sites (Django / iOS / Android) match.
 *
 * Originally introduced in W A0.4 with 4 SSoT participants (TS / iOS /
 * Android / Django). After security-policy v1 retirement (commit
 * 3478d8972 — `presets.ts` + `rules/device-rules.ts` deleted), TS no
 * longer maintains the device permission matrix; the SSoT is now the
 * embedded contract module + grep verification across the 3 runtime
 * enforcement sites. See module docstring for design rationale.
 *
 * Locked entries (see {@link AUTHORITATIVE_ACTION_PERMISSION_MAPPING}):
 *   1. screen_force_stop_app → force_stop_app  (W A0.4)
 *   2. get_system_setting    → device_info     (#L55(c1))
 *   3. screen_wait_for_idle  → screen_capture  (#L55(c2))
 *   4. screen_wait_for_element → screen_capture (#L55(c2))
 *
 * Research source:
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  AUTHORITATIVE_ACTION_PERMISSION_MAPPING,
  AUTHORITATIVE_ACTION_MAPPING_NOTES,
  AUTHORITATIVE_DJANGO_PRESET_VALUES,
  ENFORCEMENT_SITES,
  type EnforcementSite,
} from '../src/cross-platform-permission-contract';

const TEST_DIR = new URL('.', import.meta.url).pathname;
/** Repository root: this file is under `packages/security-policy/tests/` (3 levels up). */
const REPO_ROOT = resolve(TEST_DIR, '../../..');

interface ExtractedMapping {
  raw: string;
  /** Permission value (text-side extracted) for each action in the contract. */
  mappings: Record<string, string | null>;
}

/**
 * Find `<actionLiteral>(:|to)\s*<value>` in source.
 *  - colon-double: Swift / Python — `"action": "value"`
 *  - kotlin-to:    Kotlin — `"action" to "value"`
 */
function extractActionMapping(
  raw: string,
  action: string,
  syntax: 'colon-double' | 'kotlin-to',
): string | null {
  const sep = syntax === 'kotlin-to' ? /\s+to\s+/ : /\s*:\s*/;
  const pattern = new RegExp(
    `"${action}"${sep.source}"([\\w_]+)"`,
    'm',
  );
  const m = raw.match(pattern);
  return m ? m[1] : null;
}

async function loadFile(end: EnforcementSite): Promise<ExtractedMapping> {
  const raw = await readFile(resolve(REPO_ROOT, ENFORCEMENT_SITES[end]), 'utf-8');
  const syntax: 'colon-double' | 'kotlin-to' =
    end === 'android' ? 'kotlin-to' : 'colon-double';
  const mappings: Record<string, string | null> = {};
  for (const action of Object.keys(AUTHORITATIVE_ACTION_PERMISSION_MAPPING)) {
    mappings[action] = extractActionMapping(raw, action, syntax);
  }
  return { raw, mappings };
}

interface DjangoPresetExtraction {
  cautious: string | null;
  collaborative: string | null;
  full_auto: string | null;
  server_auto: string | null;
}

function extractDjangoPresetValues(
  raw: string,
  permissionKey: string,
): DjangoPresetExtraction {
  const result: DjangoPresetExtraction = {
    cautious: null,
    collaborative: null,
    full_auto: null,
    server_auto: null,
  };

  for (const preset of Object.keys(result) as (keyof DjangoPresetExtraction)[]) {
    const blockPattern = new RegExp(
      `"${preset}"[\\s\\S]+?device_permissions"[\\s\\S]+?"${permissionKey}"\\s*:\\s*"(\\w+)"`,
      'm',
    );
    const m = raw.match(blockPattern);
    result[preset] = m ? m[1] : null;
  }
  return result;
}

describe('Cross-language device action contract', () => {
  let extracted: Record<EnforcementSite, ExtractedMapping>;

  beforeAll(async () => {
    extracted = {
      django: await loadFile('django'),
      ios: await loadFile('ios'),
      android: await loadFile('android'),
    };
  });

  describe('iOS / Android mapping consistency (drift on either side fails)', () => {
    it.each(Object.entries(AUTHORITATIVE_ACTION_PERMISSION_MAPPING))(
      "'%s' must map to '%s' on both iOS and Android",
      (action, expectedPerm) => {
        const note = AUTHORITATIVE_ACTION_MAPPING_NOTES[action] ?? '';

        expect(
          extracted.android.mappings[action],
          `[Android] ${ENFORCEMENT_SITES.android} mapping for '${action}' drifted:\n` +
            `  expected: '${expectedPerm}'\n` +
            `  actual:   '${extracted.android.mappings[action] ?? '<missing>'}'\n` +
            `Fix: grep '"${action}" to' ${ENFORCEMENT_SITES.android} and restore mapping to '${expectedPerm}'.\n` +
            `Contract rationale: ${note}`,
        ).toBe(expectedPerm);

        expect(
          extracted.ios.mappings[action],
          `[iOS] ${ENFORCEMENT_SITES.ios} mapping for '${action}' drifted:\n` +
            `  expected: '${expectedPerm}'\n` +
            `  actual:   '${extracted.ios.mappings[action] ?? '<missing>'}'\n` +
            `Fix: grep '"${action}":' ${ENFORCEMENT_SITES.ios} and restore mapping to '${expectedPerm}'.\n` +
            `Contract rationale: ${note}`,
        ).toBe(expectedPerm);
      },
    );
  });

  describe('Django 4-preset default values (product decision SSoT)', () => {
    it.each(Object.entries(AUTHORITATIVE_DJANGO_PRESET_VALUES))(
      "permission '%s' has expected values across all 4 presets",
      (permissionKey, expectedValues) => {
        const actual = extractDjangoPresetValues(
          extracted.django.raw,
          permissionKey,
        );
        for (const preset of Object.keys(expectedValues) as Array<
          keyof typeof expectedValues
        >) {
          expect(
            actual[preset],
            `[Django ${preset} preset] ${ENFORCEMENT_SITES.django} missing or drifted '${permissionKey}':\n` +
              `  expected: '${expectedValues[preset]}'\n` +
              `  actual:   '${actual[preset] ?? '<missing>'}'\n` +
              `Fix: grep '"${preset}"' ${ENFORCEMENT_SITES.django} and ensure device_permissions has '${permissionKey}': '${expectedValues[preset]}'.`,
          ).toBe(expectedValues[preset]);
        }
      },
    );
  });

  describe('[REGRESSION-W-A0.4] force_stop_app must not regress to launch_app', () => {
    // Do not delete without reading
    // This is the last line of defense against the W A0.4 P2 bug coming back.
    it('neither iOS nor Android maps screen_force_stop_app to launch_app', () => {
      const offenders: string[] = [];
      for (const end of ['android', 'ios'] as const) {
        if (extracted[end].mappings['screen_force_stop_app'] === 'launch_app') {
          offenders.push(`${end} (${ENFORCEMENT_SITES[end]})`);
        }
      }
      expect(
        offenders,
        offenders.length === 0
          ? ''
          : `[REGRESSION] guard tripped — the following side(s) re-mapped screen_force_stop_app to launch_app:\n` +
            `  - ${offenders.join('\n  - ')}\n` +
            `Re-read W A0.4 reflection §3 to realign mapping consensus; do not regress 'force_stop_app' to 'launch_app'.`,
      ).toEqual([]);
    });
  });
});
