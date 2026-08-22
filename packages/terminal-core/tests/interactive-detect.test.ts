import { describe, it, expect } from 'vitest';
import { detectInteractiveCommand } from '../src/interactive-detect';

describe('detectInteractiveCommand', () => {
  // ── 编辑器 ──

  describe('编辑器命令', () => {
    it.each(['vim', 'vi', 'nvim', 'nano', 'emacs', 'pico', 'ed'])(
      '%s → 交互',
      (cmd) => {
        const r = detectInteractiveCommand(cmd);
        expect(r.isInteractive).toBe(true);
        expect(r.matchedCommand).toBe(cmd);
        expect(r.reason).toContain('编辑器');
      },
    );

    it('vim file.txt 仍视为交互（编辑器始终需要 TTY）', () => {
      const r = detectInteractiveCommand('vim file.txt');
      expect(r.isInteractive).toBe(true);
      expect(r.matchedCommand).toBe('vim');
    });
  });

  // ── 分页器 ──

  describe('分页器命令', () => {
    it.each(['less', 'more', 'most'])(
      '%s → 交互',
      (cmd) => {
        const r = detectInteractiveCommand(cmd);
        expect(r.isInteractive).toBe(true);
        expect(r.matchedCommand).toBe(cmd);
        expect(r.reason).toContain('分页器');
      },
    );
  });

  // ── 远程连接 ──

  describe('远程连接命令', () => {
    it.each(['ssh', 'telnet', 'ftp', 'sftp'])(
      '%s → 交互',
      (cmd) => {
        const r = detectInteractiveCommand(cmd);
        expect(r.isInteractive).toBe(true);
        expect(r.matchedCommand).toBe(cmd);
      },
    );

    it('ssh user@host 也是交互', () => {
      const r = detectInteractiveCommand('ssh user@host');
      expect(r.isInteractive).toBe(true);
      expect(r.matchedCommand).toBe('ssh');
    });
  });

  // ── 权限提升 ──

  describe('权限提升命令', () => {
    it('sudo → 交互', () => {
      const r = detectInteractiveCommand('sudo');
      expect(r.isInteractive).toBe(true);
    });

    it('sudo ls → 交互（sudo 本身需要密码输入）', () => {
      const r = detectInteractiveCommand('sudo ls');
      expect(r.isInteractive).toBe(true);
    });

    it('sudo vim → 交互（递归检测到 vim）', () => {
      const r = detectInteractiveCommand('sudo vim');
      expect(r.isInteractive).toBe(true);
      expect(r.matchedCommand).toContain('vim');
    });

    it('sudo python → 交互（递归检测到 python REPL）', () => {
      const r = detectInteractiveCommand('sudo python');
      expect(r.isInteractive).toBe(true);
    });

    it('su → 交互', () => {
      const r = detectInteractiveCommand('su');
      expect(r.isInteractive).toBe(true);
    });

    it('doas → 交互', () => {
      const r = detectInteractiveCommand('doas');
      expect(r.isInteractive).toBe(true);
    });

    it('sudo -n ls → 非交互（-n 标志跳过密码输入）', () => {
      const r = detectInteractiveCommand('sudo -n ls');
      expect(r.isInteractive).toBe(false);
    });

    it('sudo --non-interactive apt update → 非交互', () => {
      const r = detectInteractiveCommand('sudo --non-interactive apt update');
      expect(r.isInteractive).toBe(false);
    });
  });

  // ── REPL 命令 ──

  describe('REPL 命令（无参数 = 交互，有参数 = 非交互）', () => {
    it('python（无参数）→ 交互', () => {
      const r = detectInteractiveCommand('python');
      expect(r.isInteractive).toBe(true);
      expect(r.matchedCommand).toBe('python');
      expect(r.reason).toContain('REPL');
    });

    it('python3（无参数）→ 交互', () => {
      const r = detectInteractiveCommand('python3');
      expect(r.isInteractive).toBe(true);
    });

    it('python -i → 交互', () => {
      const r = detectInteractiveCommand('python -i');
      expect(r.isInteractive).toBe(true);
    });

    it('python script.py → 非交互', () => {
      const r = detectInteractiveCommand('python script.py');
      expect(r.isInteractive).toBe(false);
    });

    it('python -c "print(1)" → 非交互', () => {
      const r = detectInteractiveCommand('python -c "print(1)"');
      expect(r.isInteractive).toBe(false);
    });

    it('python -m http.server → 非交互', () => {
      const r = detectInteractiveCommand('python -m http.server');
      expect(r.isInteractive).toBe(false);
    });

    it('python --version → 非交互', () => {
      const r = detectInteractiveCommand('python --version');
      expect(r.isInteractive).toBe(false);
    });

    it('python3 -V → 非交互', () => {
      const r = detectInteractiveCommand('python3 -V');
      expect(r.isInteractive).toBe(false);
    });

    it('python -O script.py → 非交互（有脚本参数）', () => {
      const r = detectInteractiveCommand('python -O script.py');
      expect(r.isInteractive).toBe(false);
    });

    it('node（无参数）→ 交互', () => {
      const r = detectInteractiveCommand('node');
      expect(r.isInteractive).toBe(true);
    });

    it('node app.js → 非交互', () => {
      const r = detectInteractiveCommand('node app.js');
      expect(r.isInteractive).toBe(false);
    });

    it('node -e "console.log(1)" → 非交互', () => {
      const r = detectInteractiveCommand('node -e "console.log(1)"');
      expect(r.isInteractive).toBe(false);
    });

    it('node --eval "code" → 非交互', () => {
      const r = detectInteractiveCommand('node --eval "code"');
      expect(r.isInteractive).toBe(false);
    });

    it('node --check file.js → 非交互', () => {
      const r = detectInteractiveCommand('node --check file.js');
      expect(r.isInteractive).toBe(false);
    });

    it('node --version → 非交互', () => {
      const r = detectInteractiveCommand('node --version');
      expect(r.isInteractive).toBe(false);
    });

    it('node -v → 非交互', () => {
      const r = detectInteractiveCommand('node -v');
      expect(r.isInteractive).toBe(false);
    });

    it('node -r hook app.js → 非交互（有脚本参数）', () => {
      const r = detectInteractiveCommand('node -r hook app.js');
      expect(r.isInteractive).toBe(false);
    });

    it('irb（无参数）→ 交互', () => {
      const r = detectInteractiveCommand('irb');
      expect(r.isInteractive).toBe(true);
    });

    it('ghci（无参数）→ 交互', () => {
      const r = detectInteractiveCommand('ghci');
      expect(r.isInteractive).toBe(true);
    });

    it('lua（无参数）→ 交互', () => {
      const r = detectInteractiveCommand('lua');
      expect(r.isInteractive).toBe(true);
    });

    it('lua -e "print(1)" → 非交互', () => {
      const r = detectInteractiveCommand('lua -e "print(1)"');
      expect(r.isInteractive).toBe(false);
    });
  });

  // ── 数据库客户端 ──

  describe('数据库客户端', () => {
    it.each(['mysql', 'psql', 'mongo', 'mongosh', 'redis-cli', 'sqlite3'])(
      '%s（无参数）→ 交互',
      (cmd) => {
        const r = detectInteractiveCommand(cmd);
        expect(r.isInteractive).toBe(true);
        expect(r.matchedCommand).toBe(cmd);
        expect(r.reason).toContain('数据库');
      },
    );

    it('mysql -e "SELECT 1" → 非交互', () => {
      const r = detectInteractiveCommand('mysql -e "SELECT 1"');
      expect(r.isInteractive).toBe(false);
    });

    it('mysql --execute "query" → 非交互', () => {
      const r = detectInteractiveCommand('mysql --execute "query"');
      expect(r.isInteractive).toBe(false);
    });

    it('mysql -B → 非交互', () => {
      const r = detectInteractiveCommand('mysql -B');
      expect(r.isInteractive).toBe(false);
    });

    it('psql -c "SELECT 1" → 非交互', () => {
      const r = detectInteractiveCommand('psql -c "SELECT 1"');
      expect(r.isInteractive).toBe(false);
    });

    it('psql --command "query" → 非交互', () => {
      const r = detectInteractiveCommand('psql --command "query"');
      expect(r.isInteractive).toBe(false);
    });

    it('psql -f dump.sql → 非交互', () => {
      const r = detectInteractiveCommand('psql -f dump.sql');
      expect(r.isInteractive).toBe(false);
    });

    it('mongo --eval "db.test.find()" → 非交互', () => {
      const r = detectInteractiveCommand('mongo --eval "db.test.find()"');
      expect(r.isInteractive).toBe(false);
    });

    it('redis-cli --eval script.lua → 非交互', () => {
      const r = detectInteractiveCommand('redis-cli --eval script.lua');
      expect(r.isInteractive).toBe(false);
    });

    it('mysql dbname → 非交互（有位置参数）', () => {
      const r = detectInteractiveCommand('mysql dbname');
      expect(r.isInteractive).toBe(false);
    });

    it('psql postgres → 非交互（有位置参数）', () => {
      const r = detectInteractiveCommand('psql postgres');
      expect(r.isInteractive).toBe(false);
    });

    it('mysql -u root -p → 交互（只有 flag 参数）', () => {
      const r = detectInteractiveCommand('mysql -u root -p');
      expect(r.isInteractive).toBe(true);
    });
  });

  // ── 系统监控 ──

  describe('系统监控命令', () => {
    it.each(['top', 'htop', 'watch'])(
      '%s → 交互',
      (cmd) => {
        const r = detectInteractiveCommand(cmd);
        expect(r.isInteractive).toBe(true);
        expect(r.matchedCommand).toBe(cmd);
      },
    );
  });

  // ── 多段命令 ──

  describe('多段交互式命令', () => {
    it('npm init → 交互', () => {
      const r = detectInteractiveCommand('npm init');
      expect(r.isInteractive).toBe(true);
      expect(r.matchedCommand).toBe('npm init');
    });

    it('npm init --yes → 非交互', () => {
      const r = detectInteractiveCommand('npm init --yes');
      expect(r.isInteractive).toBe(false);
    });

    it('npm init -y → 非交互', () => {
      const r = detectInteractiveCommand('npm init -y');
      expect(r.isInteractive).toBe(false);
    });

    it('yarn init → 交互', () => {
      const r = detectInteractiveCommand('yarn init');
      expect(r.isInteractive).toBe(true);
    });

    it('yarn init --yes → 非交互', () => {
      const r = detectInteractiveCommand('yarn init --yes');
      expect(r.isInteractive).toBe(false);
    });

    it('pnpm init → 交互', () => {
      const r = detectInteractiveCommand('pnpm init');
      expect(r.isInteractive).toBe(true);
    });

    it('docker run -it ubuntu → 交互', () => {
      const r = detectInteractiveCommand('docker run -it ubuntu');
      expect(r.isInteractive).toBe(true);
      expect(r.matchedCommand).toBe('docker run -it');
    });

    it('docker exec -it container bash → 交互', () => {
      const r = detectInteractiveCommand('docker exec -it container bash');
      expect(r.isInteractive).toBe(true);
    });
  });

  // ── 管道命令 ──

  describe('管道命令', () => {
    it('echo hello | python → 非交互（stdin 来自管道）', () => {
      const r = detectInteractiveCommand('echo hello | python');
      expect(r.isInteractive).toBe(false);
    });

    it('cat file | node → 非交互', () => {
      const r = detectInteractiveCommand('cat file | node');
      expect(r.isInteractive).toBe(false);
    });

    it('echo hello | less → 管道到非 REPL 交互命令仍检测（less 需要 TTY）', () => {
      const r = detectInteractiveCommand('echo hello | less');
      expect(r.isInteractive).toBe(true);
    });

    it('cmd1 || cmd2 不被当成管道', () => {
      const r = detectInteractiveCommand('false || echo ok');
      expect(r.isInteractive).toBe(false);
    });
  });

  // ── 路径前缀 ──

  describe('路径前缀处理', () => {
    it('/usr/bin/vim → 交互', () => {
      const r = detectInteractiveCommand('/usr/bin/vim');
      expect(r.isInteractive).toBe(true);
      expect(r.matchedCommand).toBe('vim');
    });

    it('/usr/local/bin/python3 → 交互', () => {
      const r = detectInteractiveCommand('/usr/local/bin/python3');
      expect(r.isInteractive).toBe(true);
    });

    it('/usr/local/bin/python3 script.py → 非交互', () => {
      const r = detectInteractiveCommand('/usr/local/bin/python3 script.py');
      expect(r.isInteractive).toBe(false);
    });
  });

  // ── 复合命令 ──

  describe('复合命令（&&、;、||）', () => {
    it('cd /tmp && vim file → 交互（检测到 vim）', () => {
      const r = detectInteractiveCommand('cd /tmp && vim file');
      expect(r.isInteractive).toBe(true);
      expect(r.matchedCommand).toBe('vim');
    });

    it('echo hello ; python → 交互（检测到 python REPL）', () => {
      const r = detectInteractiveCommand('echo hello ; python');
      expect(r.isInteractive).toBe(true);
    });

    it('ls && echo done → 非交互', () => {
      const r = detectInteractiveCommand('ls && echo done');
      expect(r.isInteractive).toBe(false);
    });

    it('false || vim file → 交互（|| 也被拆分）', () => {
      const r = detectInteractiveCommand('false || vim file');
      expect(r.isInteractive).toBe(true);
      expect(r.matchedCommand).toBe('vim');
    });

    it('true || echo ok → 非交互', () => {
      const r = detectInteractiveCommand('true || echo ok');
      expect(r.isInteractive).toBe(false);
    });
  });

  // ── 未知命令 ──

  describe('未知/普通命令', () => {
    it.each(['ls', 'echo hello', 'cat file.txt', 'grep pattern', 'mkdir dir', 'curl https://example.com'])(
      '%s → 非交互',
      (cmd) => {
        const r = detectInteractiveCommand(cmd);
        expect(r.isInteractive).toBe(false);
      },
    );
  });

  // ── 边界情况 ──

  describe('边界情况', () => {
    it('空字符串 → 非交互', () => {
      const r = detectInteractiveCommand('');
      expect(r.isInteractive).toBe(false);
    });

    it('纯空白 → 非交互', () => {
      const r = detectInteractiveCommand('   ');
      expect(r.isInteractive).toBe(false);
    });

    it('带前导空白的 vim → 交互', () => {
      const r = detectInteractiveCommand('  vim');
      expect(r.isInteractive).toBe(true);
    });
  });
});
