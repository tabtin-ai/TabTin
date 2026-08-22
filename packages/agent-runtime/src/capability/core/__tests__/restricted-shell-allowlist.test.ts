/**
 * 受限模式 shell 命令 input 级白名单 checker 单测（L16 / W5.5）。
 *
 * 覆盖：
 *   - tabtin 只读子命令通过（含位置参数命令：`doc read <id>` / `search "query"` 等）
 *   - tabtin 写子命令拒绝（risk='write' / 'high-risk-write'）
 *   - browser eval 必须按写命令拒绝（W5.5-R3 P0-2 安全洞）
 *   - 非 tabtin 命令拒绝
 *   - 命令注入字符（| ; > ` $(...) ）拒绝
 *   - 复合命令（cd ... && tabtin ...）通过
 *   - 多 && 拒绝
 *   - 未知命令 + 终末动词不在 READONLY_VERBS → 拒绝（启发式兜底）
 *   - 未知命令 + 终末动词在 READONLY_VERBS → 放行（启发式兜底）
 *   - lookup 全失败 → 拒绝（fail-close）
 *   - 裸 tabtin / tabtin --help 通过
 *   - 守护断言：risk='write' 命令的终末动词不能出现在 READONLY_VERBS 中
 */

import { describe, it, expect } from 'vitest';
import {
  createTabtinReadonlyChecker,
  buildRiskMapFromSchemas,
  parseTabtinCommandsJson,
  __testExports,
} from '../restricted-shell-allowlist.js';

const { parseTabtinSubcommand } = __testExports;

// ：只读动词表 / 受限模式浏览器导航豁免已迁宿主注入（RESTRICTED_READONLY_VERBS /
// RESTRICTED_BROWSER_NAV_ALLOWLIST）。runtime checker 改由注入，本测试用本地 fixture 驱动
// 「注入动词表后的启发式兜底 / 导航豁免」机制；产品动词表本身的内容守护（不漏写命令 /
// 与 CLI 同步）见宿主侧 restricted-readonly-verbs 测试。
const READONLY_VERBS_FIXTURE: ReadonlySet<string> = new Set([
  'list', 'get', 'read', 'query', 'records', 'statistics', 'glance', 'print',
  'commands', 'capabilities', 'wait', 'console', 'cookies', 'network', 'tab',
  'state', 'resource', 'stream', 'ua', 'dry-run', 'grep', 'glob', 'export',
  'search', 'help', 'version', 'list-blocks', 'search-blocks',
]);
const RESTRICTED_BROWSER_NAV_FIXTURE: ReadonlySet<string> = new Set(['open', 'nav', 'tab switch']);

// CLI schema fixture——按当前 packages/tabtin-cli-go/cmd/ 真实 Risk 标注同步。
// 写命令必须 risk='write'（W5.5-R3 P1-1 修复后所有写命令均显式标注），
// 只读命令 risk=''。新增 schema 行时同步 WRITE_COMMANDS_FOR_GUARD。
const FAKE_SCHEMAS = [
  { name: 'tabtin commands', risk: '' },
  { name: 'tabtin doc list', risk: '' },
  { name: 'tabtin doc read', risk: '' },
  { name: 'tabtin doc list-blocks', risk: '' },
  { name: 'doc search-blocks', risk: '' },
  { name: 'tabtin doc export', risk: '' },
  { name: 'tabtin doc search', risk: '' },
  { name: 'tabtin doc create', risk: 'write' },
  { name: 'tabtin doc update', risk: 'write' },
  { name: 'tabtin doc delete', risk: 'write' },
  { name: 'tabtin doc save-content', risk: 'write' },
  { name: 'tabtin search', risk: '' },
  { name: 'tabtin code grep', risk: '' },
  { name: 'tabtin code glob', risk: '' },
  { name: 'tabtin memo read', risk: '' },
  { name: 'tabtin tracker show', risk: '' },
  { name: 'tabtin tracker dry-run', risk: '' },
  { name: 'tabtin browser tab list', risk: '' },
  { name: 'tabtin browser tab state', risk: '' },
  { name: 'tabtin browser act', risk: 'write' },
  // ：open 改变浏览器上下文，CLI 为 write；受限模式由导航白名单显式放行。
  { name: 'tabtin browser open', risk: 'write' },
  { name: 'tabtin browser nav', risk: 'write' },
  { name: 'tabtin browser batch', risk: 'write' },
  { name: 'tabtin browser eval', risk: 'write' },
  { name: 'tabtin browser tab switch', risk: 'write' },
  { name: 'tabtin browser tab close', risk: 'write' },
  { name: 'tabtin browser cookies set', risk: 'write' },
  { name: 'tabtin browser session create', risk: 'write' },
  { name: 'tabtin daemon stop', risk: 'write' },
  { name: 'tabtin daemon update', risk: 'write' },
  { name: 'tabtin table query', risk: '' },
  { name: 'tabtin table archive', risk: 'write' },
  { name: 'tabtin table restore', risk: 'write' },
];

