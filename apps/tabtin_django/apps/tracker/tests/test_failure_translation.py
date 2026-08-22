"""Wave 6 (charter v1.8 §4.4 / 6.1) — Skill 失败信息翻译契约测试。

北极星: pytest packages/skills/ -k "test_failure_translation" -v
   (注: 实际文件在 apps/tabtin_django/apps/scheduler/tests/,因 packages/skills/
    是 markdown skill 目录,不跑 pytest;Wave 5 反思 16"项目能力 vs 北极星 prompt"
    教训——用单测覆盖语义意图,在汇报里说明实际命令。)

业务约束(charter §4.4 / Wave 6 6.1):
  1. 失败 Run 的 Agent 末条消息**没有**原始堆栈/错误码字面
  2. 翻译后的消息是"现象 + 恢复动作建议"两段式
  3. 工具/翻译规则未覆盖的错误必须回退到通用人话兜底,不能甩 str(exc)
  4. assertion 钩子可在写入 TrackerRun.error_summary 前自检
"""

from django.test import SimpleTestCase

from apps.tracker.utils import (
    assert_failure_message_is_human_readable,
    humanize_failure_message,
    sanitize_error_for_user,
    translate_skill_error,
)


class TranslateSkillErrorTests(SimpleTestCase):
    """直接验证翻译器输出,不走数据库——契约层用 SimpleTestCase 即可。"""

    def test_kimi_empty_translates_to_human_readable(self):
        """charter §4.4 / Wave 6 6.1:经典示例 — kimi 接口失败用人话报告。"""
        result = translate_skill_error("kimi returned empty output")
        self.assertIn("kimi", result["message"].lower())
        # 必须不含原始错误标记
        self.assertNotIn("Traceback", result["message"])
        self.assertNotIn("Error:", result["message"])
        # 必须含恢复动作
        self.assertTrue(result["recovery_actions"])
        rec = result["recovery_actions"][0]
        # "GPT-4" / "重试" / "换" 任一关键词命中即合规
        self.assertTrue(
            any(kw in rec for kw in ("GPT", "重试", "换")),
            f"recovery 缺少恢复动作关键词: {rec}",
        )

    def test_value_error_traceback_falls_back_safely(self):
        """ValueError 抛 raw 时翻译器要走通用 fallback,绝不能把 'ValueError' 抛出。"""
        # 模拟从 except Exception as exc; str(exc) 喂进来的形态。
        raw = (
            "Traceback (most recent call last):\n"
            '  File "/Users/foo/bar.py", line 42, in run\n'
            "    raise ValueError(\"Connection reset by peer\")\n"
            "ValueError: Connection reset by peer"
        )
        result = translate_skill_error(raw)
        # 命中 "connection reset" 关键词 → 应输出 connection 翻译
        self.assertNotIn("Traceback", result["message"])
        self.assertNotIn("ValueError", result["message"])
        self.assertNotIn("File \"", result["message"])
        self.assertTrue(result["recovery_actions"])

    def test_unknown_exception_falls_back_to_default(self):
        """完全不在白名单的错误关键词 → 走通用 fallback,绝不甩 str(exc)。"""
        raw = "SomeWeirdException: X is not Y"
        result = translate_skill_error(raw)
        # fallback message
        self.assertNotIn("SomeWeirdException", result["message"])
        self.assertNotIn("X is not Y", result["message"])
        self.assertTrue(result["message"])  # 非空
        self.assertTrue(result["recovery_actions"])

    def test_error_category_priority_over_raw(self):
        """如果上层已分类到 error_category=rate_limit,优先按 category 翻译。"""
        result = translate_skill_error(
            "some unrelated raw message",
            error_category="rate_limit",
        )
        self.assertIn("限流", result["message"])
        self.assertTrue(result["recovery_actions"])

    def test_device_offline_category_is_actionable(self):
        """TS-39:设备离线是明确前置条件失败,不能显示成原因未知。"""
        result = translate_skill_error(
            "control_device sedas-MacBook-Air.local (darwin) status=offline",
            error_category="device_offline",
        )

        self.assertIn("设备当前离线", result["message"])
        self.assertIn("重新绑定", result["recovery_actions"][0])
        self.assertNotIn("原因暂时还没看清楚", result["message"])
        self.assertEqual(
            [item["kind"] for item in result["recovery_action_items"]],
            ["switch_agent", "rerun"],
        )

    def test_device_offline_raw_status_falls_back_to_actionable_message(self):
        """TS-39:上游漏传 category 时,raw status=offline 也要被翻译成人话。"""
        out = humanize_failure_message(
            "control_device sedas-MacBook-Air.local (darwin) status=offline",
        )

        self.assertIn("设备当前离线", out)
        self.assertIn("重新绑定", out)
        self.assertNotIn("原因暂时还没看清楚", out)

    def test_plain_offline_status_does_not_trigger_device_binding_message(self):
        """TS-39:只有 control_device 的离线错误才按执行设备离线处理。

        人话 raw 会透传，但不能误标成「执行设备离线」。
        """
        out = humanize_failure_message("upstream cache status=offline")

        self.assertNotIn("设备当前离线", out)
        self.assertNotIn("重新绑定", out)

    def test_model_upstream_429_translates_to_busy_message(self):
        """#4164：中文 429 / engine_overloaded 不能落进「没有带回详情」。"""
        result = translate_skill_error(
            "模型上游返回错误（429）……建议换一个模型重试",
            error_category="runtime_failed",
        )
        self.assertIn("太忙", result["message"])
        self.assertNotIn("没有带回更具体的错误详情", result["message"])
        self.assertNotIn("具体原因暂时还没看清楚", result["message"])
        self.assertEqual(
            [item["kind"] for item in result["recovery_action_items"]],
            ["wait_and_rerun", "retry_with_model"],
        )

    def test_device_dropped_category_is_actionable(self):
        """#4164：中途掉线要给出设备掉线文案，不能兜底成原因未知。"""
        result = translate_skill_error(
            "control_device abc dropped to offline mid-task",
            error_category="device_dropped",
        )
        self.assertIn("中途掉线", result["message"])
        self.assertNotIn("具体原因暂时还没看清楚", result["message"])
        self.assertEqual(
            [item["kind"] for item in result["recovery_action_items"]],
            ["wait_and_rerun", "switch_agent"],
        )

    def test_human_readable_raw_passthrough_when_no_needle(self):
        """#4164：未命中 needle 但 raw 已是人话时透传，不谎称无详情。"""
        raw = "模型服务暂时抽风了，请稍后再试一下"
        result = translate_skill_error(raw, error_category="runtime_failed")
        self.assertIn("抽风", result["message"])
        self.assertNotIn("没有带回更具体的错误详情", result["message"])
        self.assertNotIn("具体原因暂时还没看清楚", result["message"])

    def test_result_backend_unavailable_category_is_not_mislabeled_timeout(self):
        """GH ：结果存储（Redis）不可用导致无法确认状态时，必须翻译成
        「可能已完成 / 稍后确认」而**不是**「执行时间超过了上限」误标超时。"""
        result = translate_skill_error(
            "runtime result backend unavailable; completion unconfirmed",
            error_category="result_backend_unavailable",
        )
        self.assertIn("可能已经完成", result["message"])
        self.assertNotIn("执行时间超过了上限", result["message"])
        self.assertNotIn("原因暂时还没看清楚", result["message"])
        self.assertEqual(
            [item["kind"] for item in result["recovery_action_items"]],
            ["wait_and_rerun", "rerun"],
        )

    def test_llm_proxy_db_timeout_is_not_mislabeled_model_error(self):
        """GH ：LLM proxy 500 背后是远程 PostgreSQL 连接超时时，
        Tracker 应提示基础设施暂不可用，而不是泛化成模型异常或执行超时。"""
        raw = (
            "LLM proxy server error (500); OperationalError: connection to server at "
            "\"pgm-uf67jdvr2k2rxk7ibo.pg.rds.aliyuncs.com\", port 5432 failed: "
            "timeout expired"
        )
        result = translate_skill_error(raw, error_category="runtime_failed")

        self.assertIn("远程数据库/结果服务暂时不可用", result["message"])
        self.assertNotIn("执行时间超过了上限", result["message"])
        self.assertNotIn("模型", result["recovery_actions"][0])
        self.assertEqual(
            [item["kind"] for item in result["recovery_action_items"]],
            ["wait_and_rerun"],
        )

    def test_structured_llm_proxy_db_unavailable_category_is_actionable(self):
        result = translate_skill_error(
            "远程数据库/结果服务暂时不可用,请稍后重试。",
            error_category="llm_proxy_result_backend_unavailable",
        )

        self.assertIn("远程数据库/结果服务暂时不可用", result["message"])
        self.assertEqual(
            [item["kind"] for item in result["recovery_action_items"]],
            ["wait_and_rerun"],
        )

    def test_plain_llm_proxy_500_is_service_unavailable_not_unknown(self):
        result = translate_skill_error(
            "LLM proxy server error (500)",
            error_category="runtime_failed",
        )

        self.assertIn("模型请求服务暂时不可用", result["message"])
        self.assertNotIn("具体原因暂时还没看清楚", result["message"])
        self.assertEqual(
            [item["kind"] for item in result["recovery_action_items"]],
            ["wait_and_rerun"],
        )

    def test_runtime_failed_without_detail_is_still_actionable(self):
        result = translate_skill_error(
            "runtime done returned error",
            error_category="runtime_failed",
        )

        self.assertIn("返回了失败状态", result["message"])
        self.assertIn("没有带回更具体的错误详情", result["message"])
        self.assertNotIn("具体原因暂时还没看清楚", result["message"])
        self.assertEqual(
            [item["kind"] for item in result["recovery_action_items"]],
            ["rerun", "switch_agent"],
        )

    def test_translation_strips_internal_paths(self):
        """charter §4.4:翻译输出经 sanitize 仍要无内部路径。"""
        result = translate_skill_error(
            "permission denied at /Users/developer/dev/TabTin/TabTinAgent/apps/...",
        )
        self.assertNotIn("/Users", result["message"])
        self.assertNotIn("TabTinAgent", result["message"])

    def test_humanize_combines_message_and_recovery(self):
        """humanize_failure_message 单字段写入路径(TrackerRun.error_summary)。"""
        out = humanize_failure_message("kimi returned empty output")
        # 既有现象描述也有恢复建议
        self.assertIn("kimi", out.lower())
        self.assertTrue(any(kw in out for kw in ("GPT", "重试", "换")))
        # 不许有堆栈
        self.assertNotIn("Traceback", out)
        self.assertNotIn("File \"", out)


