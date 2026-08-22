"""校验 OSS bucket CORS 是否满足桌面端直传契约。"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Sequence
from urllib.parse import quote

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError


DESKTOP_RENDERER_ORIGIN = "tabtin-file://app"
DEFAULT_ALLOWED_ORIGINS = (
    "https://www.example.com",
    "https://*.example.com",
    "http://localhost:*",
    DESKTOP_RENDERER_ORIGIN,
)
DEFAULT_REQUIRED_METHODS = ("PUT", "POST", "GET", "HEAD")
DEFAULT_REQUEST_HEADERS = ("content-type",)
DEFAULT_EXPOSE_HEADERS = ("etag", "x-oss-request-id")
DEFAULT_PREFLIGHT_METHOD = "PUT"
DEFAULT_PROBE_KEY = "__tabtin_oss_cors_probe__"
DEFAULT_MAX_AGE_SECONDS = 3600
WILDCARD = "*"


@dataclass(frozen=True)
class CorsCheckResult:
    ok: bool
    errors: list[str]
    warnings: list[str]
    checked_rules: int = 0


def _as_list(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, Iterable):
        return [str(item) for item in value]
    return [str(value)]


def _normalized(values: Sequence[str]) -> set[str]:
    return {value.strip().lower() for value in values if value.strip()}


def _split_header_values(value: str | None) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _allows_value(allowed_values: Sequence[str], required_value: str) -> bool:
    normalized = _normalized(allowed_values)
    return WILDCARD in normalized or required_value.strip().lower() in normalized


def _allows_origin(allowed_origins: Sequence[str], required_origin: str) -> tuple[bool, bool]:
    normalized = _normalized(allowed_origins)
    if required_origin.strip().lower() in normalized:
        return True, False
    if WILDCARD in normalized:
        return True, True
    return False, False


def _cors_rule_values(rule: object, attr: str) -> list[str]:
    return _as_list(getattr(rule, attr, []))


def _rule_failures(
    rule: object,
    *,
    origin: str,
    required_methods: Sequence[str],
    request_headers: Sequence[str],
    expose_headers: Sequence[str],
    min_max_age_seconds: int,
) -> tuple[list[str], list[str]]:
    failures: list[str] = []
    warnings: list[str] = []

    origins = _cors_rule_values(rule, "allowed_origins")
    origin_allowed, origin_uses_wildcard = _allows_origin(origins, origin)
    if not origin_allowed:
        failures.append(f"AllowedOrigins 缺少 {origin}")
    elif origin_uses_wildcard:
        warnings.append(
            "AllowedOrigins 通过 * 放行桌面端 origin；若 OSS 支持精确 origin，"
            f"建议改为显式包含 {origin}"
        )

    methods = _cors_rule_values(rule, "allowed_methods")
    for method in required_methods:
        if not _allows_value(methods, method):
            failures.append(f"AllowedMethods 缺少 {method}")

    allowed_headers = _cors_rule_values(rule, "allowed_headers")
    for header in request_headers:
        if not _allows_value(allowed_headers, header):
            failures.append(f"AllowedHeaders 缺少 {header}")

    exposed_headers = _cors_rule_values(rule, "expose_headers")
    for header in expose_headers:
        if not _allows_value(exposed_headers, header):
            failures.append(f"ExposeHeaders 缺少 {header}")

    max_age_seconds = getattr(rule, "max_age_seconds", None)
    try:
        actual_max_age_seconds = int(max_age_seconds)
    except (TypeError, ValueError):
        failures.append(f"MaxAgeSeconds 缺少或低于 {min_max_age_seconds}")
    else:
        if actual_max_age_seconds < min_max_age_seconds:
            failures.append(f"MaxAgeSeconds 低于 {min_max_age_seconds}")

    return failures, warnings


def evaluate_cors_rules(
    rules: Sequence[object],
    *,
    origin: str = DESKTOP_RENDERER_ORIGIN,
    required_methods: Sequence[str] = DEFAULT_REQUIRED_METHODS,
    request_headers: Sequence[str] = DEFAULT_REQUEST_HEADERS,
    expose_headers: Sequence[str] = DEFAULT_EXPOSE_HEADERS,
    min_max_age_seconds: int = DEFAULT_MAX_AGE_SECONDS,
) -> CorsCheckResult:
    """判断是否存在一条 CORS rule 完整满足直传契约。"""

    best_failures: list[str] | None = None
    collected_warnings: list[str] = []

    for rule in rules:
        failures, warnings = _rule_failures(
            rule,
            origin=origin,
            required_methods=required_methods,
            request_headers=request_headers,
            expose_headers=expose_headers,
            min_max_age_seconds=min_max_age_seconds,
        )
        collected_warnings.extend(warnings)
        if not failures:
            return CorsCheckResult(
                ok=True,
                errors=[],
                warnings=collected_warnings,
                checked_rules=len(rules),
            )
        if best_failures is None or len(failures) < len(best_failures):
            best_failures = failures

    if not rules:
        best_failures = ["Bucket 当前没有任何 CORS 规则"]

    return CorsCheckResult(
        ok=False,
        errors=best_failures or ["没有找到满足 TabTin 直传契约的 CORS 规则"],
        warnings=collected_warnings,
        checked_rules=len(rules),
    )


def build_bucket_probe_url(bucket_name: str, endpoint: str, object_key: str) -> str:
    endpoint = endpoint.strip()
    if endpoint.startswith("http://"):
        endpoint = endpoint.removeprefix("http://")
    if endpoint.startswith("https://"):
        endpoint = endpoint.removeprefix("https://")
    endpoint = endpoint.strip("/")

    if not bucket_name or not endpoint:
        raise ValueError("bucket_name 和 endpoint 均不能为空")

    host = (
        endpoint
        if endpoint.startswith(f"{bucket_name}.")
        else f"{bucket_name}.{endpoint}"
    )
    return f"https://{host}/{quote(object_key.lstrip('/'), safe='/')}"


def evaluate_preflight_response(
    *,
    status_code: int,
    headers: object,
    origin: str,
    method: str,
    request_headers: Sequence[str],
) -> CorsCheckResult:
    errors: list[str] = []
    warnings = [
        "OPTIONS 预检只能证明浏览器 PUT 是否会被放行；"
        "ExposeHeaders 仍以 bucket CORS 静态配置为准"
    ]

    if status_code < 200 or status_code >= 300:
        errors.append(f"OPTIONS 预检返回 HTTP {status_code}")

    allow_origin = getattr(headers, "get", lambda _name, _default=None: None)(
        "Access-Control-Allow-Origin"
    )
    if not _allows_origin(_split_header_values(allow_origin), origin)[0]:
        errors.append(f"Access-Control-Allow-Origin 未放行 {origin}")

    allow_methods = _split_header_values(
        getattr(headers, "get", lambda _name, _default=None: None)(
            "Access-Control-Allow-Methods"
        )
    )
    if not _allows_value(allow_methods, method):
        errors.append(f"Access-Control-Allow-Methods 未放行 {method}")

    allow_headers = _split_header_values(
        getattr(headers, "get", lambda _name, _default=None: None)(
            "Access-Control-Allow-Headers"
        )
    )
    for header in request_headers:
        if not _allows_value(allow_headers, header):
            errors.append(f"Access-Control-Allow-Headers 未放行 {header}")

    return CorsCheckResult(ok=not errors, errors=errors, warnings=warnings, checked_rules=0)


def _contract_payload() -> dict[str, object]:
    return {
        "allowed_origins": list(DEFAULT_ALLOWED_ORIGINS),
        "allowed_methods": list(DEFAULT_REQUIRED_METHODS),
        "allowed_headers": ["*"],
        "expose_headers": list(DEFAULT_EXPOSE_HEADERS),
        "max_age_seconds": DEFAULT_MAX_AGE_SECONDS,
        "desktop_renderer_origin": DESKTOP_RENDERER_ORIGIN,
        "preflight_request": {
            "method": DEFAULT_PREFLIGHT_METHOD,
            "request_headers": list(DEFAULT_REQUEST_HEADERS),
        },
    }


class Command(BaseCommand):
    help = "校验 OSS bucket CORS 是否允许 Electron 桌面端直传 PUT 预检"

    def add_arguments(self, parser):
        parser.add_argument(
            "--origin",
            default=DESKTOP_RENDERER_ORIGIN,
            help=f"要校验的 renderer origin，默认 {DESKTOP_RENDERER_ORIGIN}",
        )
        parser.add_argument(
            "--method",
            default=DEFAULT_PREFLIGHT_METHOD,
            help=f"预检使用的方法，默认 {DEFAULT_PREFLIGHT_METHOD}",
        )
        parser.add_argument(
            "--request-header",
            action="append",
            dest="request_headers",
            help="预检请求头，可重复传入；默认只检查 content-type",
        )
        parser.add_argument(
            "--preflight",
            action="store_true",
            help="对 bucket 发真实 OPTIONS 预检；默认读取 bucket CORS 静态规则",
        )
        parser.add_argument(
            "--bucket",
            default="",
            help="覆盖 settings.ALIYUN_OSS_BUCKET_NAME，仅 --preflight 使用",
        )
        parser.add_argument(
            "--endpoint",
            default="",
            help="覆盖 settings.ALIYUN_OSS_ENDPOINT，仅 --preflight 使用",
        )
        parser.add_argument(
            "--probe-key",
            default=DEFAULT_PROBE_KEY,
            help=f"OPTIONS 预检对象 key，默认 {DEFAULT_PROBE_KEY}",
        )
        parser.add_argument(
            "--timeout",
            type=float,
            default=10.0,
            help="OPTIONS 预检超时时间，单位秒",
        )
        parser.add_argument(
            "--print-contract",
            action="store_true",
            help="输出 TabTin 要求的 OSS CORS 契约，不访问 bucket",
        )
        parser.add_argument("--json", action="store_true", help="以 JSON 输出结果")

    def handle(self, *args, **options):
        request_headers = options.get("request_headers") or list(DEFAULT_REQUEST_HEADERS)

        if options["print_contract"]:
            self._emit(_contract_payload(), as_json=options["json"])
            return

        if options["preflight"]:
            result = self._check_preflight(
                origin=options["origin"],
                method=options["method"],
                request_headers=request_headers,
                bucket_name=options["bucket"] or getattr(settings, "ALIYUN_OSS_BUCKET_NAME", ""),
                endpoint=options["endpoint"] or getattr(settings, "ALIYUN_OSS_ENDPOINT", ""),
                object_key=options["probe_key"],
                timeout=options["timeout"],
            )
        else:
            result = self._check_bucket_cors(
                origin=options["origin"],
                request_headers=request_headers,
            )

        payload = {
            "ok": result.ok,
            "checked_rules": result.checked_rules,
            "errors": result.errors,
            "warnings": result.warnings,
            "origin": options["origin"],
            "method": options["method"],
            "request_headers": request_headers,
        }
        self._emit(payload, as_json=options["json"])
        if not result.ok:
            raise CommandError("OSS bucket CORS 未满足 TabTin 桌面端直传契约")

    def _check_bucket_cors(self, *, origin: str, request_headers: Sequence[str]) -> CorsCheckResult:
        from apps.services.oss.services.factory import get_oss_service

        oss_service = get_oss_service()
        bucket = getattr(oss_service, "bucket", None)
        if bucket is None:
            raise CommandError("当前 OSS service 没有 bucket 句柄，无法读取 bucket CORS")

        try:
            cors = bucket.get_bucket_cors()
            rules = list(getattr(cors, "rules", []) or [])
        except Exception as exc:
            if "NoSuchCORS" in type(exc).__name__ or "NoSuchCORS" in str(exc):
                rules = []
            else:
                raise CommandError(f"读取 bucket CORS 失败: {exc}") from exc

        return evaluate_cors_rules(
            rules,
            origin=origin,
            required_methods=DEFAULT_REQUIRED_METHODS,
            request_headers=request_headers,
            expose_headers=DEFAULT_EXPOSE_HEADERS,
            min_max_age_seconds=DEFAULT_MAX_AGE_SECONDS,
        )

    def _check_preflight(
        self,
        *,
        origin: str,
        method: str,
        request_headers: Sequence[str],
        bucket_name: str,
        endpoint: str,
        object_key: str,
        timeout: float,
    ) -> CorsCheckResult:
        import requests

        try:
            url = build_bucket_probe_url(bucket_name, endpoint, object_key)
        except ValueError as exc:
            raise CommandError(str(exc)) from exc

        headers = {
            "Origin": origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": ", ".join(request_headers),
        }
        try:
            response = requests.options(url, headers=headers, timeout=timeout)
        except requests.RequestException as exc:
            raise CommandError(
                "OPTIONS 预检请求失败："
                f"url={url} origin={origin} method={method} "
                f"request_headers={list(request_headers)} error={exc}"
            ) from exc

        return evaluate_preflight_response(
            status_code=response.status_code,
            headers=response.headers,
            origin=origin,
            method=method,
            request_headers=request_headers,
        )

    def _emit(self, payload: dict[str, object], *, as_json: bool) -> None:
        if as_json:
            self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
            return

        if "allowed_origins" in payload:
            self.stdout.write("TabTin OSS CORS contract")
            for key, value in payload.items():
                self.stdout.write(f"{key}: {value}")
            return

        ok = payload["ok"]
        self.stdout.write(self.style.SUCCESS("OSS CORS OK") if ok else self.style.ERROR("OSS CORS FAIL"))
        for warning in payload["warnings"]:
            self.stdout.write(self.style.WARNING(f"warning: {warning}"))
        for error in payload["errors"]:
            self.stdout.write(self.style.ERROR(f"error: {error}"))
