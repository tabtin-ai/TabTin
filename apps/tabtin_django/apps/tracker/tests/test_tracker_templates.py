"""Tracker 内置模板契约：可用场景蓝图 + sidechannel 查询。

纯函数 / 无 DB。模板是通用任务蓝图，不硬编码不存在的业务实体。
"""

from __future__ import annotations

from unittest.mock import MagicMock

from django.http import HttpRequest
from django.test import SimpleTestCase

from apps.tracker.tracker_templates import (
    GOAL_TEMPLATES,
    get_template_by_id,
    get_templates,
    normalize_template_locale,
)

REQUIRED_KEYS = {
    "id",
    "version",
    "name",
    "description",
    "category",
    "icon_key",
    "default_name",
    "instructions",
    "trigger_type",
    "trigger_config",
    "requirements",
}

LOCALIZED_TEXT_KEYS = (
    "name",
    "description",
    "default_name",
    "instructions",
    "requirements",
)

VISIBLE_TEMPLATE_IDS = [
    "ai_news_digest",
    "daily_report_summary",
    "daily_standup_meeting",
    "group_chat_digest",
    "wiki_compile",
]

# CJK 检测：英文模板文案不得残留中文
_CJK_RE = __import__("re").compile(r"[\u4e00-\u9fff]")


class TrackerTemplatesShapeTest(SimpleTestCase):
    def test_public_templates_hide_unavailable_mail(self):
        self.assertEqual(len(GOAL_TEMPLATES), 6)
        self.assertEqual(
            [t["id"] for t in get_templates()],
            VISIBLE_TEMPLATE_IDS,
        )
        self.assertIsNone(get_template_by_id("daily_email_summary"))

    def test_each_template_has_required_fields(self):
        for tpl in GOAL_TEMPLATES:
            missing = REQUIRED_KEYS - set(tpl.keys())
            self.assertEqual(missing, set(), msg=f"{tpl.get('id')}: missing {missing}")
            self.assertIsInstance(tpl["id"], str)
            self.assertTrue(tpl["id"].strip())
            self.assertIsInstance(tpl["version"], str)
            self.assertTrue(tpl["version"].strip())
            self.assertIsInstance(tpl["instructions"], str)
            self.assertTrue(tpl["instructions"].strip())
            self.assertIsInstance(tpl["trigger_config"], dict)
            self.assertIsInstance(tpl["requirements"], str)
            self.assertTrue(tpl["icon_key"].strip())
            # lucide key：小写 + 连字符，禁止任意组件名
            self.assertRegex(tpl["icon_key"], r"^[a-z][a-z0-9-]*$")

    def test_scheduled_templates_expose_cron_expression_key(self):
        """trigger_config 可用 expression 或 cron_expression；前端会归一化。"""
        for tpl in GOAL_TEMPLATES:
            if tpl["trigger_type"] != "cron":
                continue
            cfg = tpl["trigger_config"]
            expr = cfg.get("cron_expression") or cfg.get("expression")
            self.assertTrue(expr, msg=f"{tpl['id']} cron missing expression")
            self.assertIn("timezone", cfg)

    def test_get_templates_and_by_id(self):
        all_tpl = get_templates()
        self.assertEqual(len(all_tpl), 5)
        by_cat = get_templates(category=GOAL_TEMPLATES[0]["category"])
        self.assertGreaterEqual(len(by_cat), 1)
        self.assertEqual(get_template_by_id("ai_news_digest")["name"], "AI 新闻推送")
        self.assertEqual(get_template_by_id("wiki_compile")["name"], "定时整理 TabDoc")
        self.assertIsNone(get_template_by_id("does-not-exist"))

    def test_no_trigger_task_product_surface(self):
        """产品只有自动化：模板文案/分类不得出现「触发任务」。"""
        blob = " ".join(
            f"{t.get('name','')} {t.get('description','')} {t.get('category','')} {t.get('instructions','')}"
            for t in GOAL_TEMPLATES
        )
        self.assertNotIn("触发任务", blob)


