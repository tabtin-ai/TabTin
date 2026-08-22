import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePackagePlan } from '../package.mjs';

test('web product package plans use their workspace builds', async () => {
  const admin = await resolvePackagePlan('admindash', [], 'linux');
  const web = await resolvePackagePlan('tabtin-web', [], 'linux');
  assert.deepEqual(admin.args, ['--filter', 'admindash', 'build']);
  assert.deepEqual(web.args, ['--filter', 'tabtin-web', 'build']);
});

test('Electron package defaults to a local package for the host platform', async () => {
  const mac = await resolvePackagePlan('electron', [], 'darwin');
  assert.deepEqual(mac.args.slice(-2), ['mac', 'local']);

  const windows = await resolvePackagePlan(
    'electron',
    ['win', '--profile', 'production', '--arch', 'x64'],
    'win32',
  );
  assert.deepEqual(windows.args.slice(-3), ['win', 'production', 'x64']);
});

test('Android uses the native wrapper for each platform', async () => {
  const windows = await resolvePackagePlan('android', [], 'win32');
  assert.equal(windows.args[3], 'gradlew.bat');
  assert.equal(windows.args[4], 'assembleRelease');

  const linux = await resolvePackagePlan('android', ['assembleDebug'], 'linux');
  assert.equal(linux.args[0], 'assembleDebug');
});

test('iOS packaging rejects non-macOS hosts', async () => {
  await assert.rejects(resolvePackagePlan('ios', [], 'linux'), /macOS/);
});
