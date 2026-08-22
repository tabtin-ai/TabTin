"""
OSS 安全相关共享常量

将 MIME 类型黑名单分为两层：
- DANGEROUS_EXECUTABLE_MIMES: 可执行文件类型，所有场景一律拦截
- DANGEROUS_WEB_CONTENT_MIMES: Web 内容类型，TabSite 场景允许，TabData 场景拦截
"""

DANGEROUS_EXECUTABLE_MIMES: frozenset[str] = frozenset({
    # PHP
    'application/x-httpd-php',
    'application/x-php',
    'text/x-php',
    # Shell / Bash
    'application/x-sh',
    'application/x-shellscript',
    'application/x-csh',
    'text/x-shellscript',
    # Windows executables / installers
    'application/x-msdownload',
    'application/x-msdos-program',
    'application/x-executable',
    'application/vnd.microsoft.portable-executable',
    'application/x-dosexec',
    'application/x-bat',
    'application/x-msi',
    # HTA (HTML Application)
    'application/hta',
    # Scripting languages
    'text/x-python',
    'application/x-python-code',
    'text/x-perl',
    'text/x-ruby',
    # Java archives (executable code)
    'application/java-archive',
})

DANGEROUS_WEB_CONTENT_MIMES: frozenset[str] = frozenset({
    'text/html',
    'application/xhtml+xml',
    'application/javascript',
    'text/javascript',
    'application/x-javascript',
    'image/svg+xml',
})
