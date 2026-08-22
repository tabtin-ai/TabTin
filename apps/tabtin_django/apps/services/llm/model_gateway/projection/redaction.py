import hashlib


def safe_summary(value: str) -> str:
    return f"redacted-summary:{hashlib.sha256(value.encode()).hexdigest()[:12]}"