class TrackerTemplatesLocaleTest(SimpleTestCase):
    def test_normalize_template_locale_aliases_and_fallback(self):
        self.assertEqual(normalize_template_locale(None), "zh-CN")
        self.assertEqual(normalize_template_locale(""), "zh-CN")
        self.assertEqual(normalize_template_locale("zh"), "zh-CN")
        self.assertEqual(normalize_template_locale("zh-CN"), "zh-CN")
        self.assertEqual(normalize_template_locale("zh_CN"), "zh-CN")
        self.assertEqual(normalize_template_locale("en"), "en-US")
        self.assertEqual(normalize_template_locale("en-US"), "en-US")
        self.assertEqual(normalize_template_locale("en_US"), "en-US")
        self.assertEqual(normalize_template_locale("fr-FR"), "zh-CN")
        self.assertEqual(normalize_template_locale("unknown"), "zh-CN")

    def test_en_us_templates_have_full_english_text_without_cjk(self):
        en_list = get_templates(locale="en-US")
        self.assertEqual(len(en_list), 5)
        self.assertEqual([t["id"] for t in en_list], VISIBLE_TEMPLATE_IDS)
        for tpl in en_list:
            for key in LOCALIZED_TEXT_KEYS:
                value = tpl[key]
                self.assertIsInstance(value, str)
                self.assertTrue(value.strip(), msg=f"{tpl['id']}.{key} empty")
                self.assertIsNone(
                    _CJK_RE.search(value),
                    msg=f"{tpl['id']}.{key} still contains CJK: {value[:80]!r}",
                )
            # 非文案字段保持不变
            canonical = next(t for t in GOAL_TEMPLATES if t["id"] == tpl["id"])
            self.assertEqual(tpl["version"], canonical["version"])
            self.assertEqual(tpl["category"], canonical["category"])
            self.assertEqual(tpl["icon_key"], canonical["icon_key"])
            self.assertEqual(tpl["trigger_type"], canonical["trigger_type"])
            self.assertEqual(tpl["trigger_config"], canonical["trigger_config"])

    def test_default_and_zh_remain_chinese(self):
        default_list = get_templates()
        zh_list = get_templates(locale="zh-CN")
        self.assertEqual(default_list[0]["name"], "AI 新闻推送")
        self.assertEqual(zh_list[0]["name"], "AI 新闻推送")
        self.assertEqual(
            get_template_by_id("ai_news_digest", locale="en")["name"],
            "AI News Digest",
        )

    def test_localized_return_is_shallow_copy_not_global_mutation(self):
        en = get_template_by_id("ai_news_digest", locale="en-US")
        self.assertIsNotNone(en)
        en["name"] = "MUTATED"
        en["trigger_config"]["timezone"] = "UTC"
        canonical = next(t for t in GOAL_TEMPLATES if t["id"] == "ai_news_digest")
        self.assertEqual(canonical["name"], "AI 新闻推送")
        self.assertEqual(canonical["trigger_config"]["timezone"], "Asia/Shanghai")


class TrackerTemplatesApiLocaleTest(SimpleTestCase):
    def test_list_and_get_templates_honor_locale_query(self):
        from apps.tracker.api import sidechannel

        request = MagicMock(spec=HttpRequest)
        listed = sidechannel.list_templates(request, locale="en_US")
        self.assertTrue(listed["success"])
        templates = listed["data"]["templates"]
        self.assertEqual(len(templates), 5)
        self.assertEqual(templates[0]["name"], "AI News Digest")
        self.assertIsNone(_CJK_RE.search(templates[0]["instructions"]))
        self.assertEqual(
            next(t for t in templates if t["id"] == "wiki_compile")["name"],
            "Scheduled TabDoc Digest",
        )

        detail = sidechannel.get_template(request, "ai_news_digest", locale="en")
        self.assertTrue(detail["success"])
        self.assertEqual(detail["data"]["name"], "AI News Digest")
        self.assertEqual(detail["data"]["default_name"], "AI News Digest")

        # 默认（无 locale）保持中文兼容
        listed_default = sidechannel.list_templates(request)
        self.assertEqual(listed_default["data"]["templates"][0]["name"], "AI 新闻推送")