const map = buildRiskMapFromSchemas(FAKE_SCHEMAS);
const checker = createTabtinReadonlyChecker({
  fetchCommandRisk: async (subcmdPath: string) =>
    map.has(subcmdPath) ? (map.get(subcmdPath) ?? '') : null,
  // ：宿主注入只读兜底动词表（本地 fixture）。
  readonlyVerbs: READONLY_VERBS_FIXTURE,
  allowedCwdRoot: '/workspace/project',
});

describe('parseTabtinSubcommand', () => {
  it('extracts subcommand tokens for plain tabtin command', () => {
    const r = parseTabtinSubcommand('tabtin doc list --format json');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tokens).toEqual(['doc', 'list']);
  });

  it('handles cd ... && tabtin prefix', () => {
    const r = parseTabtinSubcommand(
      'cd /workspace/project && tabtin doc list --format json',
      '/workspace/project',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tokens).toEqual(['doc', 'list']);
  });

  it('rejects pipe', () => {
    const r = parseTabtinSubcommand('tabtin doc list | jq .');
    expect(r.ok).toBe(false);
  });

  it('rejects redirect', () => {
    const r = parseTabtinSubcommand('tabtin doc list > out.json');
    expect(r.ok).toBe(false);
  });

  it('rejects command substitution', () => {
    const r = parseTabtinSubcommand('tabtin doc list $(rm -rf /)');
    expect(r.ok).toBe(false);
  });

  it('rejects backtick subshell', () => {
    const r = parseTabtinSubcommand('tabtin doc list `whoami`');
    expect(r.ok).toBe(false);
  });

  it('rejects multi-stage && chain', () => {
    const r = parseTabtinSubcommand('cd /tmp && tabtin doc list && rm -rf .');
    expect(r.ok).toBe(false);
  });

  it('rejects non-cd prefix in compound command', () => {
    const r = parseTabtinSubcommand('echo hi && tabtin doc list');
    expect(r.ok).toBe(false);
  });

  it('rejects non-tabtin command', () => {
    const r = parseTabtinSubcommand('kubectl get pods');
    expect(r.ok).toBe(false);
  });

  it('handles env var prefix', () => {
    const r = parseTabtinSubcommand('FOO=bar tabtin doc list');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tokens).toEqual(['doc', 'list']);
  });

  it('returns empty tokens for bare tabtin', () => {
    const r = parseTabtinSubcommand('tabtin');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tokens).toEqual([]);
  });

  it('handles 3-token nested subcommand', () => {
    const r = parseTabtinSubcommand('tabtin browser tab list --format json');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tokens).toEqual(['browser', 'tab', 'list']);
  });
});

describe('createTabtinReadonlyChecker — 北极星场景', () => {
  it('北极星 1：plan 模式 tabtin doc list --format json 通过', async () => {
    const d = await checker.isAllowed('tabtin doc list --format json');
    expect(d.allowed).toBe(true);
  });

  it('北极星 2：plan 模式 tabtin doc create 被拒绝（带友好错误）', async () => {
    const d = await checker.isAllowed('tabtin doc create --title X');
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('write_risk');
    expect(d.reason).toMatch(/write/);
  });

  it('plan 模式 browser act 被拒绝', async () => {
    const d = await checker.isAllowed('tabtin browser act --tab 1');
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('write_risk');
  });

  it('plan 模式 browser tab list 通过', async () => {
    const d = await checker.isAllowed('tabtin browser tab list --format json');
    expect(d.allowed).toBe(true);
  });

  it('plan 模式 tabtin commands 通过', async () => {
    const d = await checker.isAllowed('tabtin commands --format json');
    expect(d.allowed).toBe(true);
  });

  it('plan 模式允许一级命令的纯 --help 调用', async () => {
    const d = await checker.isAllowed('tabtin browser --help');
    expect(d.allowed).toBe(true);
  });

  it('包含其它 flag 的写命令不能借 --help 绕过风险检查', async () => {
    const d = await checker.isAllowed('tabtin doc create --title --help');
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('write_risk');
  });

  it('转义空格不能把业务参数伪装成纯 --help 调用', async () => {
    const d = await checker.isAllowed('tabtin daemon stop ignored\\ --help');
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('write_risk');
  });

  it.each([
    'tabtin daemon stop # --help',
    'tabtin daemon stop & --help',
  ])('shell 控制语义不能伪装纯 help：%s', async (command) => {
    const d = await checker.isAllowed(command);
    expect(d.allowed).toBe(false);
  });
});

