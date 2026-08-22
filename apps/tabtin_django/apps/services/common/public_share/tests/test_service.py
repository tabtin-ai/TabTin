"""PublicShareService 基类自测

策略：测试不依赖任何具体 App 模型（tabdoc / tabdata），通过 mock 类充当
share / resource，让基类设计本身可以独立验证。

覆盖范围：
- generate_share_id：长度、唯一性
- apply_password：三态语义
- validate_organization_scope：严格 / 宽松 / 空 organization_id
- verify_share_access：public 全放行 / organization + 各种 user 状态
  / 密码各种状态 / OrganizationMember 模型不传 is_active（PRD §4.1 P0-1 防回归核心）
- get_share_by_id：not_found / inactive / expired / 正常
- load_resource_for_management：404 / 匿名 / owner 短路 / admin 通过 /
  非 admin 拒绝（P0-2 防越权核心）
- create_or_update_share / disable_share / refresh_share_id：业务方法
- 异常族继承关系
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.common.public_share import (
    PublicShareError,
    PublicShareService,
    ShareExpiredError,
    ShareManagementPermissionDeniedError,
    ShareNotFoundError,
    SharePasswordIncorrectError,
    SharePasswordRequiredError,
    SharePermissionDeniedError,
    ShareOrganizationMismatchError,
)


# ── In-memory mock 模型 ──


class _MockShareManager:
    """模拟 Share.objects.using(alias).get(share_id=...) /
    .filter(...).first() / .filter(...).update(...)。"""

    def __init__(self, store):
        self._store = store

    def using(self, alias):
        return self

    def get(self, **kw):
        for row in self._store:
            if all(getattr(row, k, None) == v for k, v in kw.items()):
                return row
        raise _MockShare.DoesNotExist(f"no match for {kw}")

    def filter(self, **kw):
        matched = [
            r for r in self._store
            if all(getattr(r, k, None) == v for k, v in kw.items())
        ]
        return _MockQuerySet(matched, self._store)

    def create(self, **kw):
        row = _MockShare(**kw)
        self._store.append(row)
        return row


class _MockQuerySet:
    def __init__(self, items, store):
        self._items = items
        self._store = store

    def first(self):
        return self._items[0] if self._items else None

    def update(self, **kw):
        n = 0
        for item in self._items:
            for k, v in kw.items():
                setattr(item, k, v)
            n += 1
        return n


class _MockShare:
    """模拟 DocumentShare / TableShare 的最小 share 模型。"""

    class DoesNotExist(Exception):
        pass

    objects = None  # 由测试 setUp 设置
    _backing_store: list = []

    def __init__(self, **kw):
        defaults = {
            "share_id": kw.pop("share_id", "default_share_id_xyz"),
            "share_type": kw.pop("share_type", "public"),
            "organization_id": kw.pop("organization_id", ""),
            "is_active": kw.pop("is_active", True),
            "password_hash": kw.pop("password_hash", ""),
            "permission": kw.pop("permission", "view"),
            "expire_at": kw.pop("expire_at", None),
            "allow_download": kw.pop("allow_download", True),
            "allow_copy": kw.pop("allow_copy", True),
            "created_by": kw.pop("created_by", None),
            "_expired": kw.pop("_expired", False),
            "updated_at": None,
        }
        defaults.update(kw)
        for k, v in defaults.items():
            setattr(self, k, v)

    def is_expired(self):
        return self._expired

    @property
    def has_password(self):
        return bool(self.password_hash)

    def set_password(self, raw):
        self.password_hash = f"hashed::{raw}" if raw else ""

    def check_password(self, raw):
        return self.password_hash == f"hashed::{raw}"

    def save(self, using=None, update_fields=None):
        # 模拟 Django Model.save：新建实例首次 save 时入 store
        store = type(self)._backing_store
        if self not in store:
            store.append(self)
        return self


class _MockResourceManager:
    """模拟 Resource.objects.using(alias).get(id=...)。"""

    def __init__(self, store):
        self._store = store

    def using(self, alias):
        return self

    def get(self, **kw):
        for r in self._store:
            if all(str(getattr(r, k, None)) == str(v) for k, v in kw.items()):
                return r
        raise _MockResource.DoesNotExist(f"no match for {kw}")


class _MockResource:
    """模拟 Document / Table 的最小 resource 模型。"""

    class DoesNotExist(Exception):
        pass

    objects = None  # 由测试 setUp 设置

    __name__ = "Resource"

    def __init__(self, **kw):
        defaults = {
            "id": "res-1",
            "owner_id": None,
            "organization_id": "wt-1",
        }
        defaults.update(kw)
        for k, v in defaults.items():
            setattr(self, k, v)


def _build_dummy_service(
    *, share_store, resource_store, admin_check_result=False,
):
    """造一个绑定到 mock 后端的 DummyShareService 子类。"""

    _MockShare.objects = _MockShareManager(share_store)
    _MockShare._backing_store = share_store  # 让 save() 入此 list
    _MockResource.objects = _MockResourceManager(resource_store)

    class DummyShareService(PublicShareService):
        share_model = _MockShare
        resource_model = _MockResource
        db_alias = "default"

        admin_call_log: list = []

        @classmethod
        def check_resource_admin(cls, resource, user, *, required_role="admin"):
            cls.admin_call_log.append((resource, user, required_role))
            return admin_check_result

        @classmethod
        def serialize_meta(cls, share):
            return {"share_id": share.share_id, "share_type": share.share_type,
                    "has_password": share.has_password}

        @classmethod
        def serialize_content(cls, share):
            return {"share_id": share.share_id, "content": "dummy"}

        @classmethod
        def _get_resource_fk_name(cls):
            return "resource"

    return DummyShareService


# ── 纯函数级测试 ──


class GenerateShareIdTests(SimpleTestCase):

    def test_default_length_16(self):
        sid = PublicShareService.generate_share_id()
        self.assertEqual(len(sid), 16)

    def test_uniqueness_under_100_generates(self):
        ids = {PublicShareService.generate_share_id() for _ in range(100)}
        self.assertEqual(len(ids), 100)

    def test_custom_length(self):
        class _ShorterService(PublicShareService):
            share_id_length = 8
            share_model = _MockShare
            resource_model = _MockResource

            @classmethod
            def check_resource_admin(cls, *a, **k):
                return False

            @classmethod
            def serialize_meta(cls, share):
                return {}

            @classmethod
            def serialize_content(cls, share):
                return {}

        sid = _ShorterService.generate_share_id()
        self.assertEqual(len(sid), 8)


class ApplyPasswordTests(SimpleTestCase):

    def test_none_does_not_touch(self):
        share = _MockShare(password_hash="hashed::initial")
        changed = PublicShareService.apply_password(share, None)
        self.assertFalse(changed)
        self.assertEqual(share.password_hash, "hashed::initial")

    def test_empty_clears(self):
        share = _MockShare(password_hash="hashed::initial")
        changed = PublicShareService.apply_password(share, "")
        self.assertTrue(changed)
        self.assertEqual(share.password_hash, "")

    def test_nonempty_sets(self):
        share = _MockShare()
        changed = PublicShareService.apply_password(share, "newpwd")
        self.assertTrue(changed)
        self.assertTrue(share.check_password("newpwd"))


class ValidateOrganizationScopeTests(SimpleTestCase):

    def test_strict_pass_when_match(self):
        resource = _MockResource(organization_id="wt-1")
        PublicShareService.validate_organization_scope(resource, "wt-1")

    def test_strict_reject_when_mismatch(self):
        resource = _MockResource(organization_id="wt-1")
        with self.assertRaises(ShareOrganizationMismatchError):
            PublicShareService.validate_organization_scope(resource, "wt-2")

    def test_empty_target_always_rejected(self):
        resource = _MockResource(organization_id="wt-1")
        with self.assertRaises(ShareOrganizationMismatchError):
            PublicShareService.validate_organization_scope(resource, "")


class IsExpiredTests(SimpleTestCase):

    def test_passthrough_true(self):
        share = _MockShare(_expired=True)
        self.assertTrue(PublicShareService.is_expired(share))

    def test_passthrough_false(self):
        share = _MockShare(_expired=False)
        self.assertFalse(PublicShareService.is_expired(share))


class ExceptionHierarchyTests(SimpleTestCase):
    """异常族都应继承 PublicShareError，便于 view 层用一行 except 兜底。"""

    def test_all_inherit_base(self):
        for cls in (
            ShareNotFoundError,
            ShareExpiredError,
            SharePasswordRequiredError,
            SharePasswordIncorrectError,
            SharePermissionDeniedError,
            ShareManagementPermissionDeniedError,
            ShareOrganizationMismatchError,
        ):
            self.assertTrue(issubclass(cls, PublicShareError))


# ── verify_share_access：核心鉴权门 ──


class VerifyShareAccessTests(SimpleTestCase):
    """覆盖 PRD §3.3 verify_share_access 关键约束：

    - public share 不论 user / password 一律放行
    - organization share + 匿名 → SharePermissionDenied
    - organization share + outsider → SharePermissionDenied
    - organization share + member → 通过
    - 任意 share 有密码不传 → SharePasswordRequired
    - 任意 share 有密码错 → SharePasswordIncorrect
    - 任意 share 有密码对 → 通过
    - OrganizationMember.filter 调用绝对不能传 is_active 字段（P0-1 共同次因）
    """

    def test_public_share_allows_anonymous(self):
        share = _MockShare(share_type="public", organization_id="")
        PublicShareService.verify_share_access(share, user=None)

    def test_public_share_allows_authed(self):
        share = _MockShare(share_type="public")
        user = SimpleNamespace(id="u-1")
        PublicShareService.verify_share_access(share, user=user)

    def test_organization_share_blocks_anonymous(self):
        share = _MockShare(share_type="organization", organization_id="wt-1")
        with self.assertRaises(SharePermissionDeniedError):
            PublicShareService.verify_share_access(share, user=None)

    def test_organization_share_empty_org_id_fail_closed(self):
        """organization + 空 organization_id 不得退化成公开（匿名/成员均拒绝）。"""
        share = _MockShare(share_type="organization", organization_id="")
        with self.assertRaises(SharePermissionDeniedError):
            PublicShareService.verify_share_access(share, user=None)

        member = SimpleNamespace(id="u-1")
        fake_qs = MagicMock()
        fake_qs.exists.return_value = True
        with patch(
            "apps.tabtinspace.models.OrganizationMember.objects.filter",
            return_value=fake_qs,
        ):
            with self.assertRaises(SharePermissionDeniedError):
                PublicShareService.verify_share_access(share, user=member)

    def test_organization_share_blocks_outsider(self):
        share = _MockShare(share_type="organization", organization_id="wt-1")
        user = SimpleNamespace(id="u-1")

        fake_qs = MagicMock()
        fake_qs.exists.return_value = False
        with patch(
            "apps.tabtinspace.models.OrganizationMember.objects.filter",
            return_value=fake_qs,
        ):
            with self.assertRaises(SharePermissionDeniedError):
                PublicShareService.verify_share_access(share, user=user)

    def test_organization_share_allows_member(self):
        share = _MockShare(share_type="organization", organization_id="wt-1")
        user = SimpleNamespace(id="u-1")

        fake_qs = MagicMock()
        fake_qs.exists.return_value = True
        with patch(
            "apps.tabtinspace.models.OrganizationMember.objects.filter",
            return_value=fake_qs,
        ) as mock_filter:
            PublicShareService.verify_share_access(share, user=user)

        # PRD §4.1 共同次因防回归：filter 调用绝不能含 is_active 字段
        for call in mock_filter.call_args_list:
            kw = call.kwargs
            self.assertNotIn(
                "is_active", kw,
                msg="OrganizationMember has no is_active field; never pass it",
            )

    def test_organization_share_password_after_organization_check(self):
        """organization 限定 share 同时有密码：必须先校验 organization，再校验密码。"""
        share = _MockShare(
            share_type="organization", organization_id="wt-1", password_hash="hashed::ok",
        )
        outsider = SimpleNamespace(id="u-1")

        fake_qs = MagicMock()
        fake_qs.exists.return_value = False
        with patch(
            "apps.tabtinspace.models.OrganizationMember.objects.filter",
            return_value=fake_qs,
        ):
            with self.assertRaises(SharePermissionDeniedError):
                PublicShareService.verify_share_access(
                    share, user=outsider, password="ok",
                )

    def test_password_required_when_missing(self):
        share = _MockShare(password_hash="hashed::secret")
        with self.assertRaises(SharePasswordRequiredError):
            PublicShareService.verify_share_access(share, password="")

    def test_password_incorrect(self):
        share = _MockShare(password_hash="hashed::secret")
        with self.assertRaises(SharePasswordIncorrectError):
            PublicShareService.verify_share_access(share, password="wrong")

    def test_password_correct(self):
        share = _MockShare(password_hash="hashed::secret")
        PublicShareService.verify_share_access(share, password="secret")

    def test_organization_share_user_missing_id_treated_as_anonymous(self):
        """user 实例存在但 .id 为 None / 缺失 → 当作匿名拒绝。"""
        share = _MockShare(share_type="organization", organization_id="wt-1")
        broken_user = SimpleNamespace(id=None)
        with self.assertRaises(SharePermissionDeniedError):
            PublicShareService.verify_share_access(share, user=broken_user)

    def test_valid_share_types_whitelist_fail_closed(self):
        """子类声明 valid_share_types 后，集合外取值不得退化成公开链接。"""

        class _Whitelisted(PublicShareService):
            valid_share_types = frozenset({"public", "organization"})

            @classmethod
            def check_resource_admin(cls, resource, user, *, required_role="admin"):
                return True

            @classmethod
            def serialize_meta(cls, share, *, include_protected=True):
                return {}

            @classmethod
            def serialize_content(cls, share):
                return {}

        dirty = _MockShare(share_type="typo", organization_id="")
        with self.assertRaises(SharePermissionDeniedError):
            _Whitelisted.verify_share_access(dirty, user=None)

        # 未声明白名单时保持历史语义：非 organization 可匿名访问。
        PublicShareService.verify_share_access(dirty, user=None)


# ── get_share_by_id ──


class GetShareByIdTests(SimpleTestCase):

    def test_returns_active_share(self):
        store = [_MockShare(share_id="sid-1")]
        Service = _build_dummy_service(share_store=store, resource_store=[])
        share = Service.get_share_by_id("sid-1")
        self.assertEqual(share.share_id, "sid-1")

    def test_raises_not_found_when_missing(self):
        Service = _build_dummy_service(share_store=[], resource_store=[])
        with self.assertRaises(ShareNotFoundError):
            Service.get_share_by_id("nope")

    def test_raises_not_found_when_inactive(self):
        store = [_MockShare(share_id="sid-2", is_active=False)]
        Service = _build_dummy_service(share_store=store, resource_store=[])
        with self.assertRaises(ShareNotFoundError):
            Service.get_share_by_id("sid-2")

    def test_raises_expired_when_expired(self):
        store = [_MockShare(share_id="sid-3", _expired=True)]
        Service = _build_dummy_service(share_store=store, resource_store=[])
        with self.assertRaises(ShareExpiredError):
            Service.get_share_by_id("sid-3")


# ── load_resource_for_management：P0-2 防越权核心 ──


class LoadResourceForManagementTests(SimpleTestCase):

    def test_not_found_raises_share_not_found(self):
        Service = _build_dummy_service(share_store=[], resource_store=[])
        with self.assertRaises(ShareNotFoundError):
            Service.load_resource_for_management("no-such", SimpleNamespace(id="u"))

    def test_anonymous_rejected(self):
        resource = _MockResource(id="r-1", owner_id="u-owner")
        Service = _build_dummy_service(
            share_store=[], resource_store=[resource],
        )
        with self.assertRaises(ShareManagementPermissionDeniedError):
            Service.load_resource_for_management("r-1", None)

    def test_operator_without_id_rejected(self):
        resource = _MockResource(id="r-1", owner_id="u-owner")
        Service = _build_dummy_service(
            share_store=[], resource_store=[resource],
        )
        with self.assertRaises(ShareManagementPermissionDeniedError):
            Service.load_resource_for_management("r-1", SimpleNamespace(id=None))

    def test_owner_shortcut_pass(self):
        resource = _MockResource(id="r-1", owner_id="u-owner")
        Service = _build_dummy_service(
            share_store=[], resource_store=[resource], admin_check_result=False,
        )
        # owner 短路：即使 admin_check 返回 False 也应放行
        out = Service.load_resource_for_management("r-1", SimpleNamespace(id="u-owner"))
        self.assertIs(out, resource)
        # admin_check 不应被调用（owner 短路）
        self.assertEqual(Service.admin_call_log, [])

    def test_admin_callback_pass(self):
        resource = _MockResource(id="r-1", owner_id="u-owner")
        Service = _build_dummy_service(
            share_store=[], resource_store=[resource], admin_check_result=True,
        )
        out = Service.load_resource_for_management("r-1", SimpleNamespace(id="u-other"))
        self.assertIs(out, resource)
        self.assertEqual(len(Service.admin_call_log), 1)

    def test_non_admin_rejected(self):
        resource = _MockResource(id="r-1", owner_id="u-owner")
        Service = _build_dummy_service(
            share_store=[], resource_store=[resource], admin_check_result=False,
        )
        with self.assertRaises(ShareManagementPermissionDeniedError):
            Service.load_resource_for_management("r-1", SimpleNamespace(id="u-other"))


# ── 业务便捷方法 ──


class CreateOrUpdateShareTests(SimpleTestCase):

    def test_creates_when_no_existing(self):
        store = []
        resource = _MockResource(id="r-1", organization_id="wt-1")
        Service = _build_dummy_service(
            share_store=store, resource_store=[resource],
        )
        operator = SimpleNamespace(id="u")
        share = Service.create_or_update_share(resource, operator)
        self.assertIs(share, store[0])
        self.assertEqual(share.share_type, "public")

    def test_updates_existing_active_share(self):
        existing = _MockShare(
            share_type="public", is_active=True, allow_download=True,
        )
        existing.resource = _MockResource(id="r-1")
        Service = _build_dummy_service(
            share_store=[existing], resource_store=[existing.resource],
        )
        out = Service.create_or_update_share(
            existing.resource, SimpleNamespace(id="u"),
            allow_download=False, password="new",
        )
        self.assertIs(out, existing)
        self.assertFalse(existing.allow_download)
        self.assertTrue(existing.check_password("new"))

    def test_password_three_state_on_update(self):
        existing = _MockShare(password_hash="hashed::old", is_active=True)
        existing.resource = _MockResource(id="r-1")
        Service = _build_dummy_service(
            share_store=[existing], resource_store=[existing.resource],
        )
        # None → 保留
        Service.create_or_update_share(
            existing.resource, SimpleNamespace(id="u"), password=None,
        )
        self.assertEqual(existing.password_hash, "hashed::old")
        # "" → 清空
        Service.create_or_update_share(
            existing.resource, SimpleNamespace(id="u"), password="",
        )
        self.assertEqual(existing.password_hash, "")

    def test_create_with_password_sets_hash(self):
        """新建路径传非空 password → 走 set_password 入 hash。"""
        store = []
        resource = _MockResource(id="r-pwd", organization_id="wt-1")
        Service = _build_dummy_service(
            share_store=store, resource_store=[resource],
        )
        share = Service.create_or_update_share(
            resource, SimpleNamespace(id="u"), password="seed",
        )
        self.assertTrue(share.has_password)
        self.assertTrue(share.check_password("seed"))

    def test_extra_fields_on_create_and_update(self):
        """extra_fields 应让子类透传业务字段（如 tabslide allow_export）。"""
        # 新建路径
        store = []
        resource = _MockResource(id="r-2", organization_id="wt-1")
        Service = _build_dummy_service(
            share_store=store, resource_store=[resource],
        )
        share = Service.create_or_update_share(
            resource, SimpleNamespace(id="u"),
            extra_fields={"custom_flag": "yes"},
        )
        self.assertEqual(share.custom_flag, "yes")

        # 更新路径
        Service.create_or_update_share(
            resource, SimpleNamespace(id="u"),
            extra_fields={"custom_flag": "no"},
        )
        self.assertEqual(share.custom_flag, "no")

    def test_organization_share_fills_org_id_from_resource(self):
        """organization 分享省略 organization_id 时从资源归属推导。"""
        store = []
        resource = _MockResource(id="r-org", organization_id="wt-42")
        Service = _build_dummy_service(
            share_store=store, resource_store=[resource],
        )
        share = Service.create_or_update_share(
            resource,
            SimpleNamespace(id="u"),
            share_type="organization",
        )
        self.assertEqual(share.share_type, "organization")
        self.assertEqual(share.organization_id, "wt-42")

    def test_organization_share_rejects_when_resource_has_no_org(self):
        store = []
        resource = _MockResource(id="r-no-org", organization_id="")
        Service = _build_dummy_service(
            share_store=store, resource_store=[resource],
        )
        with self.assertRaises(ShareOrganizationMismatchError):
            Service.create_or_update_share(
                resource,
                SimpleNamespace(id="u"),
                share_type="organization",
            )


class MissingShareModelGuardTests(SimpleTestCase):
    """所有依赖 share_model 的 classmethod 都应在子类未设它时
    抛 NotImplementedError，给 Phase 1/2/3 实施 Agent 早期发现配置漏配。"""

    def _make_unbound_subclass(self):
        class _Unbound(PublicShareService):
            resource_model = _MockResource

            @classmethod
            def check_resource_admin(cls, *a, **k):
                return False

            @classmethod
            def serialize_meta(cls, s):
                return {}

            @classmethod
            def serialize_content(cls, s):
                return {}
        return _Unbound

    def test_get_active_share_raises(self):
        Bad = self._make_unbound_subclass()
        with self.assertRaises(NotImplementedError):
            Bad.get_active_share(_MockResource())

    def test_disable_share_raises(self):
        Bad = self._make_unbound_subclass()
        with self.assertRaises(NotImplementedError):
            Bad.disable_share(_MockResource())

    def test_create_or_update_raises(self):
        Bad = self._make_unbound_subclass()
        with self.assertRaises(NotImplementedError):
            Bad.create_or_update_share(
                _MockResource(), SimpleNamespace(id="u"),
            )


class DisableShareTests(SimpleTestCase):

    def test_disables_active_share(self):
        resource = _MockResource(id="r-1")
        share = _MockShare(share_type="public", is_active=True)
        share.resource = resource
        Service = _build_dummy_service(
            share_store=[share], resource_store=[resource],
        )
        n = Service.disable_share(resource)
        self.assertEqual(n, 1)
        self.assertFalse(share.is_active)


class RefreshShareIdTests(SimpleTestCase):

    def test_changes_share_id(self):
        resource = _MockResource(id="r-1")
        share = _MockShare(share_id="old-id", is_active=True)
        share.resource = resource
        Service = _build_dummy_service(
            share_store=[share], resource_store=[resource],
        )
        out = Service.refresh_share_id(resource)
        self.assertIs(out, share)
        self.assertNotEqual(share.share_id, "old-id")
        self.assertEqual(len(share.share_id), Service.share_id_length)

    def test_returns_none_when_no_active(self):
        resource = _MockResource(id="r-1")
        Service = _build_dummy_service(
            share_store=[], resource_store=[resource],
        )
        out = Service.refresh_share_id(resource)
        self.assertIsNone(out)


# ── 子类约束 ──


class AbstractMethodEnforcementTests(SimpleTestCase):
    """没实现抽象方法的子类应在调用时 raise NotImplementedError。"""

    def test_cannot_instantiate_without_abstract_methods(self):
        with self.assertRaises(TypeError):
            PublicShareService()  # noqa

    def test_missing_share_model_class_attr_raises(self):
        class _Bad(PublicShareService):
            @classmethod
            def check_resource_admin(cls, *a, **k):
                return False

            @classmethod
            def serialize_meta(cls, s):
                return {}

            @classmethod
            def serialize_content(cls, s):
                return {}

        with self.assertRaises(NotImplementedError):
            _Bad.get_share_by_id("sid")
        with self.assertRaises(NotImplementedError):
            _Bad.load_resource_for_management("rid", SimpleNamespace(id="u"))
