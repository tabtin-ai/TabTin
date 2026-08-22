"""Skill 发布服务（PRD V3.3 Wave 1）。

发布流程（D2 / D5 / D13 / §6.3）：
1. 校验 owner 权限 + organization 成员关系
2. 解析 SKILL.md frontmatter
3. upsert ``Skill`` 表行（visibility / agents_json / latest_version_seq）
4. Package Registry 两阶段发布
5. 创建 ``SkillPublishedVersion`` 行 + 联动 ``Skill.latest_version_seq``
6. 触发 SkillLink sync

无兼容负担：
- 旧云端表删除 → 改写 upsert 路径到新 Skill 表
- ``visibility`` 直接写 PRD V3.3 三档（private/organization/public）
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from django.db import transaction

from apps.skills.models import Skill, SkillPublishedVersion
from apps.skills.services.bundle_validator import (
    PackageEntry,
    SkillBundleValidator,
    BundleValidationError,
)
from apps.skills.services.skill_doc_parser import parse_skill_doc

from apps.skills.services.semver_utils import normalize_semver_label

logger = logging.getLogger("skills.publish_service")


class SkillPublishError(Exception):
    """发布流程错误"""


class SkillPermissionError(SkillPublishError):
    """权限不足"""


# DB 展示名上的产品后缀（fork / 历史共享副本）。SKILL.md displayName 通常不含它们，
# 再发布同步展示名时需保留，避免列表里副本彼此难辨认。
_PRODUCT_NAME_SUFFIXES = ("(我的副本)", "（组织共享）")


def _normalize_semver_label(version_label: Optional[str]) -> Optional[str]:
    if not version_label:
        return None
    try:
        return normalize_semver_label(version_label)
    except ValueError as exc:
        raise SkillPublishError(str(exc)) from exc


def _merge_display_name_preserving_suffix(current_name: str, display_name: str) -> str:
    """用 frontmatter displayName 更新展示名，保留 DB 上已有的产品后缀。"""
    current = (current_name or "").strip()
    new = (display_name or "").strip()
    if not new:
        return current
    for suffix in _PRODUCT_NAME_SUFFIXES:
        if current.endswith(suffix):
            if new.endswith(suffix):
                return new
            return f"{new}{suffix}"
    return new


def _check_organization_membership(user_id: Optional[UUID], organization_id: Optional[UUID]) -> None:
    """校验用户是否为 organization 成员且角色 ≥ editor。"""
    if not organization_id:
        return
    if not user_id:
        raise SkillPermissionError("发布需要登录用户")
    try:
        from apps.services.package_registry.services import check_package_write_access
        check_package_write_access(
            user_id=str(user_id),
            organization_id=str(organization_id),
            min_role="editor",
        )
    except PermissionError as exc:
        raise SkillPermissionError(
            "用户不是该 Organization 的成员或角色不足，无权发布 Skill"
        ) from exc


class SkillPublishService:
    """Skill 发布生命周期。"""

    @staticmethod
    def publish_from_zip(
        zip_bytes: bytes,
        *,
        visibility: str = Skill.VISIBILITY_PRIVATE,
        user_id: Optional[UUID] = None,
        organization_id: Optional[UUID] = None,
        change_note: str = "",
        known_skill: Optional[Skill] = None,
        version_label: Optional[str] = None,
        quick_use_json: Optional[List[Dict[str, Any]]] = None,
    ) -> Skill:
        """完整发布流程。

        1. 安全校验：organization 成员
        2. validate_and_extract zip
        3. 解析 SKILL.md frontmatter
        4. upsert Skill 行
        5. PR 两阶段发布
        6. 创建 SkillPublishedVersion
        7. 联动 SkillLink sync
        """
        _check_organization_membership(user_id, organization_id)

        try:
            entries = SkillBundleValidator.validate_and_extract(zip_bytes)
        except BundleValidationError as exc:
            raise SkillPublishError(str(exc)) from exc

        entries = _strip_skill_md_versions_from_entries(entries)
        doc_entry = _find_skill_md(entries)
        doc_text = doc_entry.content.decode("utf-8", errors="replace")
        parsed = parse_skill_doc(doc_text)

        slug = (parsed.get("name") or _infer_slug_from_entries(entries) or "").strip()
        if not slug:
            raise SkillPublishError("无法确定 slug：SKILL.md 缺少 name 字段")

        from apps.skills.services.slug_utils import slugify_skill_name

        slug = slugify_skill_name(slug)

        normalized_visibility = (visibility or "").strip().lower()
        if normalized_visibility not in {
            Skill.VISIBILITY_PRIVATE,
            Skill.VISIBILITY_ORGANIZATION,
            Skill.VISIBILITY_PUBLIC,
        }:
            normalized_visibility = Skill.VISIBILITY_PRIVATE

        effective_version_label = _normalize_semver_label(version_label)
        if not effective_version_label:
            raise SkillPublishError(
                "缺少发布版本号 version_label（Semantic Versioning 三段，如 0.0.1）"
            )

        # frontmatter 顶层 `name` 是 kebab 机器 id；人类可读展示名在
        # metadata.tabtin.displayName（parse_skill_doc → display_name）。
        # Skill.name / API display_name 存的是展示名，不能把 kebab 写进去。
        name = (parsed.get("display_name") or "").strip() or (parsed.get("name") or slug)
        description = parsed.get("description") or ""
        agents_json = parsed.get("agents_json") or parsed.get("agents") or []
        if not isinstance(agents_json, list):
            agents_json = []

        if known_skill is not None:
            skill = known_skill
            fields_changed: list[str] = []
            # 再发布时同步展示名：用户在编辑器改了 displayName 后，列表/详情
            # 读的是 DB Skill.name（to_index_entry → display_name）。
            # 只用 display_name，绝不用 kebab `name`；若 DB 名带产品后缀则保留。
            display_name = (parsed.get("display_name") or "").strip()
            if display_name:
                merged_name = _merge_display_name_preserving_suffix(skill.name, display_name)
                if skill.name != merged_name:
                    skill.name = merged_name
                    fields_changed.append("name")
            elif not (skill.name or "").strip():
                skill.name = name
                fields_changed.append("name")
            if skill.description != description:
                skill.description = description
                fields_changed.append("description")
            if list(skill.agents_json or []) != list(agents_json or []):
                skill.agents_json = agents_json
                fields_changed.append("agents_json")
            if fields_changed:
                skill.save(update_fields=fields_changed + ["updated_at"])
        else:
            with transaction.atomic():
                skill = _upsert_skill(
                    owner_user_id=user_id,
                    slug=slug,
                    name=name,
                    description=description,
                    visibility=normalized_visibility,
                    organization_id=organization_id,
                    agents_json=agents_json,
                )

        # 走 PR 两阶段发布
        manifest = dict(parsed)
        manifest.pop("version", None)
        bundle_sha256, package_id, version_seq, effective_version_label, oss_key = _publish_to_package_registry(
            skill=skill,
            entries=entries,
            user_id=user_id,
            organization_id=organization_id,
            version_label=effective_version_label,
            manifest=manifest,
        )

        # 写 SkillPublishedVersion 行
        review_status = (
            SkillPublishedVersion.REVIEW_PENDING
            if normalized_visibility == Skill.VISIBILITY_PUBLIC
            else SkillPublishedVersion.REVIEW_NOT_REQUIRED
        )

        # 快速使用 preset 列表：显式传入则覆盖草稿，否则沿用 skill 上已有草稿；
        # 两种情况都把「当前生效」的列表快照进本版本（随版本不可变）。
        effective_quick_use = (
            quick_use_json if quick_use_json is not None else (skill.quick_use_json or [])
        )

        with transaction.atomic():
            SkillPublishedVersion.objects.update_or_create(
                skill=skill,
                version_seq=version_seq,
                defaults={
                    "version_label": effective_version_label or "",
                    "bundle_oss_key": oss_key or "",
                    "bundle_sha256": bundle_sha256,
                    "change_note": change_note or "",
                    "published_by": str(user_id) if user_id else None,
                    "review_status": review_status,
                    "quick_use_json": effective_quick_use or [],
                },
            )

            skill.latest_version_seq = version_seq
            skill.package_id = package_id
            skill.install_content_hash = bundle_sha256
            skill_update_fields = [
                "latest_version_seq", "package_id", "install_content_hash", "updated_at",
            ]
            if quick_use_json is not None:
                skill.quick_use_json = quick_use_json
                skill_update_fields.append("quick_use_json")
            skill.save(update_fields=skill_update_fields)

        _trigger_side_effects(skill)

        logger.info(
            "publish_service.published skill=%s slug=%s version=%s package_id=%s",
            skill.skill_id, skill.slug, version_seq, package_id,
        )
        return skill

    @staticmethod
    def set_visibility(skill: Skill, visibility: str) -> Skill:
        """切换可见范围（D5）。

        ⚠️ 仅控制谁能新启用，不影响已启用者（PRD §6.4）。
        """
        target = (visibility or "").strip().lower()
        if target not in {
            Skill.VISIBILITY_PRIVATE,
            Skill.VISIBILITY_ORGANIZATION,
            Skill.VISIBILITY_PUBLIC,
        }:
            raise SkillPublishError(f"无效 visibility: {visibility!r}")
        skill.visibility = target
        skill.save(update_fields=["visibility", "updated_at"])
        logger.info("publish_service.visibility skill=%s -> %s", skill.skill_id, target)
        return skill


# ---------------------------------------------------------------------------
# 内部辅助
# ---------------------------------------------------------------------------


def _find_skill_md(entries: List[PackageEntry]) -> PackageEntry:
    for e in entries:
        if e.file_path.endswith("SKILL.md"):
            return e
    raise SkillPublishError("SKILL.md 未找到（应由 validator 保证）")


def strip_skill_md_file_version(content: str) -> str:
    """Remove legacy file-maintained version fields from SKILL.md frontmatter."""
    import re

    stripped = content.lstrip()
    leading = content[:len(content) - len(stripped)]
    if not stripped.startswith("---"):
        return content

    match = re.match(r"^(---\s*\n)(.*?)(\n---\s*\n?)(.*)$", stripped, re.DOTALL)
    if not match:
        return content

    start, body, end, rest = match.groups()
    lines = body.split("\n")
    stack: list[tuple[int, str]] = []
    next_lines: list[str] = []

    for line in lines:
        stripped_line = line.strip()
        if not stripped_line or stripped_line.startswith("#") or ":" not in stripped_line:
            next_lines.append(line)
            continue

        key = stripped_line.split(":", 1)[0].strip()
        indent = len(line) - len(line.lstrip(" "))
        while stack and stack[-1][0] >= indent:
            stack.pop()
        parent = stack[-1] if stack else None
        should_drop = (
            key == "version"
            and (indent == 0 or (parent is not None and parent == (0, "metadata")))
        )

        value = stripped_line.split(":", 1)[1].strip()
        if not should_drop:
            next_lines.append(line)
            if value == "":
                stack.append((indent, key))

    return leading + start + "\n".join(next_lines) + end + rest


def _strip_skill_md_versions_from_entries(entries: List[PackageEntry]) -> List[PackageEntry]:
    next_entries: List[PackageEntry] = []
    for entry in entries:
        if entry.file_path != "SKILL.md" and not entry.file_path.endswith("/SKILL.md"):
            next_entries.append(entry)
            continue
        content = strip_skill_md_file_version(entry.content.decode("utf-8", errors="replace")).encode("utf-8")
        next_entries.append(PackageEntry(
            file_path=entry.file_path,
            content=content,
            size=len(content),
        ))
    return next_entries


def _infer_slug_from_entries(entries: List[PackageEntry]) -> str:
    for e in entries:
        parts = e.file_path.split("/")
        if len(parts) >= 2 and parts[-1] == "SKILL.md":
            return parts[-2]
    return ""


def _slugify(raw: str) -> str:
    """向后兼容别名；新代码请用 ``slug_utils.slugify_skill_name``。"""
    from apps.skills.services.slug_utils import slugify_skill_name

    return slugify_skill_name(raw)


def _resolve_unique_slug(*, owner_user_id: UUID, slug: str, current_skill_id: Optional[UUID] = None) -> str:
    """同 owner 内 slug 冲突时自动加 -2 / -3 后缀（W0 决策 3 V2）。"""
    if not owner_user_id:
        return slug
    existing = Skill.objects.filter(owner_user_id=owner_user_id, slug=slug)
    if current_skill_id:
        existing = existing.exclude(skill_id=current_skill_id)
    if not existing.exists():
        return slug
    n = 2
    while True:
        candidate = f"{slug}-{n}"
        existing = Skill.objects.filter(owner_user_id=owner_user_id, slug=candidate)
        if current_skill_id:
            existing = existing.exclude(skill_id=current_skill_id)
        if not existing.exists():
            return candidate
        n += 1
        if n > 100:
            raise SkillPublishError("slug 冲突解决失败（重试 100 次）")


def _compute_file_sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _prepare_file_dicts(entries: List[PackageEntry]) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []
    for e in entries:
        sha = _compute_file_sha256(e.content)
        result.append({
            "file_path": e.file_path,
            "content": e.content,
            "size": e.size,
            "sha256": sha,
            "content_type": _guess_content_type(e.file_path),
        })
    return result


def _upsert_skill(
    *,
    owner_user_id: Optional[UUID],
    slug: str,
    name: str,
    description: str,
    visibility: str,
    organization_id: Optional[UUID],
    agents_json: List[Dict[str, Any]],
) -> Skill:
    """创建或更新 Skill 行。"""
    if not owner_user_id:
        raise SkillPublishError("缺少 owner_user_id（user_id），无法发布")

    skill = Skill.objects.filter(owner_user_id=owner_user_id, slug=slug).first()
    if skill is None:
        unique_slug = _resolve_unique_slug(owner_user_id=owner_user_id, slug=slug)
        skill = Skill.objects.create(
            owner_user_id=owner_user_id,
            slug=unique_slug,
            name=name,
            description=description,
            visibility=visibility,
            organization_id=organization_id if visibility == Skill.VISIBILITY_ORGANIZATION else None,
            agents_json=agents_json,
        )
        logger.info("publish_service.upsert created skill=%s slug=%s", skill.skill_id, skill.slug)
        return skill

    fields_changed: list[str] = []
    if skill.name != name:
        skill.name = name
        fields_changed.append("name")
    if skill.description != description:
        skill.description = description
        fields_changed.append("description")
    if skill.visibility != visibility:
        skill.visibility = visibility
        fields_changed.append("visibility")
    target_organization = organization_id if visibility == Skill.VISIBILITY_ORGANIZATION else None
    if skill.organization_id != target_organization:
        skill.organization_id = target_organization
        fields_changed.append("organization_id")
    if list(skill.agents_json or []) != list(agents_json or []):
        skill.agents_json = agents_json
        fields_changed.append("agents_json")
    if fields_changed:
        skill.save(update_fields=fields_changed + ["updated_at"])
        logger.debug("publish_service.upsert updated skill=%s fields=%s", skill.skill_id, fields_changed)
    return skill


def _trigger_side_effects(skill: Skill) -> None:
    """发布后联动操作（SkillLink sync）。"""
    try:
        from apps.capabilities.services.skill_link_sync import SkillLinkSyncService
        # 用 canonical key 作为 skill_key 给下游（保持 ToolSkillLink.skill_key 字符串语义）
        SkillLinkSyncService.sync_skill_links(
            skill_key=skill.canonical_key,
            doc_content="",
            metadata={"agents": skill.agents_json or []},
        )
    except Exception:
        logger.debug("publish_service.skill_link_sync failed", exc_info=True)


def _publish_to_package_registry(
    *,
    skill: Skill,
    entries: List[PackageEntry],
    user_id: Optional[UUID],
    organization_id: Optional[UUID],
    version_label: Optional[str],
    manifest: Dict[str, Any],
) -> tuple[str, UUID, int, str, str]:
    """走 PR 两阶段发布。

    返回 (bundle_sha256, package_id, version_seq, version_label, oss_key_hint)。
    """
    if not organization_id or not user_id:
        raise SkillPublishError("Package Registry 发布需要 organization_id 和 user_id")

    from apps.services.package_registry import services as pr_svc
    from apps.services.package_registry.models import PackageVersion

    pr_namespace = (skill.slug or "default").lower().replace(" ", "-")
    pr_name = skill.slug.lower().replace(" ", "-")
    uid = str(user_id)
    wt_id = str(organization_id)

    try:
        pkg = pr_svc.lookup_package(namespace=pr_namespace, name=pr_name)
    except LookupError:
        pkg = pr_svc.create_package(
            namespace=pr_namespace,
            name=pr_name,
            organization_id=wt_id,
            created_by=uid,
            metadata={"type": "skill"},
        )

    file_dicts = _prepare_file_dicts(entries)
    init_files = []
    for fd in file_dicts:
        init_files.append({
            "path": fd["file_path"],
            "sha256": fd["sha256"],
            "size": fd.get("size", 0),
            "content_type": fd.get("content_type", "application/octet-stream"),
        })

    init_result = pr_svc.init_version(
        package=pkg,
        files=init_files,
        manifest=manifest,
        version_label=version_label,
        user_id=uid,
    )

    from apps.services.oss.services.factory import get_oss_service
    oss = get_oss_service()
    content_map = {e.file_path: e.content for e in entries}
    for task in init_result["upload_tasks"]:
        if task["action"] == "upload":
            file_content = content_map.get(task["path"], b"")
            oss.upload_bytes(
                file_content,
                task["oss_object_key"],
                content_type=_guess_content_type(task["path"]),
            )

    version_obj = PackageVersion.objects.get(id=init_result["version_id"])
    bundle = pr_svc.compute_bundle_sha256(
        [(f["path"], f["sha256"]) for f in init_files]
    )
    finalize_result = pr_svc.finalize_version(
        package=pkg,
        version=version_obj,
        bundle_sha256=bundle,
        init_files=init_files,
        user_id=uid,
    )

    return (
        bundle,
        pkg.id,
        finalize_result["version_seq"],
        finalize_result.get("version_label") or "",
        # OSS bundle 路径不在 finalize 返回，这里取首文件 OSS key 作 hint
        next((task.get("oss_object_key", "") for task in init_result["upload_tasks"]), ""),
    )


def _guess_content_type(file_path: str) -> str:
    from apps.services.package_registry.utils import guess_content_type
    return guess_content_type(file_path)


__all__ = ["SkillPublishService", "SkillPublishError", "SkillPermissionError"]
