from __future__ import annotations

from dataclasses import dataclass

from django.test import SimpleTestCase

from apps.services.oss.management.commands.check_oss_cors import (
    DESKTOP_RENDERER_ORIGIN,
    build_bucket_probe_url,
    evaluate_cors_rules,
    evaluate_preflight_response,
)


@dataclass
class CorsRuleStub:
    allowed_origins: list[str]
    allowed_methods: list[str]
    allowed_headers: list[str]
    expose_headers: list[str]
    max_age_seconds: int = 3600


class CheckOssCorsContractTest(SimpleTestCase):
    def test_accepts_rule_that_explicitly_allows_desktop_origin(self):
        result = evaluate_cors_rules([
            CorsRuleStub(
                allowed_origins=[
                    "https://www.example.com",
                    "https://*.example.com",
                    "http://localhost:*",
                    DESKTOP_RENDERER_ORIGIN,
                ],
                allowed_methods=["PUT", "POST", "GET", "HEAD"],
                allowed_headers=["*"],
                expose_headers=["ETag", "x-oss-request-id"],
            )
        ])

        self.assertTrue(result.ok)
        self.assertEqual(result.errors, [])

    def test_rejects_rule_without_desktop_origin(self):
        result = evaluate_cors_rules([
            CorsRuleStub(
                allowed_origins=["https://www.example.com", "http://localhost:*"],
                allowed_methods=["PUT", "POST", "GET", "HEAD"],
                allowed_headers=["*"],
                expose_headers=["ETag", "x-oss-request-id"],
            )
        ])

        self.assertFalse(result.ok)
        self.assertIn(f"AllowedOrigins 缺少 {DESKTOP_RENDERER_ORIGIN}", result.errors)

    def test_requires_content_type_for_presigned_put_preflight(self):
        result = evaluate_cors_rules([
            CorsRuleStub(
                allowed_origins=[DESKTOP_RENDERER_ORIGIN],
                allowed_methods=["PUT", "POST", "GET", "HEAD"],
                allowed_headers=["authorization"],
                expose_headers=["ETag", "x-oss-request-id"],
            )
        ])

        self.assertFalse(result.ok)
        self.assertIn("AllowedHeaders 缺少 content-type", result.errors)

    def test_requires_max_age_seconds_contract(self):
        result = evaluate_cors_rules([
            CorsRuleStub(
                allowed_origins=[DESKTOP_RENDERER_ORIGIN],
                allowed_methods=["PUT", "POST", "GET", "HEAD"],
                allowed_headers=["*"],
                expose_headers=["ETag", "x-oss-request-id"],
                max_age_seconds=60,
            )
        ])

        self.assertFalse(result.ok)
        self.assertIn("MaxAgeSeconds 低于 3600", result.errors)

    def test_warns_when_desktop_origin_only_uses_wildcard(self):
        result = evaluate_cors_rules([
            CorsRuleStub(
                allowed_origins=["*"],
                allowed_methods=["PUT", "POST", "GET", "HEAD"],
                allowed_headers=["*"],
                expose_headers=["ETag", "x-oss-request-id"],
            )
        ])

        self.assertTrue(result.ok)
        self.assertTrue(any("通过 * 放行桌面端 origin" in item for item in result.warnings))


class CheckOssCorsPreflightTest(SimpleTestCase):
    def test_builds_virtual_hosted_bucket_probe_url(self):
        url = build_bucket_probe_url(
            "example-assets",
            "oss-cn-wuhan-lr.aliyuncs.com",
            "__probe__/desktop cors.txt",
        )

        self.assertEqual(
            url,
            "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/__probe__/desktop%20cors.txt",
        )

    def test_accepts_successful_preflight_headers(self):
        result = evaluate_preflight_response(
            status_code=200,
            headers={
                "Access-Control-Allow-Origin": DESKTOP_RENDERER_ORIGIN,
                "Access-Control-Allow-Methods": "PUT, POST, GET, HEAD",
                "Access-Control-Allow-Headers": "content-type",
            },
            origin=DESKTOP_RENDERER_ORIGIN,
            method="PUT",
            request_headers=["content-type"],
        )

        self.assertTrue(result.ok)

    def test_rejects_failed_preflight_status(self):
        result = evaluate_preflight_response(
            status_code=403,
            headers={
                "Access-Control-Allow-Origin": "http://localhost:5175",
                "Access-Control-Allow-Methods": "GET",
                "Access-Control-Allow-Headers": "authorization",
            },
            origin=DESKTOP_RENDERER_ORIGIN,
            method="PUT",
            request_headers=["content-type"],
        )

        self.assertFalse(result.ok)
        self.assertIn("OPTIONS 预检返回 HTTP 403", result.errors)
        self.assertIn(
            f"Access-Control-Allow-Origin 未放行 {DESKTOP_RENDERER_ORIGIN}",
            result.errors,
        )
        self.assertIn("Access-Control-Allow-Methods 未放行 PUT", result.errors)
        self.assertIn("Access-Control-Allow-Headers 未放行 content-type", result.errors)
