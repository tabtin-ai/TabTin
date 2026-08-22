import { describe, expect, it } from 'vitest';
import { evaluateAgentShellSecurityFloor } from '../src/localSandboxPolicy';

describe('Agent shell spawn security floor', () => {
  it.each([
    'powershell -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtAA==',
    'pwsh.exe -enc UgBlAG0AbwB2AGUALQBJAHQAZQBtAA==',
    'powershell -e UgBlAG0AbwB2AGUALQBJAHQAZQBtAA==',
    'Invoke-Expression $payload',
    'i`e`x $payload',
    'powershell -Command Invoke-Expression $payload',
    'cmd /c powershell -enc UgBlAG0AbwB2AGUALQBJAHQAZQBtAA==',
    '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtAA==',
  ])('拒绝不可审计的 PowerShell 载荷：%s', (command) => {
    const decision = evaluateAgentShellSecurityFloor(command);
    expect(decision.blocked).toBe(true);
    expect(decision.ruleName).toBe('opaque-powershell-execution');
  });

  it.each([
    'format C:',
    'mkfs.ext4 /dev/sda1',
    'dd if=/tmp/image of=/dev/sda',
  ])('继续拒绝灾难级命令：%s', (command) => {
    expect(evaluateAgentShellSecurityFloor(command).blocked).toBe(true);
  });

  it.each([
    'Remove-Item -Force .\\build.tmp',
    'Remove-Item -Force C:\\Windows\\Temp\\x',
    'ri Array',
    'Get-ChildItem C:\\Temp',
    'Write-Output "Invoke-Expression is documented here"',
    'echo powershell -EncodedCommand example',
  ])('不在 spawn 层覆盖上游审批结论：%s', (command) => {
    expect(evaluateAgentShellSecurityFloor(command).blocked).toBe(false);
  });
});
