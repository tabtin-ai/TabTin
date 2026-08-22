"""PublicShareE2EMixin 自测

用 tabdoc 的 DocumentShare / Document 作为「真实 Django 模型 + 真实
OrganizationMember 查询」的载体，跑一次完整的 mixin 用例集，证明：

- mixin 的 setup / hook 接口可用
- 8 个标准 test_ 用例（继承即跑）行为符合 PRD §3.5 描述
- assert helpers 能正确拒绝违例 / 接受合规

注意：本测试**仅在 settings_share_test** 跑得通（postgresql alias 用 sqlite，
表通过 syncdb 自动建）。生产 PG 环境不需要跑此测试 —— Phase 1/2/3 各 App
会用自己的真实模型再做一遍同档次验证。
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.services.common.public_share import PublicShareService
from apps.services.common.public_share.testing import PublicShareE2EMixin


User = get_user_model()


def _ensure_signal_disconnected():
    from apps.tabtinspace.signals import create_default_organization
    try:
        post_save.disconnect(create_default_organization, sender=User)
    except Exception:
        pass


class _DummyDocumentShareService(PublicShareService):
    """最小可用的 Dummy 子类，绑定 tabdoc 真实模型。

    本类**仅在测试用**，不进入生产代码路径；它存在的意义是给 mixin 提供
    一个能跑通真实 OrganizationMember.filter 调用的 service_class。
    """

    db_alias = "postgresql"

    @classmethod
    def _bind_models(cls):
        # 延迟 import：避免在 Django apps 还没就绪时（DJANGO_SETTINGS_MODULE
        # 没设）触发 model import 失败
        from apps.tabdoc.models import Document, DocumentShare
        cls.share_model = DocumentShare
        cls.resource_model = Document

    @classmethod
    def check_resource_admin(cls, resource, user, *, required_role="admin"):
        # 简化：viewer 通过、其余拒绝（mixin 的 outsider 不走 admin 校验，
        # 这里返 False 即可让 management 测试通过）
        return False

    @classmethod
    def serialize_meta(cls, share):
        return {"share_id": share.share_id, "share_type": share.share_type,
                "has_password": share.has_password}

    @classmethod
    def serialize_content(cls, share):
        return {"share_id": share.share_id}


class PublicShareE2EMixinSelfTest(PublicShareE2EMixin, TestCase):
    """mixin 自测：让 mixin 的 8 个标准 test_ 用例继承下来直接跑。"""

    databases = {"default", "postgresql"}
    service_class = _DummyDocumentShareService

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _ensure_signal_disconnected()
        cls.service_class._bind_models()

    def setUp(self):
        super().setUp()
        self.setup_share_test_case()

    def make_resource(self, *, owner, organization, space):
        from apps.tabdoc.models import Document
        return Document.objects.create(
            organization_id=organization.id,
            space_id=space.id,
            owner_id=owner.id,
            title="mixin selftest doc",
            description_markdown="x",
            description_plaintext="x",
        )

    def make_share(self, resource, **kwargs):
        from apps.tabdoc.models import DocumentShare
        password = kwargs.pop("password", None)
        share = DocumentShare(document=resource, **kwargs)
        if password is not None:
            share.set_password(password)
        # mixin 标准用例的 password 三态测试期望「set_password('right')」后
        # check_password('right') 通过；这里默认初始无密码（hashed::"" 等价空）
        share.save(using="postgresql")
        return share

    # ── 额外断言：保证 mixin 提供的辅助方法本身能工作 ──

    def test_assert_share_password_required_helper(self):
        resource = self.make_resource(
            owner=self.owner, organization=self.organization, space=self.space,
        )
        share = self.make_share(resource)
        share.set_password("right")
        share.save(using="postgresql", update_fields=["password_hash"])
        self.assert_share_password_required(
            share, wrong_password="wrong", right_password="right",
        )
