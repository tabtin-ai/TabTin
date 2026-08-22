/**
 * path-normalize.test.ts — §3.6 路径规范化
 *
 * 覆盖：symlink / symlink-loop / Unicode NFC / Windows 盘符展开 /
 *       iCloud 占位符（ENOENT 模拟）/ 工作区前缀匹配
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  normalize,
  isInWorkspace,
  isCwdInWorkspace,
  isDangerouslyBroadPath,
  __clearNormalizeCache,
  __debugNormalizeCacheSize,
  MAX_SYMLINK_DEPTH,
  LRUCache,
} from '../src/path-normalize';
import type { WorkspaceSnapshot } from '../src/types-v3';

describe('normalize · 基本行为', () => {
  beforeEach(() => __clearNormalizeCache());

  it('空字符串返回 path:""', () => {
    expect(normalize('').path).toBe('');
    expect(normalize('').resolved).toBe(false);
  });

  it('已存在的绝对路径返回 resolved=true 且带 dev/ino', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-norm-'));
    try {
      const r = normalize(tmp);
      expect(r.resolved).toBe(true);
      expect(typeof r.dev).toBe('number');
      expect(typeof r.ino).toBe('number');
      expect(r.path.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('路径不存在 → resolved=false 但有 path（fallback）', () => {
    const r = normalize('/definitely/does/not/exist/xyz_' + Date.now());
    expect(r.resolved).toBe(false);
    expect(r.path).toContain('/');
  });

  it('tilde 展开使用注入的 home', () => {
    const r = normalize('~/foo/bar', '/Users/test_home');
    // 不存在 → resolved=false，但路径已展开
    expect(r.path).toContain('test_home');
  });
});

describe('normalize · 缓存', () => {
  beforeEach(() => __clearNormalizeCache());

  it('同 input 重复调命中缓存', () => {
    normalize('/tmp');
    const sizeAfter1 = __debugNormalizeCacheSize();
    normalize('/tmp');
    expect(__debugNormalizeCacheSize()).toBe(sizeAfter1);
  });

  it('不同 home 上下文不污染缓存', () => {
    normalize('~/x', '/home/a');
    normalize('~/x', '/home/b');
    expect(__debugNormalizeCacheSize()).toBeGreaterThanOrEqual(2);
  });
});

describe('normalize · symlink', () => {
  let tmpRoot: string;
  beforeEach(() => {
    __clearNormalizeCache();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-sym-'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('单层 symlink 解析到目标', () => {
    const target = path.join(tmpRoot, 'real');
    const link = path.join(tmpRoot, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'dir');
    const r = normalize(link);
    expect(r.resolved).toBe(true);
    // realpath 后路径应等价于 target（macOS 上 /tmp 本身是 symlink → /private/tmp）
    const realTarget = fs.realpathSync(target);
    expect(r.path).toBe(realTarget);
  });

  it('symlink loop → resolved=false 不崩', () => {
    const a = path.join(tmpRoot, 'a');
    const b = path.join(tmpRoot, 'b');
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    const r = normalize(a);
    expect(r.resolved).toBe(false);
    // 不抛错就达标
    expect(typeof r.path).toBe('string');
  });
});

describe('normalize · Unicode NFC', () => {
  beforeEach(() => __clearNormalizeCache());

  it('NFD 形式归一为 NFC（café 两种 Unicode 写法等价）', () => {
    // NFD: 'cafe\u0301' (e + combining acute accent)
    // NFC: 'caf\u00e9'  (é precomposed)
    const nfd = '/Users/test/caf\u0065\u0301';
    const nfc = '/Users/test/caf\u00e9';
    const r1 = normalize(nfd);
    const r2 = normalize(nfc);
    expect(r1.path).toBe(r2.path);
  });
});

describe('normalize · Windows 形态（POSIX 系统下做字符串归一测试）', () => {
  beforeEach(() => __clearNormalizeCache());

  it('反斜杠在 POSIX 系统下不强制转 forward-slash（Windows 才转）', () => {
    // POSIX 系统：toPosixSlashes 仅在 win32 平台生效
    // 这里覆盖在 POSIX 跑时 fallback path（不存在）也不崩
    const r = normalize('C:\\Users\\me');
    expect(r.resolved).toBe(false);
    expect(typeof r.path).toBe('string');
  });
});

describe('normalize · iCloud / ENOENT 占位符', () => {
  beforeEach(() => __clearNormalizeCache());

  it('不存在路径走 fallback：resolved=false', () => {
    // iCloud 占位符典型表现是 readlink 抛 ENOENT；我们用纯不存在路径模拟
    const r = normalize('/Users/x/iCloud~Drive~placeholder/file_' + Date.now());
    expect(r.resolved).toBe(false);
    expect(r.path).toContain('iCloud');
  });
});

describe('isInWorkspace / isCwdInWorkspace · 前缀匹配', () => {
  function makeWorkspace(allowedPaths: string[], allowedFiles: string[] = []): WorkspaceSnapshot {
    return {
      sources: {
        sandbox: allowedPaths[0] ?? '',
        tabcodeProjects: allowedPaths.slice(1),
        tabfolderDirs: [],
        attachedFiles: allowedFiles,
      },
      allowedPaths,
      allowedFiles,
      spaceSessionId: 'test',
    };
  }

  it('精确匹配目录', () => {
    const ws = makeWorkspace(['/Users/me/proj']);
    expect(isInWorkspace('/Users/me/proj', ws)).toBe(true);
  });

  it('子目录匹配', () => {
    const ws = makeWorkspace(['/Users/me/proj']);
    expect(isInWorkspace('/Users/me/proj/src/index.ts', ws)).toBe(true);
  });

  it('字符串前缀但非子目录 → 不命中（避免 /foo/barx 误判）', () => {
    const ws = makeWorkspace(['/Users/me/proj']);
    expect(isInWorkspace('/Users/me/projx/file.ts', ws)).toBe(false);
  });

  it('完全不在工作区', () => {
    const ws = makeWorkspace(['/Users/me/proj']);
    expect(isInWorkspace('/etc/passwd', ws)).toBe(false);
  });

  it('attachedFiles 精确匹配', () => {
    const ws = makeWorkspace(['/Users/me/proj'], ['/Users/me/Desktop/brief.md']);
    expect(isInWorkspace('/Users/me/Desktop/brief.md', ws)).toBe(true);
    expect(isInWorkspace('/Users/me/Desktop/brief2.md', ws)).toBe(false);
  });

  it('多 allowedPath 任一命中即可', () => {
    const ws = makeWorkspace(['/a/b', '/c/d']);
    expect(isInWorkspace('/c/d/x', ws)).toBe(true);
    expect(isInWorkspace('/a/b/y', ws)).toBe(true);
    expect(isInWorkspace('/e/f', ws)).toBe(false);
  });

  it('空 normalizedPath 返回 false', () => {
    const ws = makeWorkspace(['/a']);
    expect(isInWorkspace('', ws)).toBe(false);
  });

  it('isCwdInWorkspace 行为一致', () => {
    const ws = makeWorkspace(['/Users/me/proj']);
    expect(isCwdInWorkspace('/Users/me/proj', ws)).toBe(true);
    expect(isCwdInWorkspace('/etc', ws)).toBe(false);
  });

  it('Windows working_dir 以反斜杠入账时，cwd 与子路径仍判定为工作区内', () => {
    const ws = makeWorkspace(['E:\\documentTest']);
    expect(isCwdInWorkspace('E:/documentTest', ws)).toBe(true);
    expect(isCwdInWorkspace('E:/documentTest/real-world.docx', ws)).toBe(true);
    expect(isInWorkspace('E:\\documentTest\\real-world.docx', ws)).toBe(true);
  });

  it('Windows drive letter 与大小写差异不影响工作区判定', () => {
    const ws = makeWorkspace(['e:\\DocumentTest']);
    expect(isCwdInWorkspace('E:/documenttest', ws)).toBe(true);
    expect(isInWorkspace('E:/DOCUMENTTEST/artifacts/file.json', ws)).toBe(true);
  });

  it('Windows 相邻前缀目录仍然不命中工作区', () => {
    const ws = makeWorkspace(['E:\\documentTest']);
    expect(isCwdInWorkspace('E:/documentTest2', ws)).toBe(false);
    expect(isInWorkspace('E:\\documentTest2\\real-world.docx', ws)).toBe(false);
  });

  // M3.1 硬化：allowedPath = '/' 必须**不再**让任意绝对路径命中工作区
  // —— 见 isDangerouslyBroadPath 的过滤兜底
  it('M3.1：allowedPath = / 被过滤；任意路径不命中工作区', () => {
    const ws = makeWorkspace(['/']);
    expect(isInWorkspace('/anything', ws)).toBe(false);
    expect(isInWorkspace('/Users/developer', ws)).toBe(false);
    expect(isInWorkspace('/etc/passwd', ws)).toBe(false);
  });
});

// ─── M3.1 硬化补丁：isDangerouslyBroadPath ──────────────────────────
//
// 北极星：任何让 `/` / 整盘 / OS 顶级目录 / 用户家目录本身 / 相对路径
// 进 allowedPaths 的代码 bug / 测试 fixture 泄漏 / 远程 wire payload 入侵，
// 都不能让 Agent 把整个家目录当 workspace。

describe('isDangerouslyBroadPath · M3.1 过宽路径防护', () => {
  describe('负例（应判定 dangerous = true）', () => {
    it('空字符串', () => {
      expect(isDangerouslyBroadPath('')).toBe(true);
    });

    it('全空白', () => {
      expect(isDangerouslyBroadPath('   ')).toBe(true);
      expect(isDangerouslyBroadPath('\t')).toBe(true);
      expect(isDangerouslyBroadPath('\n')).toBe(true);
    });

    it('单 `/`（整盘根）', () => {
      expect(isDangerouslyBroadPath('/')).toBe(true);
    });

    it('POSIX 顶级 /Users（macOS 用户根）', () => {
      expect(isDangerouslyBroadPath('/Users')).toBe(true);
      expect(isDangerouslyBroadPath('/Users/')).toBe(true);
    });

    it('POSIX 顶级 /home（Linux 用户根）', () => {
      expect(isDangerouslyBroadPath('/home')).toBe(true);
      expect(isDangerouslyBroadPath('/home/')).toBe(true);
    });

    it('POSIX 顶级 /tmp / /var / /etc / /usr / /bin / /sbin / /opt / /root / /private', () => {
      for (const top of ['/tmp', '/var', '/etc', '/usr', '/bin', '/sbin', '/opt', '/root', '/private']) {
        expect(isDangerouslyBroadPath(top)).toBe(true);
        expect(isDangerouslyBroadPath(top + '/')).toBe(true);
      }
    });

    it('M3.1 review 第 1 轮补：macOS / Linux 半台机器整段 /Volumes / /Applications / /srv / /mnt / /media / /proc / /sys / /dev', () => {
      for (const top of ['/Volumes', '/Applications', '/srv', '/mnt', '/media', '/proc', '/sys', '/dev']) {
        expect(isDangerouslyBroadPath(top)).toBe(true);
        expect(isDangerouslyBroadPath(top + '/')).toBe(true);
      }
    });

    it('M3.1.1 R3-1 补：OS 服务根 /snap / /System / /Library / /boot / /run', () => {
      for (const top of ['/snap', '/System', '/Library', '/boot', '/run']) {
        expect(isDangerouslyBroadPath(top)).toBe(true);
        expect(isDangerouslyBroadPath(top + '/')).toBe(true);
      }
    });

    it('Windows 盘符根 `C:/` `C:\\` `C:` `/C:/`', () => {
      expect(isDangerouslyBroadPath('C:/')).toBe(true);
      expect(isDangerouslyBroadPath('C:\\')).toBe(true);
      expect(isDangerouslyBroadPath('C:')).toBe(true);
      expect(isDangerouslyBroadPath('/C:/')).toBe(true);
      expect(isDangerouslyBroadPath('D:/')).toBe(true);
      expect(isDangerouslyBroadPath('Z:\\')).toBe(true);
    });

    it('相对路径（`.` / `..` / `dev/foo`）', () => {
      expect(isDangerouslyBroadPath('.')).toBe(true);
      expect(isDangerouslyBroadPath('..')).toBe(true);
      expect(isDangerouslyBroadPath('../..')).toBe(true);
      expect(isDangerouslyBroadPath('dev/foo')).toBe(true);
    });

    it('未展开 `~` / `~/dev`', () => {
      expect(isDangerouslyBroadPath('~')).toBe(true);
      expect(isDangerouslyBroadPath('~/dev')).toBe(true);
    });

    it('非 string 类型（number / null / undefined / object）→ true（防御性）', () => {
      expect(isDangerouslyBroadPath(42 as unknown)).toBe(true);
      expect(isDangerouslyBroadPath(null as unknown)).toBe(true);
      expect(isDangerouslyBroadPath(undefined as unknown)).toBe(true);
      expect(isDangerouslyBroadPath({ path: '/foo' } as unknown)).toBe(true);
    });
  });

  describe('正例（合法 allowedPath 不被误挡 = false）', () => {
    it('合法项目根 `/Users/developer/dev/midscene`', () => {
      expect(isDangerouslyBroadPath('/Users/developer/dev/midscene')).toBe(false);
    });

    it('合法 sandbox `/tmp/tabtin-sandbox/space-xxx`', () => {
      expect(isDangerouslyBroadPath('/tmp/tabtin-sandbox/space-xxx')).toBe(false);
    });

    it('合法 Documents 子目录 `/Users/developer/Documents/work`', () => {
      expect(isDangerouslyBroadPath('/Users/developer/Documents/work')).toBe(false);
    });

    it('合法二级 home 子目录 `/home/foo/bar`', () => {
      expect(isDangerouslyBroadPath('/home/foo/bar')).toBe(false);
    });

    it('合法 macOS firmlink 子路径 `/private/tmp/sandbox-xxx`', () => {
      expect(isDangerouslyBroadPath('/private/tmp/sandbox-xxx')).toBe(false);
    });

    it('合法深嵌套路径', () => {
      expect(isDangerouslyBroadPath('/Users/developer/dev/midscene/src/components/Button.tsx')).toBe(false);
    });

    it('合法 Windows 盘符子路径', () => {
      expect(isDangerouslyBroadPath('C:/Users/foo/dev/proj')).toBe(false);
      expect(isDangerouslyBroadPath('C:\\Users\\foo\\dev')).toBe(false);
    });

    it('M3.1 review 第 2 轮补：macOS 系统共享目录 /Users/Shared / /Users/Guest 合法', () => {
      expect(isDangerouslyBroadPath('/Users/Shared')).toBe(false);
      expect(isDangerouslyBroadPath('/Users/Shared/')).toBe(false);
      expect(isDangerouslyBroadPath('/Users/Guest')).toBe(false);
    });

    it('M3.1 review 第 2 轮补：/Users/Shared 子目录也合法（作为合法 TabFolder 根的常见用法）', () => {
      expect(isDangerouslyBroadPath('/Users/Shared/projects')).toBe(false);
      expect(isDangerouslyBroadPath('/Users/Shared/lab/dataset')).toBe(false);
    });

    it('M3.1 review 第 1 轮补：危险顶级的合法子路径不被误挡', () => {
      expect(isDangerouslyBroadPath('/Volumes/外接盘/项目')).toBe(false);
      expect(isDangerouslyBroadPath('/Applications/MyApp.app')).toBe(false);
      expect(isDangerouslyBroadPath('/srv/web/site')).toBe(false);
      expect(isDangerouslyBroadPath('/mnt/data/proj')).toBe(false);
      expect(isDangerouslyBroadPath('/media/usb/notes')).toBe(false);
    });

    it('M3.1.1 R3-1 补：新增 OS 服务根的合法子路径不被误挡', () => {
      // 字面整段 /snap → dangerous，但 /snap/myapp/current 是合法软件目录
      expect(isDangerouslyBroadPath('/snap/myapp/current')).toBe(false);
      // /Library/CustomApp/data 是合法应用数据目录（root /Library 子路径）
      expect(isDangerouslyBroadPath('/Library/CustomApp/data')).toBe(false);
      // /System/Volumes/Data/... macOS APFS 容器 — 也合法（不是字面整段）
      expect(isDangerouslyBroadPath('/System/Volumes/Data/Users/me/dev/proj')).toBe(false);
      // /run/user/<uid> 是 systemd 用户运行时目录子路径，合法
      expect(isDangerouslyBroadPath('/run/user/1000/dbus/session_bus_socket')).toBe(false);
      // /boot/efi 是合法 EFI 子路径（极少作 workspace 但不该被字面拦）
      expect(isDangerouslyBroadPath('/boot/efi/EFI')).toBe(false);
    });

    it('M3.1.1 方向 C：单用户家目录 /Users/<name> 合法（撤销 isUserHomeRoot 启发）', () => {
      // 用户拍板：放宽家目录本身为合法 workspace；凭据级敏感子目录由 sensitive_path_list 敲门
      expect(isDangerouslyBroadPath('/Users/developer')).toBe(false);
      expect(isDangerouslyBroadPath('/Users/developer/')).toBe(false);
      expect(isDangerouslyBroadPath('/Users/foo')).toBe(false);
      expect(isDangerouslyBroadPath('/home/foo')).toBe(false);
      expect(isDangerouslyBroadPath('/home/developer/')).toBe(false);
    });
  });
});

// ─── M3.1 硬化：isInWorkspace 集成防护 ──────────────────────────────
describe('isInWorkspace · M3.1 过滤过宽 allowedPath（集成）', () => {
  function makeWorkspace(allowedPaths: string[], allowedFiles: string[] = []): WorkspaceSnapshot {
    return {
      sources: {
        sandbox: allowedPaths[0] ?? '',
        tabcodeProjects: allowedPaths.slice(1),
        tabfolderDirs: [],
        attachedFiles: allowedFiles,
      },
      allowedPaths,
      allowedFiles,
      spaceSessionId: 'test',
    };
  }

  it('allowedPaths 含 `/` + 合法项目 → 任意绝对路径不会因 `/` 命中', () => {
    const ws = makeWorkspace(['/', '/Users/developer/dev/midscene']);
    expect(isInWorkspace('/etc/passwd', ws)).toBe(false);
    expect(isInWorkspace('/Users/developer/.ssh/id_rsa', ws)).toBe(false);
    // 但合法项目内的路径仍然命中
    expect(isInWorkspace('/Users/developer/dev/midscene/README.md', ws)).toBe(true);
  });

  it('allowedPaths 全是过宽路径 → 任意路径都不在工作区', () => {
    const ws = makeWorkspace(['/', '/Users', '/home', '/tmp']);
    expect(isInWorkspace('/Users/developer/dev/foo', ws)).toBe(false);
    expect(isInWorkspace('/etc/passwd', ws)).toBe(false);
  });

  it('M3.1.1 方向 C：allowedPaths = [`/Users/developer`]（家目录本身） → 内部路径命中 workspace_in', () => {
    // 用户拍板放宽家目录后，整个家目录算合法 workspace；凭据级敲门由 sensitive_path_list 兜底
    const ws = makeWorkspace(['/Users/developer']);
    expect(isInWorkspace('/Users/developer/Documents/secret.md', ws)).toBe(true);
    expect(isInWorkspace('/Users/developer/dev/midscene/README.md', ws)).toBe(true);
    // 注意：`.ssh/id_rsa` 这种敏感写在 judge 层会被 sensitive_path_list 降级为 ask
    // （即使 yolo 开），但 isInWorkspace 单纯判几何位置——是 in 的
    expect(isInWorkspace('/Users/developer/.ssh/id_rsa', ws)).toBe(true);
  });

  it('allowedFiles 含 `/` → 不会让任意路径精确等于 `/` 命中（`/` 不会等于绝对路径，但过滤一致性）', () => {
    const ws = makeWorkspace(['/Users/me/proj'], ['/', '']);
    expect(isInWorkspace('/Users/me/proj/x.ts', ws)).toBe(true);
    expect(isInWorkspace('/etc/passwd', ws)).toBe(false);
  });
});

describe('MAX_SYMLINK_DEPTH 常量', () => {
  it('= 40', () => {
    expect(MAX_SYMLINK_DEPTH).toBe(40);
  });
});

describe('normalize · 多种 fallback 路径与边界', () => {
  beforeEach(() => __clearNormalizeCache());

  it('包含 .. 的路径会被收掉', () => {
    const r = normalize('/Users/me/proj/../proj');
    expect(r.path).not.toContain('..');
  });

  it('包含 ./ 的路径会被收掉', () => {
    const r = normalize('/tmp/./foo');
    expect(r.path.endsWith('/foo') || r.path === '/tmp/foo' || r.path === '/private/tmp/foo').toBe(true);
  });

  it('末尾斜杠在子目录场景被剥离', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-norm-tail-'));
    try {
      const r = normalize(tmp + '/');
      expect(r.path.endsWith('/')).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('深嵌套 not-exist 走 manualRealpath fallback', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-norm-deep-'));
    try {
      const r = normalize(path.join(tmp, 'a/b/c/d/not-exist.txt'));
      expect(r.resolved).toBe(false);
      expect(r.path).toContain('not-exist.txt');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('多级 symlink 链能解析', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-norm-chain-'));
    try {
      fs.mkdirSync(path.join(root, 'real'));
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link1'), 'dir');
      fs.symlinkSync(path.join(root, 'link1'), path.join(root, 'link2'), 'dir');
      const r = normalize(path.join(root, 'link2'));
      expect(r.resolved).toBe(true);
      expect(r.path).toBe(fs.realpathSync(path.join(root, 'real')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('TTL 过期重新查询不抛错', () => {
    // 通过清缓存 + 重查模拟 TTL 过期
    normalize('/tmp');
    __clearNormalizeCache();
    const r = normalize('/tmp');
    expect(typeof r.path).toBe('string');
  });

  it('空 input 返回 path:""', () => {
    expect(normalize('').path).toBe('');
    expect((normalize as unknown as (s: unknown) => { path: string })(null as unknown).path).toBe('');
  });

  it('LRU evict：超过 max entries 时最旧的被删（用 LRUCache 直接验证）', () => {
    const lru = new LRUCache<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    lru.set('d', 4); // 触发 evict，'a' 应被删
    expect(lru.get('a')).toBeUndefined();
    expect(lru.get('b')).toBe(2);
    expect(lru.get('d')).toBe(4);
  });

  it('LRU touch：get 后元素移到末尾，evict 时不会被删', () => {
    const lru = new LRUCache<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    lru.get('a'); // touch a
    lru.set('d', 4); // 'b' 应被删（不是 a）
    expect(lru.get('a')).toBe(1);
    expect(lru.get('b')).toBeUndefined();
  });

  it('LRU set 同 key 覆盖：不增长 size', () => {
    const lru = new LRUCache<string, number>(3);
    lru.set('a', 1);
    lru.set('a', 2);
    expect(lru.size).toBe(1);
    expect(lru.get('a')).toBe(2);
  });

  it('LRU clear / delete', () => {
    const lru = new LRUCache<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.delete('a')).toBe(true);
    expect(lru.delete('a')).toBe(false);
    lru.clear();
    expect(lru.size).toBe(0);
  });
});