// W5.5-R3 P0-1 回归：`tabtin doc read <uuid>` 这类带位置参数的只读查询命令
// 此前被启发式 lastVerb 把 uuid 当末尾动词错杀。修复后必须 PASS。
describe('createTabtinReadonlyChecker — P0-1 位置参数回归', () => {
  it('tabtin doc read <uuid> --format json 通过', async () => {
    const d = await checker.isAllowed('tabtin doc read abc-uuid-1234 --format json');
    expect(d.allowed).toBe(true);
  });

  it('tabtin doc list-blocks <uuid> 通过', async () => {
    const d = await checker.isAllowed('tabtin doc list-blocks abc-uuid-1234');
    expect(d.allowed).toBe(true);
  });

  it('tabtin doc search-blocks <uuid> --query <kw> 通过', async () => {
    const d = await checker.isAllowed('tabtin doc search-blocks abc-uuid-1234 --query 西湖');
    expect(d.allowed).toBe(true);
  });

  it('tabtin doc export <uuid> --format json 通过', async () => {
    const d = await checker.isAllowed('tabtin doc export abc-uuid-1234 --format json');
    expect(d.allowed).toBe(true);
  });

  it('tabtin memo read <uuid> 通过', async () => {
    const d = await checker.isAllowed('tabtin memo read mem-1234');
    expect(d.allowed).toBe(true);
  });

  it('tabtin tracker show <uuid> 通过', async () => {
    const d = await checker.isAllowed('tabtin tracker show trk-1234');
    expect(d.allowed).toBe(true);
  });

  it('tabtin search "query string" 通过', async () => {
    const d = await checker.isAllowed('tabtin search "query string"');
    expect(d.allowed).toBe(true);
  });

  it('tabtin code grep "pattern" 通过', async () => {
    const d = await checker.isAllowed('tabtin code grep "pattern"');
    expect(d.allowed).toBe(true);
  });

  it('tabtin code glob "*.go" 通过', async () => {
    const d = await checker.isAllowed('tabtin code glob "*.go"');
    expect(d.allowed).toBe(true);
  });
});

// W5.5-R3 P0-2 回归：browser eval 不再被当成只读，必须按写命令拒绝。
describe('createTabtinReadonlyChecker — P0-2 eval 安全洞回归', () => {
  it('tabtin browser eval --expression "..." 被拒绝（write_risk）', async () => {
    const d = await checker.isAllowed(
      'tabtin browser eval --expression "fetch(\'/api/admin\')"',
    );
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('write_risk');
  });

  it('tabtin browser eval 不可凭借动词集启发式绕过（动词不在只读动词表）', () => {
    expect(READONLY_VERBS_FIXTURE.has('eval')).toBe(false);
  });
});

describe('createTabtinReadonlyChecker — L20c 引号路径回归', () => {
  it('cd "/path with space" && tabtin ... 双引号路径通过', async () => {
    const d = await checker.isAllowed('cd "/workspace/project/My Documents" && tabtin doc list --format json');
    expect(d.allowed).toBe(true);
  });

  it("cd '/path with space' && tabtin ... 单引号路径通过", async () => {
    const d = await checker.isAllowed("cd '/workspace/project/My Project' && tabtin doc list --format json");
    expect(d.allowed).toBe(true);
  });

  it('cd <unquoted-path> && tabtin ... 仍然通过（不破坏既有契约）', async () => {
    const d = await checker.isAllowed('cd /workspace/project && tabtin doc list --format json');
    expect(d.allowed).toBe(true);
  });
});