class FailureMessageAssertionTests(SimpleTestCase):
    """assert_failure_message_is_human_readable 契约。"""

    def test_traceback_marker_detected(self):
        bad = "Traceback (most recent call last):\n  File \"x.py\", line 1\nValueError: x"
        self.assertFalse(assert_failure_message_is_human_readable(bad))

    def test_python_exception_class_detected(self):
        bad = "RuntimeError: something bad happened"
        self.assertFalse(assert_failure_message_is_human_readable(bad))

    def test_error_code_format_detected(self):
        bad = "operation failed, error_code=E_TIMEOUT"
        self.assertFalse(assert_failure_message_is_human_readable(bad))

    def test_python_repr_detected(self):
        bad = "got <Foo object at 0x10ab12cd>"
        self.assertFalse(assert_failure_message_is_human_readable(bad))

    def test_human_readable_passes(self):
        good = "我用的 kimi 模型这次没返回结果,要不要换 GPT-4 重试?"
        self.assertTrue(assert_failure_message_is_human_readable(good))

    def test_humanize_output_always_passes_assertion(self):
        """无论 raw_error 有多丑陋,humanize 输出都要通过断言。"""
        ugly_inputs = [
            "Traceback (most recent call last):\n  File \"a.py\", line 1\nValueError",
            "ConnectionError: timed out at 192.168.1.1:5432",
            "<RuntimeError object at 0x7fff>",
            "errno: -111 connection refused",
            "",
            "kimi returned empty output",
            "rate limit hit",
        ]
        for raw in ugly_inputs:
            with self.subTest(raw=raw[:50]):
                msg = humanize_failure_message(raw)
                self.assertTrue(
                    assert_failure_message_is_human_readable(msg),
                    f"humanize output still has traceback markers: {msg!r}",
                )


