"""
Auto-generated from packages/security-policy/src/critical-rules.json
DO NOT EDIT MANUALLY — run `python scripts/codegen-security-rules.py` to regenerate.
"""

import re


CRITICAL_DENY_RULES: list[tuple[str, re.Pattern, bool]] = [
    ("pipe-to-shell", re.compile(r"\|\s*(?:\/(?:usr\/(?:local\/)?)?bin\/)?(?:(?:ba)?sh|env\s+(?:-\S+\s+)*(?:ba)?sh)\b", re.IGNORECASE), True),
    ("curl-pipe-exec", re.compile(r"\b(curl|wget)\b.*\|\s*(?:\/(?:usr\/(?:local\/)?)?bin\/)?(?:(?:ba)?sh|env\s+(?:-\S+\s+)*(?:ba)?sh)\b", re.IGNORECASE), True),
    ("process-substitution-shell", re.compile(r"(?:\/(?:usr\/(?:local\/)?)?bin\/)?(?:(?:ba)?sh|env\s+(?:-\S+\s+)*(?:ba)?sh)\s+<\s*\(", re.IGNORECASE), True),
    ("process-substitution-input", re.compile(r"<\s*\(\s*(curl|wget|nc|ncat)\b", re.IGNORECASE), True),
    ("process-substitution-output", re.compile(r">\s*\(\s*(?:\/(?:usr\/(?:local\/)?)?bin\/)?(?:(?:ba)?sh|env\s+(?:-\S+\s+)*(?:ba)?sh)\b", re.IGNORECASE), True),
    ("python-inline", re.compile(r"\bpython3?\s+-c\b", re.IGNORECASE), False),
    ("node-inline", re.compile(r"\bnode\s+(-e|--eval)\b", re.IGNORECASE), False),
    ("curl-write-file", re.compile(r"\bcurl\b.*\s(-o\s+|-O\b|--output[\s=])", re.IGNORECASE), False),
    ("curl-upload", re.compile(r"\bcurl\b.*\s(-T\s+|--upload-file[\s=])", re.IGNORECASE), False),
    ("curl-exfil", re.compile(r"\bcurl\b.*(-d\s+@|--data[^\s]*\s+@|-F\s+[^\s]*@)", re.IGNORECASE), False),
    ("redirect-write", re.compile(r">\s*[^\s&|]", 0), False),
    ("export-env-injection", re.compile(r"\bexport\s+(LD_PRELOAD|DYLD_INSERT_LIBRARIES|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|LD_AUDIT|LD_DEBUG|LD_PROFILE|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|GLOBIGNORE|PROMPT_COMMAND)\b", re.IGNORECASE), False),
    ("export-path-hijack", re.compile(r'''\bexport\s+PATH\s*=\s*["']?\/(?:tmp|var\/tmp|dev\/shm)\b''', re.IGNORECASE), False),
]


PRE_SPLIT_RULES = [(n, p) for n, p, ps in CRITICAL_DENY_RULES if ps]
POST_SPLIT_RULES = [(n, p) for n, p, ps in CRITICAL_DENY_RULES if not ps]
ALL_RULES = [(n, p) for n, p, ps in CRITICAL_DENY_RULES]
