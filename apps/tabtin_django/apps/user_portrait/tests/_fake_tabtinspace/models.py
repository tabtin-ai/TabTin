"""最小化 Organization / OrganizationMember 模型，仅供测试 settings 加载。

字段对齐：
  - 跟 ``apps.tabtinspace.models`` 真模型在 _check_organization_membership 用到的
    字段保持同名同语义：``id`` / ``owner_id`` / 复合 (organization_id, user_id)
  - 不引入 ArrayField / GinIndex 等 SQLite 不支持的 PG 特性
"""

import uuid

from django.db import models


class Organization(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255, default="")
    owner_id = models.UUIDField(null=True, blank=True)

    class Meta:
        app_label = "tabtinspace"
        db_table = "fake_tabtinspace_organization"


class OrganizationMember(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization_id = models.UUIDField()
    user_id = models.UUIDField()
    role = models.CharField(max_length=32, default="viewer")

    class Meta:
        app_label = "tabtinspace"
        db_table = "fake_tabtinspace_organization_member"
        unique_together = [["organization_id", "user_id"]]