describe('createTabtinReadonlyChecker — L20d tabtin help 命令', () => {
  it('tabtin help（无参）通过', async () => {
    const d = await checker.isAllowed('tabtin help');
    expect(d.allowed).toBe(true);
  });

  it('tabtin help doc 通过', async () => {
    const d = await checker.isAllowed('tabtin help doc');
    expect(d.allowed).toBe(true);
  });

  it('tabtin help doc create 通过——help 子命令本身只读，不会触发 doc create 的写逻辑', async () => {
    const d = await checker.isAllowed('tabtin help doc create');
    expect(d.allowed).toBe(true);
  });
});

describe('createTabtinReadonlyChecker — 边界与安全网', () => {
  it('非 tabtin 命令（不在 6 命令系统 allowlist 内）拒绝', async () => {
    // J3a：'ls' 不在第一批 6 命令 scope，进系统通道也被拒——code 升级为
    // system_command_rejected（让 LLM 区分"完全未识别"vs"识别但 flag 不允许"）。
    // 历史断言 'not_tabtin' 已在 J3a 之前的"plan 模式仅允许 tabtin"假设下成立；
    // 升级后的 code 更具体，无回归。
    const d = await checker.isAllowed('ls -la');
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('system_command_rejected');
  });

  it('空命令拒绝', async () => {
    const d = await checker.isAllowed('   ');
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('empty_command');
  });

  it('管道段含白名单外命令 → 整条拒绝（ 联合校验 fail-close）', async () => {
    const d = await checker.isAllowed('tabtin doc list | rm -rf /');
    expect(d.allowed).toBe(false);
    // rm 段不在白名单：复合联合校验拒绝，code 来自段级决策。
    expect(d.reason).toContain('rm -rf /');
  });

  it('已注册写命令（daemon stop 标 risk=write）拒绝', async () => {
    const d = await checker.isAllowed('tabtin daemon stop');
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('write_risk');
  });

  it('未注册命令 + 终末动词在 READONLY_VERBS → 启发式兜底放行', async () => {
    // CLI schema 漏注册的纯只读命令（这里用一个虚构子命令，其终末动词 "list" 在 READONLY_VERBS 中）
    const d = await checker.isAllowed('tabtin somebrandnewfeature list');
    expect(d.allowed).toBe(true);
  });

  it('未注册命令 + 终末动词不在 READONLY_VERBS → unknown_command 拒绝', async () => {
    const d = await checker.isAllowed('tabtin somebrandnewfeature mutate-everything');
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('unknown_command');
  });

  it('lookup 全失败时 fail-close 拒绝', async () => {
    const failingChecker = createTabtinReadonlyChecker({
      fetchCommandRisk: async () => {
        throw new Error('CLI registry unreachable');
      },
    });
    const d = await failingChecker.isAllowed('tabtin doc list');
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('lookup_failed');
  });

  it('裸 tabtin 视作 help 放行', async () => {
    const d = await checker.isAllowed('tabtin');
    expect(d.allowed).toBe(true);
  });

  it('多层 && 拒绝（防止 doc list && doc create 绕过）', async () => {
    const d = await checker.isAllowed('tabtin doc list && tabtin doc create --title X');
    expect(d.allowed).toBe(false);
  });

  it('cd /path && tabtin doc list 通过', async () => {
    const d = await checker.isAllowed('cd /workspace/project && tabtin doc list --format json');
    expect(d.allowed).toBe(true);
  });
});

// ：READONLY_VERBS 产品动词表内容守护（不漏写命令 / 与 CLI 同步）已随
// 动词表迁到宿主侧 restricted-readonly-verbs 测试。

