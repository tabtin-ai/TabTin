from __future__ import annotations

from django.test import SimpleTestCase

from apps.services.speech.exceptions import (
    SpeechConfigError,
    SpeechError,
    SpeechUpstreamError,
)
from apps.services.speech.asr.factory import ASRConfigError, ASRUpstreamError
from apps.services.speech.tts.factory import TTSConfigError, TTSUpstreamError


class ExceptionHierarchyTest(SimpleTestCase):
    """验证统一异常体系的继承关系"""

    def test_speech_error_is_base(self):
        self.assertTrue(issubclass(SpeechConfigError, SpeechError))
        self.assertTrue(issubclass(SpeechUpstreamError, SpeechError))

    def test_asr_config_error_hierarchy(self):
        self.assertTrue(issubclass(ASRConfigError, SpeechConfigError))
        self.assertTrue(issubclass(ASRConfigError, SpeechError))
        self.assertIsInstance(ASRConfigError("test"), SpeechConfigError)

    def test_tts_config_error_hierarchy(self):
        self.assertTrue(issubclass(TTSConfigError, SpeechConfigError))
        self.assertTrue(issubclass(TTSConfigError, SpeechError))
        self.assertIsInstance(TTSConfigError("test"), SpeechConfigError)

    def test_asr_upstream_error_hierarchy(self):
        self.assertTrue(issubclass(ASRUpstreamError, SpeechUpstreamError))
        self.assertTrue(issubclass(ASRUpstreamError, SpeechError))
        self.assertIsInstance(ASRUpstreamError("test"), SpeechUpstreamError)

    def test_tts_upstream_error_hierarchy(self):
        self.assertTrue(issubclass(TTSUpstreamError, SpeechUpstreamError))
        self.assertTrue(issubclass(TTSUpstreamError, SpeechError))
        self.assertIsInstance(TTSUpstreamError("test"), SpeechUpstreamError)

    def test_except_speech_config_error_catches_asr(self):
        with self.assertRaises(SpeechConfigError):
            raise ASRConfigError("asr config issue")

    def test_except_speech_config_error_catches_tts(self):
        with self.assertRaises(SpeechConfigError):
            raise TTSConfigError("tts config issue")

    def test_except_speech_upstream_error_catches_asr(self):
        with self.assertRaises(SpeechUpstreamError):
            raise ASRUpstreamError("asr upstream issue")

    def test_except_speech_upstream_error_catches_tts(self):
        with self.assertRaises(SpeechUpstreamError):
            raise TTSUpstreamError("tts upstream issue")

    def test_except_speech_error_catches_all(self):
        for exc_class in (ASRConfigError, TTSConfigError, ASRUpstreamError, TTSUpstreamError):
            with self.assertRaises(SpeechError):
                raise exc_class("test")

    def test_config_and_upstream_are_siblings(self):
        """Config 和 Upstream 不应互相捕获"""
        self.assertFalse(issubclass(SpeechConfigError, SpeechUpstreamError))
        self.assertFalse(issubclass(SpeechUpstreamError, SpeechConfigError))
