"""把历史组织精选引用迁移为成员个人 Skill 快照。

0022 只建立 ``copied_from_skill`` 身份字段和幂等约束；本迁移单独回填数据，
避免 DDL 与长数据操作混在一个 migration。历史接入事实取三者并集：

- AgentSkillLink：精确记录 source skill 与 Agent owner；
- SkillEnablement：精确记录 source skill 与设备 owner；
- UserSkillPreference：只有 canonical key，须结合组织成员关系唯一解析来源。

设备安装账本不改写成新 key，因为服务端不能伪造客户端磁盘目录已经改名；旧账
本删除后，客户端会按个人副本重新物化并上报。反向迁移为 noop：个人副本在迁移
后可能已被用户编辑，不能安全合回组织分发快照。
"""

import logging

from django.db import migrations, transaction


logger = logging.getLogger(__name__)


def _unique_copy_slug(Skill, *, alias, user_id, source_slug):
    base = f"{source_slug}-copy"
    existing = set(
        Skill.objects.using(alias)
        .filter(owner_user_id=user_id, slug__startswith=base)
        .values_list("slug", flat=True)
    )
    if base not in existing:
        return base
    suffix = 2
    while f"{base}-{suffix}" in existing:
        suffix += 1
    return f"{base}-{suffix}"


def _copy_snapshot(apps, *, alias, source, user_id):
    Skill = apps.get_model("skills", "Skill")
    SkillPublishedVersion = apps.get_model("skills", "SkillPublishedVersion")

    existing = (
        Skill.objects.using(alias)
        .filter(owner_user_id=user_id, copied_from_skill_id=source.skill_id)
        .first()
    )
    if existing:
        return existing

    acquired = Skill.objects.using(alias).create(
        owner_user_id=user_id,
        slug=_unique_copy_slug(
            Skill,
            alias=alias,
            user_id=user_id,
            source_slug=source.slug,
        ),
        name=source.name,
        description=source.description,
        emoji=source.emoji,
        category=source.category,
        source="user",
        visibility="private",
        organization_id=None,
        copied_from_skill_id=source.skill_id,
        latest_version_seq=source.latest_version_seq,
        package_id=source.package_id,
        agents_json=source.agents_json,
        quick_use_json=source.quick_use_json,
        install_content_hash=source.install_content_hash,
    )
    versions = SkillPublishedVersion.objects.using(alias).filter(skill_id=source.skill_id)
    SkillPublishedVersion.objects.using(alias).bulk_create(
        [
            SkillPublishedVersion(
                skill_id=acquired.skill_id,
                version_seq=version.version_seq,
                version_label=version.version_label,
                bundle_oss_key=version.bundle_oss_key,
                bundle_sha256=version.bundle_sha256,
                local_content_hash=version.local_content_hash,
                quick_use_json=version.quick_use_json,
                change_note=version.change_note,
                published_by=version.published_by,
                review_status="not_required",
            )
            for version in versions.iterator(chunk_size=200)
        ],
        batch_size=200,
    )
    return acquired


