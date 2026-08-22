"""
ASRStreamEvent 字段 (error_code / error_message / has_error / to_dict) 单元测试

覆盖：默认无错误、error_code 触发 has_error、error_message 触发 has_error、
      to_dict 无错误不含 errorCode/errorMessage、to_dict 有错误时包含两者
"""

import unittest

from apps.services.speech.asr.types import ASRStreamEvent


class TestASRStreamEventError(unittest.TestCase):
    """ASRStreamEvent has_error / to_dict 错误字段测试"""

    # 1. 默认 error_code=0, error_message="" → has_error 为 False
    def test_default_no_error(self):
        evt = ASRStreamEvent(text="hello")
        self.assertEqual(evt.error_code, 0)
        self.assertEqual(evt.error_message, "")
        self.assertFalse(evt.has_error)

    # 2. 有 error_code → has_error 为 True
    def test_has_error_with_error_code(self):
        evt = ASRStreamEvent(text="", error_code=40001)
        self.assertTrue(evt.has_error)

    # 3. 有 error_message → has_error 为 True
    def test_has_error_with_error_message(self):
        evt = ASRStreamEvent(text="", error_message="timeout")
        self.assertTrue(evt.has_error)

    def test_has_error_with_both(self):
        evt = ASRStreamEvent(text="", error_code=500, error_message="fail")
        self.assertTrue(evt.has_error)

    # 4. to_dict() 无错误时不包含 errorCode/errorMessage
    def test_to_dict_no_error_fields(self):
        evt = ASRStreamEvent(text="ok", is_final=True, sequence=3)
        d = evt.to_dict()

        self.assertNotIn("errorCode", d)
        self.assertNotIn("errorMessage", d)
        self.assertEqual(d["text"], "ok")
        self.assertTrue(d["isFinal"])
        self.assertEqual(d["sequence"], 3)
        self.assertIn("utterances", d)
        self.assertIn("audioInfo", d)

    # 5. to_dict() 有错误时包含 errorCode 和 errorMessage
    def test_to_dict_with_error_fields(self):
        evt = ASRStreamEvent(
            text="",
            error_code=50001,
            error_message="internal error",
        )
        d = evt.to_dict()

        self.assertEqual(d["errorCode"], 50001)
        self.assertEqual(d["errorMessage"], "internal error")

    def test_to_dict_error_code_only(self):
        evt = ASRStreamEvent(text="", error_code=999)
        d = evt.to_dict()

        self.assertEqual(d["errorCode"], 999)
        self.assertNotIn("errorMessage", d)

    def test_to_dict_error_message_only(self):
        evt = ASRStreamEvent(text="", error_message="oops")
        d = evt.to_dict()

        self.assertNotIn("errorCode", d)
        self.assertEqual(d["errorMessage"], "oops")


if __name__ == "__main__":
    unittest.main()
