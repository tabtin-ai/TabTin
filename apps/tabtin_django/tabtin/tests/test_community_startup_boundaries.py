from __future__ import annotations

import builtins
import importlib
import os
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.channel_gateway.apps import ADAPTER_MAP, ChannelGatewayConfig
from apps.updater.apps import UpdaterConfig
from tabtin import otel_init
from tabtin import sentry as sentry_module


class CommunityStartupBoundaryTests(SimpleTestCase):
    def test_external_channels_are_off_by_default_but_explicit_selection_survives(self):
        with patch.dict(
            os.environ,
            {"TABTIN_EDITION": "community"},
            clear=True,
        ):
            self.assertEqual(ChannelGatewayConfig._get_configured_channels(), [])

        with patch.dict(
            os.environ,
            {
                "TABTIN_EDITION": "community",
                "TABTIN_CHANNELS": "slack",
            },
            clear=True,
        ):
            self.assertEqual(
                ChannelGatewayConfig._get_configured_channels(),
                ["slack"],
            )

    def test_saas_keeps_the_existing_all_channels_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                ChannelGatewayConfig._get_configured_channels(),
                list(ADAPTER_MAP),
            )

    def test_company_sentry_is_blocked_before_sdk_import(self):
        real_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name == "sentry_sdk" or name.startswith("sentry_sdk."):
                raise AssertionError("sentry SDK import attempted")
            return real_import(name, *args, **kwargs)

        with (
            patch.dict(
                os.environ,
                {
                    "TABTIN_EDITION": "community",
                    "SENTRY_DSN": "https://public@sentry.example.com/1",
                },
                clear=True,
            ),
            patch.object(builtins, "__import__", side_effect=guarded_import),
        ):
            self.assertFalse(sentry_module.init_sentry())

    def test_explicit_third_party_sentry_remains_configurable(self):
        sdk = MagicMock()
        django_integration = MagicMock()
        celery_integration = MagicMock()
        modules = {
            "sentry_sdk": sdk,
            "sentry_sdk.integrations": MagicMock(),
            "sentry_sdk.integrations.django": MagicMock(
                DjangoIntegration=django_integration
            ),
            "sentry_sdk.integrations.celery": MagicMock(
                CeleryIntegration=celery_integration
            ),
        }
        with (
            patch.dict(
                os.environ,
                {
                    "TABTIN_EDITION": "community",
                    "SENTRY_DSN": "https://public@sentry.user.example/1",
                    "SENTRY_ENVIRONMENT": "production",
                },
                clear=True,
            ),
            patch.dict("sys.modules", modules, clear=False),
            patch.object(sentry_module, "_initialized", False),
        ):
            self.assertTrue(sentry_module.init_sentry())

        sdk.init.assert_called_once()

    def test_company_otel_is_blocked_before_sdk_import(self):
        otel_init.reset_for_test()
        real_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name.startswith("opentelemetry.sdk"):
                raise AssertionError("OTel SDK import attempted")
            return real_import(name, *args, **kwargs)

        with (
            patch.dict(
                os.environ,
                {
                    "TABTIN_EDITION": "community",
                    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://otel.example.com/v1/traces",
                },
                clear=True,
            ),
            patch.object(builtins, "__import__", side_effect=guarded_import),
        ):
            self.assertFalse(otel_init.setup_otel())

    def test_explicit_third_party_otel_remains_configurable(self):
        otel_init.reset_for_test()
        with (
            patch.dict(
                os.environ,
                {
                    "TABTIN_EDITION": "community",
                    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector.user.example:4317",
                },
                clear=True,
            ),
            patch("opentelemetry.trace.set_tracer_provider") as set_provider,
            patch("opentelemetry.sdk.trace.TracerProvider") as provider_class,
            patch("opentelemetry.sdk.trace.export.BatchSpanProcessor"),
            patch(
                "opentelemetry.exporter.otlp.proto.grpc.trace_exporter.OTLPSpanExporter"
            ),
        ):
            provider = MagicMock()
            provider_class.return_value = provider
            self.assertTrue(otel_init.setup_otel())

        set_provider.assert_called_once_with(provider)

    def test_community_updater_has_no_company_cdn_startup_warning(self):
        app_module = importlib.import_module("apps.updater")
        config = UpdaterConfig("apps.updater", app_module)

        with (
            patch.dict(os.environ, {"TABTIN_EDITION": "community"}, clear=True),
            patch("apps.updater.apps.logger.warning") as warning,
        ):
            config.ready()

        warning.assert_not_called()
