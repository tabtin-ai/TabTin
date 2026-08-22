"""Speech scene seed bindings for ByteDance/Doubao models."""

import importlib

from django.test import SimpleTestCase

from apps.services.llm.management.commands.seed_scene_bindings import DEFAULT_MODELS
from apps.services.llm.services.speech import _SCENE_TO_ASR_MODE, _SCENE_TO_TTS_MODE


def _model_config(domain: str) -> dict:
    return next(
        item["capabilities_config"]
        for item in DEFAULT_MODELS
        if item["provider_key"] == "bytedance_default"
        and item["capability_domain"] == domain
    )


class SeedSpeechSceneBindingsTest(SimpleTestCase):
    def test_asr_scenes_bind_to_doubao_resource_ids(self):
        resource_ids = _model_config("asr")["resource_ids"]

        self.assertEqual(
            resource_ids[_SCENE_TO_ASR_MODE["asr_recognize_flash"]],
            "volc.bigasr.auc_turbo",
        )
        self.assertEqual(
            resource_ids[_SCENE_TO_ASR_MODE["asr_transcribe_standard"]],
            "volc.bigasr.auc",
        )
        self.assertEqual(
            resource_ids[_SCENE_TO_ASR_MODE["asr_realtime_stream"]],
            "volc.bigasr.sauc.duration",
        )

    def test_tts_scenes_bind_to_seed_tts_3(self):
        resource_ids = _model_config("tts")["resource_ids"]

        self.assertEqual(
            resource_ids[_SCENE_TO_TTS_MODE["tts_synthesize_http"]],
            "seed-tts-3.0",
        )
        self.assertEqual(
            resource_ids[_SCENE_TO_TTS_MODE["tts_synthesize_stream"]],
            "seed-tts-3.0",
        )

    def test_migration_merge_preserves_operator_config(self):
        migration = importlib.import_module(
            "apps.services.llm.migrations.0035_bind_bytedance_speech_scenes"
        )

        merged = migration._merge_config(
            {
                "app_id": "operator-app",
                "secret_key": "operator-secret",
                "resource_ids": {"http": "old-resource"},
                "speech": {"custom_flag": "keep"},
            },
            migration.TTS_CAPABILITIES,
        )

        self.assertEqual(merged["app_id"], "operator-app")
        self.assertEqual(merged["secret_key"], "operator-secret")
        self.assertEqual(merged["speech"]["custom_flag"], "keep")
        self.assertEqual(merged["resource_ids"]["http"], "seed-tts-3.0")
