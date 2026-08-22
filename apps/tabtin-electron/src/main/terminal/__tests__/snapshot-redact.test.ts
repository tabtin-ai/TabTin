import { describe, expect, it } from 'vitest'
import { redactSensitiveContent } from '../snapshot'

describe('redactSensitiveContent', () => {
  const REDACTED = '[REDACTED]'

  // ── API Keys ──

  it('脱敏 sk- 风格 API key', () => {
    const input = 'Using key sk-abc123456789defg'
    const result = redactSensitiveContent(input)
    expect(result).toContain(REDACTED)
    expect(result).not.toContain('sk-abc123456789defg')
  })

  it('脱敏 sk_live_ 风格 API key', () => {
    const input = 'stripe key: sk_live_abcdefghijklmnop'
    const result = redactSensitiveContent(input)
    expect(result).toContain(REDACTED)
    expect(result).not.toContain('sk_live_abcdefghijklmnop')
  })

  it('脱敏 sk_test_ 风格 API key', () => {
    const input = 'test key sk_test_1234567890abcdef'
    const result = redactSensitiveContent(input)
    expect(result).toContain(REDACTED)
    expect(result).not.toContain('sk_test_1234567890abcdef')
  })

  // ── Bearer Token ──

  it('脱敏 Bearer token', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature'
    const result = redactSensitiveContent(input)
    expect(result).toContain(`Bearer ${REDACTED}`)
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('脱敏 bearer token（小写）', () => {
    const input = 'bearer my-secret-token-value'
    const result = redactSensitiveContent(input)
    expect(result).toContain(REDACTED)
    expect(result).not.toContain('my-secret-token-value')
  })

  // ── 键值对赋值 ──

  it('脱敏 token=xxx', () => {
    const input = 'config set token=abc123secret'
    const result = redactSensitiveContent(input)
    expect(result).toContain(`token=${REDACTED}`)
    expect(result).not.toContain('abc123secret')
  })

  it('脱敏 api_key=xxx', () => {
    const input = 'api_key=super-secret-key-123'
    const result = redactSensitiveContent(input)
    expect(result).toContain(`api_key=${REDACTED}`)
    expect(result).not.toContain('super-secret-key-123')
  })

  it('脱敏 api-key=xxx', () => {
    const input = 'api-key=my-key-value'
    const result = redactSensitiveContent(input)
    expect(result).toContain(REDACTED)
    expect(result).not.toContain('my-key-value')
  })

  it('脱敏 secret=xxx', () => {
    const input = 'client secret=verysecretvalue'
    const result = redactSensitiveContent(input)
    expect(result).toContain(REDACTED)
    expect(result).not.toContain('verysecretvalue')
  })

  it('脱敏 access_token=xxx', () => {
    const input = 'access_token=ghp_1234567890'
    const result = redactSensitiveContent(input)
    expect(result).toContain(REDACTED)
    expect(result).not.toContain('ghp_1234567890')
  })

  // ── 环境变量（export）──

  it('脱敏 export SECRET_KEY=xxx', () => {
    const input = 'export SECRET_KEY=my_secret_123'
    const result = redactSensitiveContent(input)
    expect(result).toContain(`SECRET_KEY=${REDACTED}`)
    expect(result).not.toContain('my_secret_123')
  })

  it('脱敏 export PASSWORD=xxx', () => {
    const input = 'export PASSWORD=hunter2'
    const result = redactSensitiveContent(input)
    expect(result).toContain(`PASSWORD=${REDACTED}`)
    expect(result).not.toContain('hunter2')
  })

  it('脱敏 export API_KEY=xxx', () => {
    const input = 'export API_KEY=abcdef123456'
    const result = redactSensitiveContent(input)
    expect(result).toContain(`API_KEY=${REDACTED}`)
    expect(result).not.toContain('abcdef123456')
  })

  it('脱敏 export GITHUB_TOKEN=xxx', () => {
    const input = 'export GITHUB_TOKEN=example-github-token'
    const result = redactSensitiveContent(input)
    expect(result).toContain(REDACTED)
    expect(result).not.toContain('example-github-token')
  })

  // ── 环境变量（非 export）──

  it('脱敏 DB_PASSWORD=xxx（行首）', () => {
    const input = 'DB_PASSWORD=supersecret'
    const result = redactSensitiveContent(input)
    expect(result).toContain(`DB_PASSWORD=${REDACTED}`)
    expect(result).not.toContain('supersecret')
  })

  it('脱敏 AUTH_TOKEN=xxx', () => {
    const input = 'AUTH_TOKEN=tok_abcdef'
    const result = redactSensitiveContent(input)
    expect(result).toContain(REDACTED)
    expect(result).not.toContain('tok_abcdef')
  })

  // ── CLI 参数 ──

  it('脱敏 --password value', () => {
    const input = 'mysql --password mysecretpass --host localhost'
    const result = redactSensitiveContent(input)
    expect(result).toContain(`--password ${REDACTED}`)
    expect(result).not.toContain('mysecretpass')
  })

  it('脱敏 --token=value', () => {
    const input = 'gh auth login --token=example-github-token'
    const result = redactSensitiveContent(input)
    expect(result).toContain(`--token=${REDACTED}`)
    expect(result).not.toContain('example-github-token')
  })

  it('脱敏 --secret value', () => {
    const input = 'app configure --secret very-secret-value'
    const result = redactSensitiveContent(input)
    expect(result).toContain(`--secret ${REDACTED}`)
    expect(result).not.toContain('very-secret-value')
  })

  it('脱敏 --api-key value', () => {
    const input = 'curl --api-key abc123'
    const result = redactSensitiveContent(input)
    expect(result).toContain(REDACTED)
    expect(result).not.toContain('abc123')
  })

  it('脱敏 -p value（mysql 风格短参数）', () => {
    const input = 'mysql -u root -p secretpass -h localhost'
    const result = redactSensitiveContent(input)
    expect(result).toContain(`-p ${REDACTED}`)
    expect(result).not.toContain('secretpass')
  })

  // ── AWS Key ──

  it('脱敏 AWS Access Key ID', () => {
    const input = 'aws_access_key_id = example-aws-access-key-id'
    const result = redactSensitiveContent(input)
    expect(result).toContain(REDACTED)
    expect(result).not.toContain('example-aws-access-key-id')
  })

  // ── GitHub Tokens ──

  it('脱敏 GitHub personal access token (ghp_)', () => {
    const input = 'GITHUB_TOKEN=example-github-token'
    const result = redactSensitiveContent(input)
    expect(result).not.toContain('example-github-token')
  })

  // ── 不误伤正常输出 ──

  it('不脱敏普通路径输出', () => {
    const input = '/home/user/projects/my-app $ ls -la'
    const result = redactSensitiveContent(input)
    expect(result).toBe(input)
  })

  it('不脱敏普通 git 输出', () => {
    const input = 'On branch main\nYour branch is up to date with origin/main.\nnothing to commit, working tree clean'
    const result = redactSensitiveContent(input)
    expect(result).toBe(input)
  })

  it('不脱敏普通 npm 输出', () => {
    const input = 'added 150 packages in 12s\n\n15 packages are looking for funding'
    const result = redactSensitiveContent(input)
    expect(result).toBe(input)
  })

  it('不脱敏普通环境变量赋值（非敏感名称）', () => {
    const input = 'export NODE_ENV=production'
    const result = redactSensitiveContent(input)
    expect(result).toBe(input)
  })

  it('不脱敏 -p 后跟 flag（如 -p -v）', () => {
    const input = 'docker run -p -v /tmp:/tmp'
    const result = redactSensitiveContent(input)
    // -p 后面是 -v（flag），不应脱敏
    expect(result).toBe(input)
  })

  it('不脱敏短的 sk 前缀（不是 API key）', () => {
    const input = 'the word sketch and skip are fine'
    const result = redactSensitiveContent(input)
    expect(result).toBe(input)
  })

  // ── 混合场景 ──

  it('多行输出中只脱敏敏感行', () => {
    const input = [
      '$ npm install',
      'added 100 packages',
      'export API_KEY=test-api-key',
      '$ echo "done"',
    ].join('\n')
    const result = redactSensitiveContent(input)
    expect(result).toContain('$ npm install')
    expect(result).toContain('added 100 packages')
    expect(result).toContain('$ echo "done"')
    expect(result).not.toContain('test-api-key')
  })

  it('含 ANSI 转义序列的敏感内容也能脱敏', () => {
    // Bearer token 中间可能没有 ANSI 序列，但行内可能有颜色代码
    const input = '\x1b[32m$ curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.tokenpayload1234567890"\x1b[0m'
    const result = redactSensitiveContent(input)
    expect(result).not.toContain('tokenpayload1234567890')
    expect(result).toContain(REDACTED)
  })

  // ── 幂等性 ──

  it('对已脱敏文本重复执行不会产生嵌套 REDACTED', () => {
    const input = 'export PASSWORD=hunter2'
    const once = redactSensitiveContent(input)
    const twice = redactSensitiveContent(once)
    expect(twice).toBe(once)
  })
})
