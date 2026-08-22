"""Semantic Versioning helpers for Skill publish labels."""

from __future__ import annotations

import re
from typing import Iterable, Optional

SEMVER_CORE_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


def normalize_semver_label(version_label: str) -> str:
    label = (version_label or "").strip()
    # 兼容用户输入 v1.0.0；发布真源仍是显式 version_label。
    label = re.sub(r"^[vV]+", "", label)
    if not SEMVER_CORE_RE.fullmatch(label):
        raise ValueError(
            "version_label 必须使用 Semantic Versioning 三段格式，例如 1.0.0"
        )
    return label


def parse_semver_tuple(version_label: str) -> tuple[int, int, int]:
    label = normalize_semver_label(version_label)
    major, minor, patch = label.split(".")
    return int(major), int(minor), int(patch)


def compare_semver(left: str, right: str) -> int:
    """Return negative if left < right, zero if equal, positive if left > right."""
    l_parts = parse_semver_tuple(left)
    r_parts = parse_semver_tuple(right)
    if l_parts < r_parts:
        return -1
    if l_parts > r_parts:
        return 1
    return 0


def max_semver_label(labels: Iterable[str]) -> Optional[str]:
    best: Optional[str] = None
    for raw in labels:
        if not raw:
            continue
        try:
            label = normalize_semver_label(raw)
        except ValueError:
            continue
        if best is None or compare_semver(label, best) > 0:
            best = label
    return best


def bump_patch_semver(version_label: str) -> str:
    major, minor, patch = parse_semver_tuple(version_label)
    return f"{major}.{minor}.{patch + 1}"


def suggest_next_semver(existing_labels: Iterable[str]) -> str:
    best = max_semver_label(existing_labels)
    if not best:
        return "0.0.1"
    return bump_patch_semver(best)


def display_semver_for_published_version(
    version_label: str,
    version_seq: int,
) -> str:
    """与 Electron `coerceSemVerParts(label, version_seq)` 对齐的展示用 SemVer。"""
    if (version_label or "").strip():
        return normalize_semver_label(version_label)
    if version_seq is None or version_seq < 0:
        raise ValueError("version_seq 无效")
    return normalize_semver_label(f"{version_seq}.0.0")


def collect_published_display_semvers(
    *,
    version_label: str,
    version_seq: int,
) -> str:
    return display_semver_for_published_version(version_label, version_seq)
