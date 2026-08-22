"""User Skill slug 规范化（kebab-case 约定）。"""

from __future__ import annotations

import re

MAX_SKILL_SLUG_LENGTH = 64
KEBAB_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def slugify_skill_name(raw: str) -> str:
    """将用户输入转为 kebab-case slug（创建 / 发布 / fork 共用）。"""
    s = (raw or "").strip().lower()
    cleaned: list[str] = []
    for ch in s:
        # 只接受 ASCII a-z0-9（与前端 skillSlug.slugifySkillName 的 /[a-z0-9-]/ 对齐）。
        # 注意：不能用 ch.isalnum()——Python 对中文等非 ASCII 也返回 True，会把
        # 「导入」这类字符原样留进 slug，导致 resolve-path 的 kebab 校验拒掉。
        if ("a" <= ch <= "z") or ("0" <= ch <= "9") or ch == "-":
            cleaned.append(ch)
        elif ch in {" ", "_", "/", "\\"}:
            cleaned.append("-")
    result = "".join(cleaned)
    while "--" in result:
        result = result.replace("--", "-")
    result = result.strip("-") or "skill"
    if len(result) > MAX_SKILL_SLUG_LENGTH:
        result = result[:MAX_SKILL_SLUG_LENGTH].rstrip("-") or "skill"
    return result


def is_valid_kebab_slug(slug: str) -> bool:
    return bool(slug) and bool(KEBAB_SLUG_RE.match(slug)) and len(slug) <= MAX_SKILL_SLUG_LENGTH