describe('buildRiskMapFromSchemas', () => {
  it('compiles schema array to name → risk map', () => {
    const m = buildRiskMapFromSchemas([
      { name: 'tabtin doc list', risk: '' },
      { name: 'tabtin doc create', risk: 'write' },
    ]);
    expect(m.get('tabtin doc list')).toBe('');
    expect(m.get('tabtin doc create')).toBe('write');
    expect(m.has('tabtin nope')).toBe(false);
  });

  it('handles missing risk field as empty string', () => {
    const m = buildRiskMapFromSchemas([{ name: 'tabtin x' }]);
    expect(m.get('tabtin x')).toBe('');
  });

  it('normalizes command schema names without tabtin prefix', () => {
    const m = buildRiskMapFromSchemas([{ name: 'doc search-blocks', risk: '' }]);
    expect(m.get('tabtin doc search-blocks')).toBe('');
  });

  // ：`tabtin commands` 现在也输出 pure group 入口命令（is_group:true，
  // risk 空）。group 若进 risk map，未注册的写子命令会借 `tabtin doc` 前缀最长
  // 匹配被误放行——必须跳过，保持未注册子命令走 unknown_command 启发式兜底。
  it('skips is_group entries so group prefix cannot leak allow for unregistered subcommands', async () => {
    const m = buildRiskMapFromSchemas([
      { name: 'doc', risk: '', is_group: true },
      { name: 'tabtin doc list', risk: '' },
    ]);
    expect(m.has('tabtin doc')).toBe(false);
    expect(m.get('tabtin doc list')).toBe('');

    // 端到端：未注册的写形态子命令不能借 group 前缀放行
    const groupChecker = createTabtinReadonlyChecker({
      fetchCommandRisk: async (p) => (m.has(p) ? (m.get(p) ?? '') : null),
    });
    const decision = await groupChecker.isAllowed('tabtin doc unregistered-mutate --id x');
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('unknown_command');
  });
});

// ：`tabtin commands --format json` 现在输出 SuccessEnvelope
// `{ok, data:{commands, global_flags}}`。ElectronAgentHost / DaemonAgentHost 的
// loadCliCommandsAsync 共用 parseTabtinCommandsJson 解包，防止两端 inline 解析漂移
// （Daemon 曾只认顶层数组 → envelope 恒解析成 null → 受限模式 fail-close 误拒只读命令）。
describe('parseTabtinCommandsJson', () => {
  it('unwraps SuccessEnvelope shape {ok, data:{commands}}', () => {
    const stdout = JSON.stringify({
      ok: true,
      data: {
        commands: [
          { name: 'doc list', risk: '' },
          { name: 'doc create', risk: 'write' },
        ],
        global_flags: [],
      },
    });
    const schemas = parseTabtinCommandsJson(stdout);
    expect(schemas).not.toBeNull();
    expect(schemas).toHaveLength(2);
    expect(schemas?.[0]?.name).toBe('doc list');
    expect(schemas?.[1]?.risk).toBe('write');
  });

  it('accepts bare {commands} shape', () => {
    const stdout = JSON.stringify({ commands: [{ name: 'doc list', risk: '' }] });
    expect(parseTabtinCommandsJson(stdout)).toHaveLength(1);
  });

  it('accepts top-level array shape', () => {
    const stdout = JSON.stringify([{ name: 'doc list', risk: '' }]);
    expect(parseTabtinCommandsJson(stdout)).toHaveLength(1);
  });

  it('returns null for invalid JSON', () => {
    expect(parseTabtinCommandsJson('not json')).toBeNull();
  });

  it('returns null when no commands array is present', () => {
    expect(parseTabtinCommandsJson(JSON.stringify({ ok: true, data: {} }))).toBeNull();
    expect(parseTabtinCommandsJson(JSON.stringify({ ok: false }))).toBeNull();
  });
});

