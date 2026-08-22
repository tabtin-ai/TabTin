/**
 * Deny Rule Hints — W1（失败信号保真）
 *
 * Maps each denylist rule name to an English actionable hint that tells the
 * LLM WHY the command was blocked and HOW to accomplish the same goal using
 * an allowed alternative.
 *
 * **All hints are in English** (D3: LLM-facing injected messages must be in
 * English for better model adherence to instructions — same convention as
 * 常见 agent 的 `<sandbox_violations>` XML injection).
 *
 * Coverage: HARDLINE_COMMAND_DENYLIST (codegen), CRITICAL_DENYLIST,
 * DEFAULT_DENYLIST, plus the pseudo-rules generated at runtime by CommandValidator
 * (env-var-expansion / command-substitution / sensitive-path / empty).
 */
export const DENY_RULE_HINTS: Readonly<Record<string, string>> = {

  // ── HARDLINE_COMMAND_DENYLIST（codegen 自 hardline-v3-rules.json）────

  'rm -rf root or home':
    'Recursive deletion of root, home, or $HOME is blocked as a catastrophic operation.',

  'rm -rf system root':
    'Recursive deletion of the system root (`rm -rf /`) is blocked.',

  'fork bomb':
    'Bash fork-bomb patterns are blocked.',

  'dd to raw device':
    'Writing to raw block devices via `dd` is blocked.',

  'mkfs format':
    'Filesystem formatting (`mkfs`) is blocked.',

  'format disk windows':
    'Windows disk formatting (`format C:` etc.) is blocked.',

  'redirect to raw disk':
    'Redirecting output to a raw block device (`> /dev/sd*`) is blocked.',

  'curl pipe to shell':
    'Fetching and executing a script in a single pipeline is blocked. ' +
    'Use `tabtin fetch <url>` to read the page content, save ' +
    'the script with `write_file`, then run it as a Python/Node script ' +
    '(`python3 script.py` / `node script.js`). Avoid `bash <file>` — ' +
    '`shell-invocation` is also blocked.',

  'shutdown / reboot':
    'System power commands (shutdown/reboot/halt/poweroff) are blocked.',

  'kill all processes':
    'Killing all processes (`kill -9 -1` / `killall -9`) is blocked.',

  'mv to /dev/null':
    'Moving files to `/dev/null` (effective deletion bypass) is blocked. ' +
    'Use the `delete_file` tool instead.',

  'sudo escalation':
    '`sudo` (privilege escalation) is blocked. If elevated execution is essential, ' +
    'ask the user to perform the operation manually.',

  'chmod 777 root':
    'Recursive chmod 777 on system root or home directory is blocked.',

  'chmod -R 777':
    'Recursive chmod 777 is blocked.',

  'chown -R root':
    'Recursive chown to root is blocked.',

  'iptables flush':
    'Flushing firewall rules (`iptables -F` / `ufw disable|reset`) is blocked.',

  'systemctl stop critical':
    'Stopping or disabling critical system services (sshd, networking, firewalld) is blocked.',

  'eval expansion':
    '`eval` with variable expansion is blocked (arbitrary command injection). ' +
    'Save logic to a script via `write_file`, then run with `python3` / `node`.',

  // ── CRITICAL_DENYLIST（terminal-only）────────────────────────────

  'pipe-to-shell':
    'Piping output directly to a shell interpreter is blocked. ' +
    'To execute a remote script safely: ' +
    '(1) fetch the page text via `tabtin fetch <url>` ' +
    '(the tabtin CLI is allowed); ' +
    '(2) review the content with the user; ' +
    '(3) save the script with `write_file` and run it via `python3 script.py` ' +
    'or `node script.js` (both allowed). Direct shell scripts (`bash script.sh`) ' +
    'are also blocked by the `shell-invocation` rule.',

  'process-substitution-shell':
    'Process substitution feeding into a shell interpreter is blocked. ' +
    'Run each command separately, save intermediate output via `write_file`, ' +
    'then read it with `read_file` in the next step.',

  'process-substitution-input':
    'Process substitution with network-fetching tools is blocked. ' +
    'Use `tabtin fetch <url>` (page text) or ' +
    '`tabtin browser print --url <url> --save <path>` (page content to file) to retrieve ' +
    'content; for query-driven discovery use `web_search`. ' +
    'Then pass the saved file to the consuming command.',

  'process-substitution-output':
    'Redirecting output into a shell via process substitution is blocked. ' +
    'Write to a file using the `write_file` tool instead.',

  'python-inline':
    'Inline Python execution (`python -c "..."`) is blocked. ' +
    'Write the code to a script file using the `write_file` tool, ' +
    'then run it with `python3 script.py`.',

  'node-inline':
    'Inline Node.js execution (`node -e "..."` / `node --eval`) is blocked. ' +
    'Write the code to a script file using the `write_file` tool, ' +
    'then run it with `node script.js`.',

  'curl-write-file':
    'Writing curl output directly to a file (`-o` / `-O` / `--output`) is blocked. ' +
    'For binary resources (videos / images / archives), use ' +
    '`tabtin browser download --url <url>`. For page text content, use ' +
    '`tabtin browser print --url <url> --save <path>` (saves Markdown by default).',

  'curl-upload':
    'Uploading files via curl (`-T` / `--upload-file`) is blocked. ' +
    'If file upload is essential to the task, ask the user ' +
    'to perform it manually.',

  'curl-exfil':
    'Sending local file contents via curl (`-d @file` / `-F @file`) is blocked ' +
    'as a data-exfiltration safeguard. If the user needs to POST file contents, ' +
    'ask the user to perform the operation themselves.',

  'redirect-write':
    'Writing stdout to a file using `>` or `>>` is blocked. ' +
    'To write file content, use the `write_file` or `edit_file` tool instead. ' +
    'If you only need to discard stderr, use `cmd 2>/dev/null` — ' +
    'stderr redirect (`2>`) is permitted.',

  'export-env-injection':
    'Exporting dangerous environment variables (LD_PRELOAD, BASH_ENV, ' +
    'DYLD_INSERT_LIBRARIES, PROMPT_COMMAND, etc.) is blocked because they ' +
    'can hijack child-process behaviour at runtime.',

  'export-path-hijack':
    'Setting PATH to untrusted writable directories (/tmp, /var/tmp) is blocked ' +
    'because it enables command-hijacking via PATH manipulation.',

  // ── DEFAULT_DENYLIST ──────────────────────────────────────────────

  'rm':
    '`rm` is blocked. To delete a file use the `delete_file` tool instead.',

  'mv':
    '`mv` is blocked. To move or rename a file, combine `read_file` + ' +
    '`write_file` + `delete_file` tools.',

  'chmod':
    '`chmod` (permission modification) is blocked. If changing file permissions ' +
    'is essential, ask the user to run it manually; ' +
    'otherwise reconsider whether the goal can be achieved without it.',

  'chown':
    '`chown` (ownership modification) is blocked. If changing file ownership is ' +
    'essential, ask the user to perform the operation themselves.',

  'sudo':
    '`sudo` (privilege escalation) is blocked. If elevated execution is essential, ' +
    'ask the user to perform the operation manually; ' +
    'otherwise reconsider whether the goal can be achieved without sudo.',

  'git-destructive':
    'Destructive git operations (push/commit/reset/checkout/clean/rebase/' +
    'merge/tag/branch/stash) are blocked. ' +
    'Only read-only git commands (log/diff/status/show/fetch --dry-run) are ' +
    'permitted. For write operations, ask the user to run the ' +
    'specific git command themselves — multiple parallel agents share this ' +
    'repo and stash/reset/branch-switch destroys others\u2019 work-in-progress.',

  'npm-install':
    'npm install/add/update/publish is blocked. ' +
    'Ask the user to run package installation manually if required.',

  'pnpm-install':
    'pnpm install/add/update/publish is blocked. ' +
    'Ask the user to run package installation manually if required.',

  'yarn-install':
    'yarn install/add/upgrade/publish is blocked. ' +
    'Ask the user to run package installation manually if required.',

  'eval':
    '`eval` is blocked because it executes arbitrary code at runtime. ' +
    'Save the logic to a script via `write_file`, then run it directly with ' +
    '`python3 script.py` / `node script.js` (both allowed). Avoid `bash -c` / ' +
    '`sh -c` — they are blocked by `shell-invocation`.',

  'source':
    '`source` / `.` (script sourcing) is blocked.',

  'su':
    '`su` (user-switch) is blocked.',

  'dd':
    '`dd` (low-level block device I/O) is blocked.',

  'mkfs':
    '`mkfs` (filesystem creation) is blocked.',

  'reboot-shutdown':
    'System power commands (reboot/shutdown/poweroff/halt) are blocked. ' +
    'If a host restart is required, ask the user to ' +
    'perform it manually — automated execution is unsafe.',

  'crontab-write':
    'Modifying crontab (`crontab -e` / `crontab -r`) is blocked.',

  'systemctl-destructive':
    'Destructive systemctl operations (stop/disable/mask/restart) are blocked. ' +
    'For service state changes, ask the user to perform them manually; ' +
    'read-only `systemctl status <unit>` is permitted.',

  'iptables':
    'Modifying firewall rules via iptables/nftables/ufw is blocked. ' +
    'If a network policy change is required, ask the user ' +
    'to perform it manually; misconfigured firewalls can lock the host.',

  'docker-destructive':
    'Destructive docker operations (rm/rmi/system prune/container rm) are blocked. ' +
    'If container/image cleanup is required, ask the user to perform it manually. ' +
    'Read-only docker commands (`docker ps`, `docker logs`, `docker inspect`) ' +
    'are still allowed.',

  'kubectl-destructive':
    'Destructive kubectl operations (delete/drain/cordon) are blocked. ' +
    'If cluster state changes are required, ask the user to perform them manually. ' +
    'Read-only `kubectl get` / `kubectl describe` are still allowed.',

  'python-server':
    'Starting a Python HTTP/SMTP server (`python -m http.server` etc.) is blocked.',

  'shell-invocation':
    'Directly invoking a shell interpreter (bash/sh/zsh/fish/dash/tcsh/csh) is blocked. ' +
    'Run the specific command you need directly instead of spawning a sub-shell.',

  'terminal-multiplexer':
    'Terminal multiplexers (screen/tmux) are blocked.',

  'perl-exec':
    'Perl execution is blocked.',

  'ruby-exec':
    'Ruby execution is blocked.',

  'php-exec':
    'PHP execution is blocked.',

  'nc-netcat':
    'nc/ncat/netcat is blocked (common reverse-shell and data-exfiltration vector).',

  'tee-write':
    '`tee` (writing to files from stdin) is blocked. Use the `write_file` tool instead.',

  'sed-inplace':
    '`sed -i` (in-place file modification) is blocked. Use the `edit_file` tool instead.',

  'find-exec':
    '`find -exec` (command amplification over find results) is blocked. ' +
    'Use `glob_search` to find files, then operate on them individually.',

  'xargs-exec':
    '`xargs` (command amplification) is blocked. The runtime has no built-in ' +
    'loop primitive; instead, use `glob_search` to enumerate files, then issue ' +
    'individual tool calls (`read_file` / `edit_file` / `delete_file`) for each ' +
    'result. For batch transforms, save a Python script via `write_file` and ' +
    'run it with `python3 script.py`.',

  'scp':
    '`scp` (remote file copy) is blocked.',

  'rsync':
    '`rsync` (remote file sync) is blocked.',

  'curl-basic':
    'curl is blocked at the default policy level. To read web pages use ' +
    '`tabtin fetch <url>` (page text) or ' +
    '`tabtin browser print --url <url> --save <path>` (page content to file). For binary ' +
    'downloads use `tabtin browser download --url <url>`. For query-driven ' +
    'discovery use `web_search`. None of these require approval.',

  'wget-basic':
    'wget is blocked at the default policy level. Use ' +
    '`tabtin fetch <url>` for page text, ' +
    '`tabtin browser print --url <url> --save <path>` for page content to file, or ' +
    '`tabtin browser download --url <url>` for binary downloads. ' +
    'For query-driven discovery use `web_search`. None of these require approval.',

  'ftp-sftp':
    'ftp/sftp file transfer is blocked.',

  'at-batch':
    'Scheduled task creation via `at`/`batch` is blocked.',

  'curl-mutating':
    'Sending data via curl (-d/--data/-X POST/PUT/PATCH/DELETE/-F) is blocked.',

  'wget-write':
    'Sending data via wget (--post-data/--post-file/--method) is blocked.',

  'ssh':
    'SSH remote connection is blocked. If a remote operation is required, ' +
    'ask the user to run it manually; the agent has no ' +
    'safe channel for remote shell sessions.',

  'telnet':
    'telnet is blocked (insecure plaintext network protocol).',

  'socat':
    'socat is blocked (network relay / reverse-shell vector).',

  'nmap':
    'nmap (network scanning) is blocked.',

  'mount-umount':
    'mount/umount (filesystem mounting operations) are blocked. ' +
    'If filesystem mounting is essential, ask the user to perform it ' +
    'themselves — incorrect mounts can damage the host.',

  'chroot':
    'chroot (change-root namespace isolation) is blocked.',

  'namespace-escape':
    'nsenter/unshare (Linux namespace manipulation) are blocked.',

  'debugger':
    'Debuggers (strace/ltrace/gdb/lldb) are blocked.',

  'pip-install':
    '`pip install` is blocked. Ask the user to install Python packages manually.',

  'cargo-install':
    '`cargo install` is blocked. Ask the user to install Rust packages manually.',

  'go-install':
    '`go install` is blocked. Ask the user to install Go packages manually.',

  'kill':
    '`kill` / `killall` / `pkill` is blocked. If a process must be terminated, ' +
    'ask the user to do it manually — the agent does not ' +
    'have safe context to know which processes are user-critical.',

  // ── Runtime pseudo-rules (generated in commandValidator.ts) ────────

  'env-var-expansion':
    'Environment variable expansion ($VAR / ${VAR}) is blocked because it can ' +
    'bypass static security rule matching at runtime. ' +
    'Replace variable references with their absolute path values — ' +
    'e.g., replace `$HOME/foo` with `/Users/<your-username>/foo`.',

  'command-substitution':
    'Command substitution ($(...) or backtick `...`) is blocked because it can ' +
    'execute arbitrary commands inline. ' +
    'Run the inner command separately, save the output to a file, ' +
    'then read the result with the `read_file` tool.',

  'sensitive-path':
    'This path is on the sensitive-path block list ' +
    '(e.g., /etc/passwd, ~/.ssh/, /etc/shadow). ' +
    'Access to sensitive system files and directories is not permitted.',

  'empty':
    'An empty command was provided. Supply a non-empty command string to run.',

} as const;
