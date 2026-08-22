"""GET /client/version-gate 移动端版本门禁接口回归。

运行方式：
    cd apps/tabtin_django
    ./venv/bin/python manage.py test apps.updater.tests.test_mobile_version_gate \
        --settings=tabtin.settings_updater_progress_test
"""

from django.test import Client, TestCase

from apps.updater.models import ClientVersionPolicy


GATE_URL = "/api/client/version-gate"


class MobileVersionGateApiTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.client = Client()

    def _policy(self, **overrides) -> ClientVersionPolicy:
        defaults = dict(
            platform="ios",
            enabled=True,
            soft_prompt_enabled=True,
            min_supported_build=100,
            latest_build=200,
            min_supported_version="1.1.0",
            latest_version="1.3.0",
            store_url="https://www.example.com/download",
            force_title="必须更新",
            force_message="老版本已停用",
        )
        defaults.update(overrides)
        return ClientVersionPolicy.objects.create(**defaults)

    def _get(self, **params):
        response = self.client.get(GATE_URL, params)
        self.assertEqual(response.status_code, 200)
        return response.json()["data"]

    def test_force_when_build_below_min(self):
        self._policy()
        data = self._get(platform="ios", build=99)
        self.assertEqual(data["action"], "force")
        self.assertEqual(data["store_url"], "https://www.example.com/download")
        self.assertEqual(data["title"], "必须更新")
        self.assertEqual(data["message"], "老版本已停用")

    def test_soft_when_build_between_min_and_latest(self):
        self._policy()
        data = self._get(platform="ios", build=150)
        self.assertEqual(data["action"], "soft")

    def test_none_when_build_at_or_above_latest(self):
        self._policy()
        data = self._get(platform="ios", build=200)
        self.assertEqual(data["action"], "none")

    def test_none_when_disabled_even_if_below_min(self):
        self._policy(enabled=False)
        data = self._get(platform="ios", build=1)
        self.assertEqual(data["action"], "none")

    def test_no_soft_when_latest_build_zero(self):
        self._policy(latest_build=0)
        data = self._get(platform="ios", build=150)
        self.assertEqual(data["action"], "none")

    def test_no_soft_when_soft_prompt_disabled(self):
        # 软提示开关关闭时，落在 soft 区间也不弹（默认关，符合苹果审核期望）。
        self._policy(soft_prompt_enabled=False)
        data = self._get(platform="ios", build=150)
        self.assertEqual(data["action"], "none")

    def test_force_still_works_when_soft_prompt_disabled(self):
        # 软开关关闭不影响强更。
        self._policy(soft_prompt_enabled=False)
        data = self._get(platform="ios", build=99)
        self.assertEqual(data["action"], "force")

    def test_unknown_platform_passes_through(self):
        self._policy()
        data = self._get(platform="harmony", build=1)
        self.assertEqual(data["action"], "none")

    def test_missing_policy_passes_through(self):
        data = self._get(platform="android", build=1)
        self.assertEqual(data["action"], "none")

    def test_force_uses_default_copy_when_blank(self):
        self._policy(force_title="", force_message="")
        data = self._get(platform="ios", build=1)
        self.assertEqual(data["action"], "force")
        self.assertEqual(data["title"], ClientVersionPolicy.DEFAULT_FORCE_TITLE)
        self.assertEqual(data["message"], ClientVersionPolicy.DEFAULT_FORCE_MESSAGE)