// L20b：READONLY_VERBS codegen 守护——模拟 `tabtin commands --format json` fixture
// （hand-crafted JSON，避免依赖真 tabtin 二进制），断言所有 risk='' 命令的终末
// verb 都在 READONLY_VERBS 集合里。漏一个 verb 会让 schema 注册不全场景下的
// 启发式兜底（lastVerb in READONLY_VERBS）拒绝合法只读命令。
//
// 维护契约：当 tabtin CLI 加新 risk='' 命令时，要么把终末 verb 加进 READONLY_VERBS，
// 要么把这条命令名加进 PRODUCTION_SCHEMA_FIXTURE。本测试在 fixture 行漏 verb 时
// 红，让维护者强制选其一处理。fixture 来源：手工同步自 packages/tabtin-cli-go/cmd/
// 真实声明（采样而非穷举，覆盖每种 verb 模式即可）。
// tabtin 通道未命中后追加系统命令 allowlist 通道。
//
// 决策链：tabtin parser 命中 → 走原 Risk 决策；parser 失败原因是"非 tabtin 命令"
// → 尝试系统命令 allowlist；都不命中保持原 reject 路径但 code 升级为
// system_command_rejected（让 LLM 区分"完全未识别"vs"识别但 flag 不允许"）。
describe('createTabtinReadonlyChecker — 系统命令决策链集成', () => {
  it('plan 模式 git status 通过（系统命令 allowlist 命中）', async () => {
    const d = await checker.isAllowed('git status')
    expect(d.allowed).toBe(true)
  })

  it('plan 模式 git status -s 通过', async () => {
    const d = await checker.isAllowed('git status -s')
    expect(d.allowed).toBe(true)
  })

  it('plan 模式 git push 拒绝（不在 GIT_READ_ONLY_COMMANDS）', async () => {
    const d = await checker.isAllowed('git push origin main')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('system_command_rejected')
  })

  it('plan 模式 git commit 拒绝', async () => {
    const d = await checker.isAllowed('git commit -m "msg"')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('system_command_rejected')
  })

  it('plan 模式 find . -name "*.ts" 通过', async () => {
    const d = await checker.isAllowed('find . -name "*.ts"')
    expect(d.allowed).toBe(true)
  })

  it('plan 模式 find . -delete 拒绝（denylist 命中）', async () => {
    const d = await checker.isAllowed('find . -delete')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('system_command_rejected')
  })

  it('plan 模式 find . -exec rm 拒绝', async () => {
    const d = await checker.isAllowed('find . -exec rm {}')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('system_command_rejected')
  })

  it('plan 模式 tree -L 2 通过', async () => {
    const d = await checker.isAllowed('tree -L 2')
    expect(d.allowed).toBe(true)
  })

  it('plan 模式 tree -o /tmp/out.txt 拒绝', async () => {
    const d = await checker.isAllowed('tree -o /tmp/out.txt')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('system_command_rejected')
  })

  it("plan 模式 sed 's/x/y/g' file 通过", async () => {
    const d = await checker.isAllowed("sed 's/x/y/g' file")
    expect(d.allowed).toBe(true)
  })

  it("plan 模式 sed -i 拒绝（in-place 写文件）", async () => {
    const d = await checker.isAllowed("sed -i 's/x/y/g' file")
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('system_command_rejected')
  })

  it('plan 模式 ps -ef 通过', async () => {
    const d = await checker.isAllowed('ps -ef')
    expect(d.allowed).toBe(true)
  })

  it('plan 模式 ps axe 拒绝（BSD `e` modifier 泄漏 env）', async () => {
    const d = await checker.isAllowed('ps axe')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('system_command_rejected')
  })

  it('plan 模式 xargs echo 通过', async () => {
    const d = await checker.isAllowed('xargs echo')
    expect(d.allowed).toBe(true)
  })

  it('plan 模式 xargs rm 拒绝（rm 不在 SAFE_TARGET）', async () => {
    const d = await checker.isAllowed('xargs rm')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('system_command_rejected')
  })

  it('git status | grep . → grep 段不在白名单，联合校验拒绝', async () => {
    const d = await checker.isAllowed('git status | grep .')
    expect(d.allowed).toBe(false)
    // 新语义：git status 段过白名单，grep 段（第一批未移植）被拒 → 整条拒绝。
    expect(d.reason).toContain('grep .')
  })

  // ── ：复合命令联合校验（顶层拆段 + 每段独立过白名单） ──────────────
  describe('复合命令联合校验', () => {
    it('白名单命令的管道组合放行：git log | sed', async () => {
      const d = await checker.isAllowed("git log --oneline | sed -n '1,20p'")
      expect(d.allowed).toBe(true)
    })

    it('白名单命令的串联放行：git status; git log', async () => {
      const d = await checker.isAllowed('git status --short; git log --oneline -5')
      expect(d.allowed).toBe(true)
    })

    it('多段 && 组合（cd 段放行 + 白名单段）', async () => {
      const d = await checker.isAllowed('cd /workspace/project/subdir && git status --short && git log --oneline -3')
      expect(d.allowed).toBe(true)
    })

    it('tabtin 只读命令与白名单系统命令混合管道放行', async () => {
      const d = await checker.isAllowed("tabtin doc list | sed -n '1,5p'")
      expect(d.allowed).toBe(true)
    })

    it('单引号内的管道符不当拆分符（不误拆；已知限制：单段引号内控制符仍走旧 metachar 拒绝）', async () => {
      // 拆段器正确识别 '%h|%s' 的 | 在引号内（不产生拆分），但无拆分符的命令
      // 回退旧单段路径，旧 metachar 正则不感知引号 → 仍拒绝。这是保守的已知
      // 限制（fail-close 方向），放开需旧路径 quote-aware 化，另行处理。
      const d = await checker.isAllowed("git log --pretty=format:'%h|%s' -5")
      expect(d.allowed).toBe(false)
    })

    it('重定向仍拒绝（不进入拆段路径）', async () => {
      const d = await checker.isAllowed('git log > /tmp/out.txt')
      expect(d.allowed).toBe(false)
    })

    it('$() 子 shell 仍拒绝', async () => {
      const d = await checker.isAllowed('git log $(rm -rf /)')
      expect(d.allowed).toBe(false)
    })

    it('反引号仍拒绝', async () => {
      const d = await checker.isAllowed('git log `rm -rf /`')
      expect(d.allowed).toBe(false)
    })

    it('裸 & 后台执行仍拒绝', async () => {
      const d = await checker.isAllowed('git log & git status')
      expect(d.allowed).toBe(false)
    })

    it('引号未闭合拒绝', async () => {
      const d = await checker.isAllowed("git log --pretty='%h | git status")
      expect(d.allowed).toBe(false)
    })

    it('双引号内 $ 展开保守拒绝', async () => {
      const d = await checker.isAllowed('git log | grep "$HOME"')
      expect(d.allowed).toBe(false)
    })

    it('写风险段混入串联 → 整条拒绝：git status && tabtin daemon stop', async () => {
      const d = await checker.isAllowed('git status && tabtin daemon stop')
      expect(d.allowed).toBe(false)
      expect(d.code).toBe('write_risk')
    })

    it('换行分隔的第二条命令拒绝，避免 shell 执行未校验段', async () => {
      const d = await checker.isAllowed('find . -type f\ntabtin daemon stop')
      expect(d.allowed).toBe(false)
    })

    it('回车分隔的第二条命令拒绝，避免 shell 执行未校验段', async () => {
      const d = await checker.isAllowed('sed -n 1p foo\rtabtin daemon stop')
      expect(d.allowed).toBe(false)
    })

    it('cd 段只能留在工作目录根内', async () => {
      const d = await checker.isAllowed('cd / && find . -type f')
      expect(d.allowed).toBe(false)
    })

    it('cd 段不能出现在复合命令中途改变后续 cwd', async () => {
      const d = await checker.isAllowed('git status; cd /workspace/project/subdir; find . -type f')
      expect(d.allowed).toBe(false)
    })

    it('cd 段拒绝未引号 shell 展开，避免校验路径与真实 shell cwd 分叉', async () => {
      expect((await checker.isAllowed('cd ~ && find . -type f')).allowed).toBe(false)
      expect((await checker.isAllowed('cd $HOME && find . -type f')).allowed).toBe(false)
    })
  })

  // 当前实现：parser 接受 cd && X 复合，但 X = 'git status' 时 parser 走
  // not_tabtin 路径，传给系统命令通道。strippedMain = 'git status'（已剥 cd
  // 前缀），通过。系统命令通道暂不主动接管 `cd && X` 复合形态——这是有意限制
  // （参见 system-command-allowlist.ts 顶部"复合命令拆分"段），后续轮次再补。
  it('plan 模式工作目录内 cd && git status 当前放行（系统命令通道不主动接管 cd && 复合形态）', async () => {
    const d = await checker.isAllowed('cd /workspace/project && git status')
    expect(d.allowed).toBe(true)
  })

  it('plan 模式工作目录内 cd && rm -rf 拒绝', async () => {
    const d = await checker.isAllowed('cd /workspace/project && rm -rf .')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('system_command_rejected')
  })

  it('plan 模式 git -c core.fsmonitor=evil log 拒绝（git -c 注入防护）', async () => {
    const d = await checker.isAllowed('git -c core.fsmonitor=evil log')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('system_command_rejected')
  })

  it('plan 模式 git --exec-path=/tmp log 拒绝', async () => {
    const d = await checker.isAllowed('git --exec-path=/tmp log')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('system_command_rejected')
  })

  it('plan 模式 git log "$EVIL--output=/tmp/x" 拒绝（unquoted expansion 防护）', async () => {
    const d = await checker.isAllowed('git log "$EVIL--output=/tmp/x"')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('system_command_rejected')
  })

  it('plan 模式 ls -la 仍 reject（ls 不在 6 命令 scope）', async () => {
    // 第一批 scope 是 6 命令；ls 留待后续
    const d = await checker.isAllowed('ls -la')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('system_command_rejected')
  })

  it('plan 模式 tabtin doc create 仍走 tabtin 通道（不被系统通道接管）', async () => {
    // tabtin parser 命中（tokens=['doc','create']），fetchCommandRisk 返回 'write'
    // → write_risk 拒绝（不是 system_command_rejected）
    const d = await checker.isAllowed('tabtin doc create --title X')
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('write_risk')
  })

  it('北极星 1：6 命令 safeFlags 关键 flag 落地', async () => {
    // 抽样关键 flag，确保 6 命令真实落地——这是 grep 北极星 1 的语义验证
    expect((await checker.isAllowed('git status -s')).allowed).toBe(true)
    expect((await checker.isAllowed('git log --oneline')).allowed).toBe(true)
    expect((await checker.isAllowed('git diff --cached')).allowed).toBe(true)
    expect((await checker.isAllowed('tree -L 2')).allowed).toBe(true)
    expect((await checker.isAllowed('find . -type f')).allowed).toBe(true)
    expect((await checker.isAllowed("sed -n '1,10p' f")).allowed).toBe(true)
    expect((await checker.isAllowed('xargs echo')).allowed).toBe(true)
    expect((await checker.isAllowed('ps -ef')).allowed).toBe(true)
  })
})


