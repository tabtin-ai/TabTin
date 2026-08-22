#!/usr/bin/env python3
"""Fail closed when tracked source contains credentials or company runtime config.

Findings intentionally report only rule, path, and line number. Matched values are
never printed, so the audit itself is safe to run in local or CI logs.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
import re
import subprocess
import sys


PRIVATE_KEY_BLOCK = re.compile(
    r"-----BEGIN (?P<kind>(?:RSA |EC |OPENSSH )?)PRIVATE KEY-----\s+"
    r"[A-Za-z0-9+/=\r\n]{16,}\s+"
    r"-----END (?P=kind)PRIVATE KEY-----",
    re.IGNORECASE,
)
PROVIDER_CREDENTIAL = re.compile(
    r"(?:"
    r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|"
    r"\bLTAI[0-9A-Za-z]{12,}\b|"
    r"\bsk-[A-Za-z0-9_-]{20,}\b|"
    r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b|"
    r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"
    r")"
)
CREDENTIAL_URL = re.compile(
    r"https?://(?P<username>[^\s/:@]+):(?P<password>[^\s/@]+)@(?P<host>[^\s/]+)",
    re.IGNORECASE,
)
COMPANY_ENDPOINT = re.compile(
    r"(?:"
    r"https?://|wss?://|//"
    r")[^\s\"'<>]*(?:"
    r"(?:api|collab|centrifugo|web|www|admin|assets|sourcemap)[.-]"
    r"(?:test\.|preprod\.|prod\.)?tabtin\.com|"
    r"(?:api-test|collab-test|centrifugo-test|web-test|www-test)\.tabtin\.com|"
    r"[^/\s\"'<>]*duomexing\.com"
    r")",
    re.IGNORECASE,
)
SENTRY_DSN = re.compile(r"https?://[^\s@]+@[^\s/]*ingest\.sentry\.io/\d+", re.IGNORECASE)
SENSITIVE_FILE_SUFFIXES = {
    ".key",
    ".p12",
    ".pfx",
    ".jks",
    ".keystore",
    ".mobileprovision",
}
SENSITIVE_ENV_KEY = re.compile(
    r"(?:API[_-]?KEY|UPLOAD[_-]?KEY|SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY|"
    r"ACCESS[_-]?KEY|APP[_-]?SECRET|CLIENT[_-]?SECRET|APIV3|CERT[_-]?SERIAL|"
    r"MCH[_-]?ID|FERNET|ENCRYPTION[_-]?KEY)",
    re.IGNORECASE,
)
COMPANY_CONFIG_ENV_KEY = re.compile(
    r"(?:SENTRY_(?:DSN|ORG|PROJECT|AUTH_TOKEN|URL)|"
    r"SMS_(?:SIGN_NAME|TEMPLATE_CODE)|ALIYUN_SMS_(?:SIGN_NAME|TEMPLATE_CODE)|"
    r"ALIPAY_(?:APP_ID|NOTIFY_URL|CALLBACK_URL|RETURN_URL)|"
    r"WECHAT_(?:APP_ID|MCH_ID|CERT_SERIAL|CALLBACK_URL)|"
    r"TENCENT_(?:IM_)?(?:SDK_APP_ID|PUSH_APP_ID)|"
    r"VITE_TENCENT_IM_SDK_APP_ID|APNS_(?:BUNDLE_ID|TOPIC|KEY_ID|TEAM_ID)|"
    r"APPLE_(?:TEAM_ID|APP_STORE_CONNECT_ID))",
    re.IGNORECASE,
)
SOURCE_COMPANY_LITERAL = re.compile(
    r"\b(?:ALIYUN_)?SMS_(?:SIGN_NAME|TEMPLATE_CODE)\b\s*=\s*[\"'][^\"']+[\"']",
    re.IGNORECASE,
)
SAFE_EXPLICIT_VALUES = {
    "0",
    "test",
    "dummy",
    "example",
    "change-me",
    "changeme",
    "tabtin_dev_pass",
    "django-insecure-dev-placeholder-change-before-deploy",
    "dev-placeholder-centrifugo-api-key",
    "dev-placeholder-centrifugo-proxy-secret",
    "dev-placeholder-centrifugo-token-secret",
    "com.example.tabtin",
}


@dataclass(frozen=True)
class Finding:
    rule: str
    path: str
    line: int


def _tracked_files(root: Path) -> list[str]:
    output = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=root,
    )
    return [item.decode("utf-8", errors="surrogateescape") for item in output.split(b"\0") if item]


def _is_safe_placeholder(value: str) -> bool:
    normalized = value.strip().strip('"').strip("'").strip()
    if not normalized or normalized in SAFE_EXPLICIT_VALUES:
        return True
    lowered = normalized.lower()
    if "${" in normalized or lowered.startswith(
        ("example-", "dummy-", "test-", "dev-", "local-")
    ):
        return True
    if "example" in lowered or "localhost" in lowered or "127.0.0.1" in lowered:
        return True
    return False


def _has_placeholder_credentials(line: str) -> bool:
    match = CREDENTIAL_URL.search(line)
    if not match:
        return False
    username = match.group("username").lower()
    password = match.group("password").lower()
    host = match.group("host").lower()
    if any(marker in host for marker in ("example.com", "example.org", "example.net", ".example", "localhost", "host")):
        return True
    placeholder_markers = ("example", "dummy", "test", "user", "pass")
    return any(marker in username for marker in placeholder_markers) and any(
        marker in password for marker in placeholder_markers
    )


def _env_assignment(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    key, value = stripped.removeprefix("export ").split("=", 1)
    key = key.strip()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        return None
    return key, value.strip()


def scan_text(path: str, content: str) -> list[Finding]:
    findings: list[Finding] = []
    is_env_file = Path(path).name == ".env" or ".env." in Path(path).name or Path(path).name.endswith(".env")
    for match in PRIVATE_KEY_BLOCK.finditer(content):
        findings.append(Finding("private-key", path, content.count("\n", 0, match.start()) + 1))
    for line_number, line in enumerate(content.splitlines(), start=1):
        for rule, pattern in (
            ("provider-credential", PROVIDER_CREDENTIAL),
            ("company-endpoint", COMPANY_ENDPOINT),
        ):
            if pattern.search(line):
                findings.append(Finding(rule, path, line_number))

        if CREDENTIAL_URL.search(line) and not _has_placeholder_credentials(line):
            findings.append(Finding("credential-url", path, line_number))
        if SENTRY_DSN.search(line) and "example" not in line.lower():
            findings.append(Finding("company-service-config", path, line_number))

        if SOURCE_COMPANY_LITERAL.search(line):
            findings.append(Finding("company-service-config", path, line_number))

        assignment = _env_assignment(line) if is_env_file else None
        if assignment:
            key, value = assignment
            if SENSITIVE_ENV_KEY.search(key) and not _is_safe_placeholder(value):
                findings.append(Finding("nonempty-sensitive-config", path, line_number))
            if COMPANY_CONFIG_ENV_KEY.fullmatch(key) and not _is_safe_placeholder(value):
                findings.append(Finding("company-service-config", path, line_number))
    return findings


def audit(root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for relative_path in _tracked_files(root):
        path = root / relative_path
        if path.suffix.lower() in SENSITIVE_FILE_SUFFIXES:
            findings.append(Finding("sensitive-key-file", relative_path, 1))
            continue
        try:
            content = path.read_bytes()
        except OSError:
            continue
        if b"\0" in content[:8192]:
            continue
        findings.extend(scan_text(relative_path, content.decode("utf-8", errors="replace")))
    return sorted(set(findings), key=lambda item: (item.path, item.line, item.rule))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.root.resolve()
    findings = audit(root)
    if not findings:
        print("Open-source security audit passed: 0 findings.")
        return 0
    print(f"Open-source security audit failed: {len(findings)} finding(s).")
    for finding in findings:
        print(f"{finding.path}:{finding.line} [{finding.rule}] REDACTED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
