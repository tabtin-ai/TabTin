import sys
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase
from pydantic import BaseModel


class StructuredPayload(BaseModel):
    answer: str


class StructuredOutputBillingTests(SimpleTestCase):
    def _service(self):
        service = SimpleNamespace()
        service.supports_structured_output = lambda: False
        service.provider_name = "local"
        service.chat = lambda messages, **kwargs: {
            "success": True,
            "content": '{"answer": "paid result"}',
            "usage": {"input_tokens": 2, "output_tokens": 3, "total_tokens": 5},
        }
        return service

    def test_fallback_does_not_return_parsed_object_when_charge_fails(self):
        fake_langchain_openai = SimpleNamespace(ChatOpenAI=object)

        with patch.dict(sys.modules, {"langchain_openai": fake_langchain_openai}):
            from apps.services.llm.services.structured_output import (
                StructuredOutputBillingError,
                StructuredOutputWrapper,
            )

            wrapper = StructuredOutputWrapper(
                self._service(),
                StructuredPayload,
                max_retries=1,
                user_id="user-1",
                organization_id="organization-1",
            )

            with patch.object(wrapper, "_precheck"), patch(
                "apps.services.llm.services.billed_call.safe_charge_usage",
                return_value=False,
            ):
                with self.assertRaises(StructuredOutputBillingError):
                    wrapper.chat([{"role": "user", "content": "answer"}])
