import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)));

function readBuildScript(name: string): string {
  return readFileSync(join(scriptsDir, name), 'utf8');
}

describe('packaged app install identity', () => {
  it.each(['build-packaged-app.sh', 'build-mac-dmg-quick.sh'])(
    'keeps preprod distinct from production in %s',
    (scriptName) => {
      const script = readBuildScript(scriptName);

      expect(script).toMatch(
        /production\)(?:(?!;;)[\s\S])*?PROFILE_PRODUCT_NAME="TabTin"(?:(?!;;)[\s\S])*?;;/,
      );
      expect(script).toMatch(
        /preprod\)(?:(?!;;)[\s\S])*?PROFILE_PRODUCT_NAME="TabTin Preprod"(?:(?!;;)[\s\S])*?;;/,
      );
      expect(script).toMatch(
        /preprod\)(?:(?!;;)[\s\S])*?PROFILE_APP_ID="com\.tabtin\.app\.preprod"(?:(?!;;)[\s\S])*?;;/,
      );
    },
  );
});