class SanitizeRegressionTests(SimpleTestCase):
    """Wave 1 既有的脱敏函数在 Wave 6 不能被破坏。"""

    def test_sanitize_strips_internal_paths(self):
        out = sanitize_error_for_user("Failed at /Users/foo/tabtin/x.py:42")
        self.assertNotIn("/Users", out)
        self.assertNotIn("tabtin", out)

    def test_sanitize_strips_credentials(self):
        out = sanitize_error_for_user('config: api_key=sk-abc123 secret=xyz')
        self.assertIn("[redacted]", out)
        self.assertNotIn("sk-abc123", out)


class FailTrackerRunIntegrationTests(SimpleTestCase):
    """_fail_tracker_run 写入 error_summary 前必须经过翻译——契约层验证调用链。

    Wave 5 反思 9 教训:测试不许用 MagicMock 制造已删/不可达 model。
    本测试只验证"调用 _fail_tracker_run(raw_error)→ 写入的 summary 是人话"
    这一契约,通过 monkeypatch ORM update 来观测最终值,不动真 TrackerRun 表。
    """

    def test_fail_tracker_run_humanizes_before_write(self):
        from unittest.mock import MagicMock, patch

        captured = {}

        # 模拟 TrackerRun.objects.filter().update(...)
        # 这是 contract test:验证 update 调用时传的 error_summary 已是人话。
        # 不走真 ORM 因为 TrackerRun 是 PostgreSQL 跨库 model,SimpleTestCase 不支持;
        # Wave 5 反思 9 — 此处用 patch 仅观测,不制造任何"已删/不可达"行为。
        from apps.tracker.services import tracker_executor

        fake_run = MagicMock()
        fake_run.id = "00000000-0000-0000-0000-000000000000"
        fake_run.tracker.skill_key = "test-skill"
        fake_run.started_at = None

        def fake_filter(*args, **kwargs):
            qs = MagicMock()
            def fake_update(**fields):
                captured.update(fields)
                return 0  # 0 rows updated → 提早 return,不触发后续 _update_tracker_stats 等
            qs.update = fake_update
            return qs

        with patch.object(tracker_executor.TrackerRun.objects, "filter", side_effect=fake_filter):
            tracker_executor._fail_tracker_run(fake_run, "Traceback ...\nValueError: kimi returned empty output")

        # 写入 error_summary 必须是人话(Wave 6 §4.4)
        self.assertIn("error_summary", captured)
        summary = captured["error_summary"]
        self.assertNotIn("Traceback", summary)
        self.assertNotIn("ValueError", summary)
        # 命中 "kimi" 关键词后,应翻译为 kimi 模板
        self.assertIn("kimi", summary.lower())


class ExecutionFailedWrapperTests(SimpleTestCase):
    """#4230：``execution failed: {exc}`` 包装不能吞掉真实原因。"""

    def test_insufficient_credits_inside_wrapper_is_recognized(self):
        result = translate_skill_error("execution failed: insufficient_credits for org")
        self.assertIn("额度", result["message"])
        self.assertNotEqual(result["message"], "执行没能跑完")

    def test_no_device_inside_wrapper_is_recognized(self):
        result = translate_skill_error(
            "execution failed: 执行 Agent『默认』未绑定可用设备，无法运行无人值守任务"
        )
        self.assertIn("设备", result["message"])

    def test_unknown_detail_is_preserved_in_summary(self):
        result = translate_skill_error("execution failed: boom-reason-xyz")
        self.assertIn("boom-reason-xyz", result["message"])
        self.assertIn("执行没能跑完", result["message"])

    def test_bare_execution_failed_stays_generic(self):
        result = translate_skill_error("execution failed")
        self.assertEqual(result["message"], "执行没能跑完")
        self.assertTrue(result["recovery_actions"])