def backfill_organization_skill_acquisitions(apps, schema_editor):
    alias = schema_editor.connection.alias
    Skill = apps.get_model("skills", "Skill")
    AgentSkillLink = apps.get_model("skills", "AgentSkillLink")
    SkillEnablement = apps.get_model("skills", "SkillEnablement")
    UserSkillPreference = apps.get_model("skills", "UserSkillPreference")
    OrganizationMember = apps.get_model("tabtinspace", "OrganizationMember")

    sources = list(
        Skill.objects.using(alias)
        .filter(visibility="organization", organization_id__isnull=False)
        .order_by("skill_id")
    )
    if not sources:
        return

    source_by_id = {str(source.skill_id): source for source in sources}
    sources_by_key = {}
    for source in sources:
        sources_by_key.setdefault(f"user:{source.slug}", []).append(source)

    acquisition_pairs = set()
    for source_id, user_id in (
        AgentSkillLink.objects.using(alias)
        .filter(skill_id__in=source_by_id)
        .exclude(agent__owner_user_id__isnull=True)
        .values_list("skill_id", "agent__owner_user_id")
        .iterator(chunk_size=500)
    ):
        source_key = str(source_id)
        user_key = str(user_id)
        if user_key != str(source_by_id[source_key].owner_user_id):
            acquisition_pairs.add((source_key, user_key))

    for source_id, user_id in (
        SkillEnablement.objects.using(alias)
        .filter(skill_id__in=source_by_id)
        .exclude(device__user_id__isnull=True)
        .values_list("skill_id", "device__user_id")
        .iterator(chunk_size=500)
    ):
        source_key = str(source_id)
        user_key = str(user_id)
        if user_key != str(source_by_id[source_key].owner_user_id):
            acquisition_pairs.add((source_key, user_key))

    preferences = list(
        UserSkillPreference.objects.using(alias)
        .filter(skill_canonical_key__in=sources_by_key)
        .values("user_id", "skill_canonical_key", "enabled")
        .iterator(chunk_size=500)
    )
    preference_by_pair = {}
    membership_cache = {}
    owned_slugs_cache = {}
    ambiguous_preferences = 0
    for preference in preferences:
        user_id = str(preference["user_id"])
        key = preference["skill_canonical_key"]
        exact_sources = [
            source
            for source in sources_by_key[key]
            if (str(source.skill_id), user_id) in acquisition_pairs
        ]
        if exact_sources:
            candidates = exact_sources
        else:
            if user_id not in membership_cache:
                membership_cache[user_id] = set(
                    OrganizationMember.objects.using(alias)
                    .filter(user_id=user_id)
                    .values_list("organization_id", flat=True)
                )
            if user_id not in owned_slugs_cache:
                owned_slugs_cache[user_id] = set(
                    Skill.objects.using(alias)
                    .filter(owner_user_id=user_id)
                    .values_list("slug", flat=True)
                )
            candidates = [
                source
                for source in sources_by_key[key]
                if source.organization_id in membership_cache[user_id]
                and source.owner_user_id != user_id
                and source.slug not in owned_slugs_cache[user_id]
            ]
            if len(candidates) != 1:
                if candidates:
                    ambiguous_preferences += 1
                continue

        for source in candidates:
            source_id = str(source.skill_id)
            acquisition_pairs.add((source_id, user_id))
            preference_by_pair[(source_id, user_id)] = preference["enabled"]

    migrated_pairs = 0
    migrated_links = 0
    removed_installs = 0
    migrated_preference_ids = set()
    for source_id, user_id in sorted(
        acquisition_pairs,
        key=lambda pair: (str(pair[0]), str(pair[1])),
    ):
        with transaction.atomic(using=alias):
            source = source_by_id[source_id]
            acquired = _copy_snapshot(
                apps,
                alias=alias,
                source=source,
                user_id=user_id,
            )
            acquired_key = f"user:{acquired.slug}"

            legacy_links = list(
                AgentSkillLink.objects.using(alias).filter(
                    skill_id=source_id,
                    agent__owner_user_id=user_id,
                )
            )
            for legacy in legacy_links:
                target, created = AgentSkillLink.objects.using(alias).get_or_create(
                    agent_id=legacy.agent_id,
                    skill_canonical_key=acquired_key,
                    defaults={
                        "skill_id": acquired.skill_id,
                        "source": "user",
                        "enabled": legacy.enabled,
                        "config_json": legacy.config_json,
                    },
                )
                if not created:
                    target.skill_id = acquired.skill_id
                    target.source = "user"
                    target.enabled = legacy.enabled
                    target.config_json = legacy.config_json
                    target.save(
                        using=alias,
                        update_fields=[
                            "skill_id",
                            "source",
                            "enabled",
                            "config_json",
                            "updated_at",
                        ],
                    )
                legacy.delete(using=alias)
                migrated_links += 1

            preference_pair = (source_id, user_id)
            if preference_pair in preference_by_pair:
                UserSkillPreference.objects.using(alias).update_or_create(
                    user_id=user_id,
                    skill_canonical_key=acquired_key,
                    defaults={"enabled": preference_by_pair[preference_pair]},
                )
                migrated_preference_ids.add((user_id, f"user:{source.slug}"))

            installs = SkillEnablement.objects.using(alias).filter(
                skill_id=source_id,
                device__user_id=user_id,
            )
            install_count = installs.count()
            if install_count:
                installs.delete()
                removed_installs += install_count
            migrated_pairs += 1

    for user_id, old_key in migrated_preference_ids:
        UserSkillPreference.objects.using(alias).filter(
            user_id=user_id,
            skill_canonical_key=old_key,
        ).delete()

    logger.info(
        "[OrganizationSkillAcquisitionBackfill] done: pairs=%d links=%d "
        "removed_installs=%d ambiguous_preferences=%d",
        migrated_pairs,
        migrated_links,
        removed_installs,
        ambiguous_preferences,
    )


class Migration(migrations.Migration):

    atomic = False

    dependencies = [
        ("skills", "0022_skill_copied_from_skill"),
    ]

    operations = [
        migrations.RunPython(
            backfill_organization_skill_acquisitions,
            migrations.RunPython.noop,
        ),
    ]