/**
 *  回归基线：Ask（问答）只读模式语义钉死。
 *
 * 背景： 担心「问答模式声称只读，却能执行命令」。结论是非安全洞——
 * ask 模式与 plan/study 一样由 host（Electron/Daemon）按 `tabtin-readonly`
 * allowlist 注入同一个 `restrictedShellChecker`，写 / 执行类命令在 shell 入口
 * 即被拦截，只放行只读查询命令。本组用例把该基线钉死，防止以后被误放开。
 *
 * 用顶部同款 `checker`（host 给 ask/plan/study 注入的就是这一个实例，mode 无关）。
 */
describe('#775 Ask 模式只读语义回归 — 写/执行类命令必须被拦', () => {
  it('tabtin 写子命令 `tabtin doc create` 被拒（write_risk）', async () => {
    const d = await checker.isAllowed('tabtin doc create --title X');
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('write_risk');
  });

  it('破坏性系统命令 `rm -rf .` 被拒', async () => {
    const d = await checker.isAllowed('rm -rf .');
    expect(d.allowed).toBe(false);
  });

  it('版本控制写命令 `git commit` 被拒', async () => {
    const d = await checker.isAllowed('git commit -m wip');
    expect(d.allowed).toBe(false);
  });

  it('只读查询命令 `tabtin doc list` 仍放行（不误伤只读能力）', async () => {
    const d = await checker.isAllowed('tabtin doc list --format json');
    expect(d.allowed).toBe(true);
  });
});

