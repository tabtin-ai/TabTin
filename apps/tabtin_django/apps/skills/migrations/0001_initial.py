"""Skills Wave 1 初始 migration（PRD V3.3 / W0 决策）。

旧 9 个 migration 一次性删除（无兼容负担元原则）。
此 migration 在 PostgreSQL 上 fresh migrate 三张新表。
"""

import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Skill",
            fields=[
                (
                    "skill_id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        help_text=(
                            "全局唯一身份（PRD U1）。UI 上不展示，仅作内部标识。"
                        ),
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "owner_user_id",
                    models.UUIDField(
                        db_index=True,
                        help_text="owner（不可变）。跨库软引用 users_auth.User。",
                    ),
                ),
                (
                    "slug",
                    models.CharField(
                        help_text=(
                            "给人 / LLM 看的 kebab-case 可读名（W0 决策 3 V2）。"
                            "canonical key = ``user:<slug>``，sandbox 目录命名 = slug。"
                            "同 owner 内唯一；冲突时由服务层自动加 -2 / -3 后缀。"
                        ),
                        max_length=128,
                    ),
                ),
                (
                    "name",
                    models.CharField(
                        help_text="UI 展示名（用户随时可改）。",
                        max_length=128,
                    ),
                ),
                ("description", models.TextField(blank=True, default="")),
                ("emoji", models.CharField(blank=True, default="", max_length=8)),
                (
                    "source",
                    models.CharField(
                        choices=[("user", "User")],
                        default="user",
                        help_text=(
                            "Skill 表只存 user 来源（D19）；platform / app / device 三档由 "
                            "LocalSkillRegistry 扫描索引，不进此表。"
                        ),
                        max_length=16,
                    ),
                ),
                (
                    "visibility",
                    models.CharField(
                        choices=[
                            ("private", "Private"),
                            ("workteam", "Workteam"),
                            ("public", "Public"),
                        ],
                        default="private",
                        help_text=(
                            "Skill 级可见范围（D5）。仅控制谁能新启用，不影响已启用者。"
                        ),
                        max_length=16,
                    ),
                ),
                (
                    "workteam_id",
                    models.UUIDField(
                        blank=True,
                        db_index=True,
                        help_text="visibility=workteam 时归属 workteam（跨库软引用）。",
                        null=True,
                    ),
                ),
                (
                    "latest_version_seq",
                    models.PositiveIntegerField(
                        blank=True,
                        help_text="指向 SkillPublishedVersion.version_seq；纯草稿态为 NULL。",
                        null=True,
                    ),
                ),
                (
                    "package_id",
                    models.UUIDField(
                        blank=True,
                        db_index=True,
                        help_text="关联 Package Registry 的 Package（跨库软引用）。",
                        null=True,
                    ),
                ),
                (
                    "agents_json",
                    models.JSONField(
                        blank=True,
                        default=list,
                        help_text=(
                            "Skill 包含的 sub-agent 角色定义（agents/*.md frontmatter）。"
                            "AgentSyncService 据此同步到 SubAgentTemplate（W0 决策补丁 1）。"
                        ),
                    ),
                ),
                (
                    "install_content_hash",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text=(
                            "服务端记录的最新发布版本内容 hash（D11，与 PR bundle_sha256 对齐）。"
                            "客户端启用时拷贝到 SkillEnablement.install_content_hash。"
                        ),
                        max_length=64,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "verbose_name": "Skill",
                "verbose_name_plural": "Skills",
                "db_table": "skills_skill",
                "ordering": ["-updated_at"],
            },
        ),
        migrations.AddIndex(
            model_name="skill",
            index=models.Index(
                fields=["owner_user_id"], name="skills_skil_owner_u_3eba37_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="skill",
            index=models.Index(
                fields=["workteam_id", "visibility"],
                name="skills_skil_worktea_5f6c0a_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="skill",
            index=models.Index(
                fields=["visibility"], name="skills_skil_visibil_60f527_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="skill",
            index=models.Index(
                fields=["package_id"], name="skills_skil_package_a4f1e0_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="skill",
            constraint=models.UniqueConstraint(
                fields=("owner_user_id", "slug"), name="uq_skill_owner_slug",
            ),
        ),
        migrations.CreateModel(
            name="SkillEnablement",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False,
                        primary_key=True, serialize=False,
                    ),
                ),
                (
                    "user_id",
                    models.UUIDField(
                        db_index=True,
                        help_text="启用者（跨库软引用 User）。",
                    ),
                ),
                (
                    "space_id",
                    models.UUIDField(
                        db_index=True,
                        help_text="Space 级隔离（跨库软引用 Space）。",
                    ),
                ),
                (
                    "skill_id",
                    models.UUIDField(
                        blank=True,
                        db_index=True,
                        help_text=(
                            "user 来源时指向 Skill 表行；platform/app/device 来源为 NULL。"
                        ),
                        null=True,
                    ),
                ),
                (
                    "skill_canonical_key",
                    models.CharField(
                        db_index=True,
                        help_text=(
                            "Canonical key（用于 LocalSkillRegistry 检索）。"
                            "格式：user:<slug> / platform:<id> / app:<app_id>/<id> / device:<id>。"
                        ),
                        max_length=160,
                    ),
                ),
                (
                    "source",
                    models.CharField(
                        help_text=(
                            "冗余 source 标记，便于按来源过滤（platform/app/device/user）。"
                        ),
                        max_length=16,
                    ),
                ),
                (
                    "installed_version_seq",
                    models.PositiveIntegerField(
                        blank=True,
                        help_text=(
                            "当前本地装的版本（D3 启用时拉最新）；NULL 表示纯草稿（D16 owner 创建即启用）。"
                            "platform / app / device 来源 = NULL（跟代码走，无云端版本）。"
                        ),
                        null=True,
                    ),
                ),
                (
                    "install_content_hash",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text=(
                            "启用时记录的内容 hash（D11）。当前本地 hash 与此值不一致 = 已修改。"
                            "用 D11 算法（PR Merkle root + user 场景 ignore 列表扩充）。"
                        ),
                        max_length=64,
                    ),
                ),
                (
                    "config_json",
                    models.JSONField(
                        blank=True,
                        default=dict,
                        help_text=(
                            "用户对该 Skill 的私有配置（credential_id / env / config）。"
                            "等价于旧 SpaceAppSettings.skill_configs[skill_key] 的整个 dict。"
                        ),
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "verbose_name": "Skill Enablement",
                "verbose_name_plural": "Skill Enablements",
                "db_table": "skills_enablement",
            },
        ),
        migrations.AddIndex(
            model_name="skillenablement",
            index=models.Index(
                fields=["user_id", "space_id"],
                name="skills_enab_user_id_a31cc7_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="skillenablement",
            index=models.Index(
                fields=["skill_id"], name="skills_enab_skill_i_f3f7f2_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="skillenablement",
            index=models.Index(
                fields=["skill_canonical_key"],
                name="skills_enab_skill_c_e8b1c5_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="skillenablement",
            constraint=models.UniqueConstraint(
                fields=("user_id", "space_id", "skill_canonical_key"),
                name="uq_enablement_user_space_skill",
            ),
        ),
        migrations.CreateModel(
            name="SkillPublishedVersion",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False,
                        primary_key=True, serialize=False,
                    ),
                ),
                (
                    "version_seq",
                    models.PositiveIntegerField(
                        help_text=(
                            "单调递增（与 PR.PackageVersion.version_seq 对齐）。"
                        ),
                    ),
                ),
                (
                    "version_label",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text="语义版本号 v1.2.3（用户可见）。",
                        max_length=64,
                    ),
                ),
                (
                    "bundle_oss_key",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text=(
                            "OSS 引用（冗余冷数据，主真相在 PR.PackageFile）。"
                        ),
                        max_length=512,
                    ),
                ),
                (
                    "bundle_sha256",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text=(
                            "完整性校验（与 PR.PackageVersion.bundle_sha256 对齐）。"
                            "也是 D11 install_content_hash 的服务端值。"
                        ),
                        max_length=64,
                    ),
                ),
                ("change_note", models.TextField(blank=True, default="")),
                (
                    "published_by",
                    models.UUIDField(
                        help_text="发布者 user_id（跨库软引用 User）。",
                    ),
                ),
                ("published_at", models.DateTimeField(auto_now_add=True)),
                (
                    "review_status",
                    models.CharField(
                        choices=[
                            ("not_required", "Not Required"),
                            ("pending_review", "Pending Review"),
                            ("approved", "Approved"),
                            ("rejected", "Rejected"),
                        ],
                        db_index=True,
                        default="not_required",
                        help_text=(
                            "审核状态（D13）。private / workteam = not_required；public 必审。"
                        ),
                        max_length=16,
                    ),
                ),
                (
                    "reviewed_by",
                    models.UUIDField(blank=True, null=True),
                ),
                (
                    "reviewed_at",
                    models.DateTimeField(blank=True, null=True),
                ),
                (
                    "review_note",
                    models.TextField(
                        blank=True,
                        default="",
                        help_text=(
                            "审核备注（仅 admindash 内部可见，不暴露给 owner）。"
                        ),
                    ),
                ),
                (
                    "skill",
                    models.ForeignKey(
                        on_delete=models.CASCADE,
                        related_name="published_versions",
                        to="skills.skill",
                    ),
                ),
            ],
            options={
                "verbose_name": "Skill Published Version",
                "verbose_name_plural": "Skill Published Versions",
                "db_table": "skills_published_version",
                "ordering": ["-version_seq"],
            },
        ),
        migrations.AddIndex(
            model_name="skillpublishedversion",
            index=models.Index(
                fields=["skill", "review_status"],
                name="skills_publ_skill_i_25db96_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="skillpublishedversion",
            constraint=models.UniqueConstraint(
                fields=("skill", "version_seq"),
                name="uq_published_skill_version",
            ),
        ),
    ]