describe('#5448 /  受限模式浏览器导航豁免', () => {
  const restrictedModeChecker = createTabtinReadonlyChecker({
    fetchCommandRisk: async (subcmdPath: string) =>
      map.has(subcmdPath) ? (map.get(subcmdPath) ?? '') : null,
    readonlyVerbs: READONLY_VERBS_FIXTURE,
    browserNavAllowlist: RESTRICTED_BROWSER_NAV_FIXTURE,
  });

  it('受限模式放行 write 风险的 `browser open`', async () => {
    const d = await restrictedModeChecker.isAllowed('tabtin browser open --url https://x.com');
    expect(d.allowed).toBe(true);
  });

  it('受限模式放行 `browser nav` 与 `browser tab switch`', async () => {
    expect((await restrictedModeChecker.isAllowed('tabtin browser nav --back')).allowed).toBe(true);
    expect((await restrictedModeChecker.isAllowed('tabtin browser tab switch --tab-id t1')).allowed).toBe(true);
  });

  it('受限模式仍拒非导航浏览器写命令（tab close / act 走审批）', async () => {
    // fixture 里 browser session create 是 write，代表非导航写——不在豁免集
    const d = await restrictedModeChecker.isAllowed('tabtin browser session create');
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('write_risk');
  });

  it('未注入 browserNavAllowlist 时拒绝 write 风险的 browser open', async () => {
    const d = await checker.isAllowed('tabtin browser open --url https://x.com');
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('write_risk');
  });
});
