"""Import an already installed Ollama model through the existing BYOK boundary."""

import json
import os
from types import SimpleNamespace

import httpx
from django.core.management.base import BaseCommand, CommandError
from django.core.exceptions import ValidationError
from django.db import transaction

from apps.services.common.db_router import postgres_app_db_alias
from apps.services.common.permissions import ensure_organization_permission_for_user
from apps.services.llm.api_common import _normalize_base_url, _normalize_provider_key
from apps.services.llm.api_config import (
    create_organization_model,
    create_organization_provider,
    set_organization_default_model,
)
from apps.services.llm.models import LLMModel, LLMProvider
from apps.services.llm.schemas import (
    OrganizationDefaultModelRequest,
    OrganizationModelCreateRequest,
    OrganizationProviderCreateRequest,
)
from apps.tabtinspace.models import Organization


def model_capabilities(metadata):
    """Do not inherit cloud OpenAI tool/vision defaults for local models."""
    capabilities = metadata.get("capabilities", [])
    if "completion" not in capabilities:
        raise CommandError("The Ollama model does not advertise completion support.")
    return {
        "supports_streaming": True,
        "supports_function_calling": "tools" in capabilities,
        "supports_vision": "vision" in capabilities,
        "supports_json_mode": True,
        "json_mode": {"modes": ["json_object"]},
    }


def response_data(response):
    payload = response if isinstance(response, dict) else json.loads(response.content)
    if not payload.get("success"):
        raise CommandError(payload.get("message") or "BYOK configuration failed.")
    return payload.get("data") or {}


class Command(BaseCommand):
    help = "Import an installed Ollama model into an organization's BYOK configuration."

    def add_arguments(self, parser):
        parser.add_argument("--organization-id", required=True)
        parser.add_argument("--model", required=True, help="Exact Ollama model name, including tag.")
        parser.add_argument("--base-url", default="http://localhost:11434/v1")
        parser.add_argument("--provider-key", default="openai-ollama-local")
        parser.add_argument("--context-window", type=int, default=4096,
                            help="Actual Ollama runtime context, not the model's theoretical capacity.")
        parser.add_argument("--max-output-tokens", type=int, default=2048)
        parser.add_argument("--set-default", action="store_true")
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options):
        try:
            base_url = _normalize_base_url(options["base_url"])
            provider_key = _normalize_provider_key(options["provider_key"])
        except Exception as exc:
            raise CommandError("Invalid Base URL or provider key.") from exc
        if not base_url.endswith("/v1"):
            raise CommandError("Ollama Base URL must end in /v1.")
        context = options["context_window"]
        output = options["max_output_tokens"]
        if not 0 < output < context:
            raise CommandError("Require 0 < max-output-tokens < context-window.")
        try:
            organization = Organization.objects.select_related("owner").get(
                pk=options["organization_id"], status="active",
            )
        except (Organization.DoesNotExist, ValidationError, ValueError) as exc:
            raise CommandError("Active organization not found.") from exc
        ensure_organization_permission_for_user(organization.owner, str(organization.id), "owner")
        request = SimpleNamespace(auth=organization.owner)
        api_key = os.environ.get("OLLAMA_API_KEY") or "ollama"
        try:
            # A local model endpoint must not go through an inherited outbound proxy.
            with httpx.Client(timeout=30, trust_env=False) as client:
                response = client.post(
                    base_url[:-3] + "/api/show",
                    json={"model": options["model"]},
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                response.raise_for_status()
                metadata = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise CommandError("Cannot inspect the installed Ollama model; no configuration written.") from exc
        capabilities = model_capabilities(metadata)
        capacities = [value for key, value in metadata.get("model_info", {}).items()
                      if key.endswith(".context_length") and isinstance(value, int)]
        if capacities and context > min(capacities):
            raise CommandError("Requested context exceeds the model's advertised capacity.")
        if options["dry_run"]:
            self.stdout.write(json.dumps({
                "model": options["model"], "base_url": base_url,
                "context_window_tokens": context, "capabilities": capabilities,
            }))
            return

        scope = "user" if organization.type == "personal" else "organization"
        identity = {"scope": scope, "provider_key": provider_key}
        identity.update({"user_id": str(organization.owner_id)} if scope == "user"
                        else {"organization_id": str(organization.id)})
        with transaction.atomic(using=postgres_app_db_alias()):
            provider = LLMProvider.objects.filter(**identity).first()
            if provider is None:
                created = response_data(create_organization_provider(
                    request, str(organization.id), OrganizationProviderCreateRequest(
                        provider_name="openai", provider_key=provider_key,
                        display_name="Ollama Local", base_url=base_url,
                        api_key=api_key, scope=scope,
                    ),
                ))
                provider = LLMProvider.objects.get(pk=created["provider_id"])
            elif (provider.name != "openai" or provider.default_base_url.rstrip("/") != base_url
                  or not provider.routing_enabled):
                raise CommandError("Existing provider differs or is disabled; use another provider key.")
            model = LLMModel.objects.filter(provider=provider, model_name=options["model"]).first()
            if model is None:
                created = response_data(create_organization_model(
                    request, str(organization.id), OrganizationModelCreateRequest(
                        provider_id=str(provider.id), model_name=options["model"],
                        display_name=f"Ollama / {options['model']}", base_url=base_url,
                        context_window_tokens=context, max_output_tokens=output,
                        capabilities_config=capabilities,
                    ),
                ))
                model = LLMModel.objects.get(pk=created["model_id"])
            elif model.base_url.rstrip("/") != base_url:
                raise CommandError("Existing model uses a different endpoint; it was not overwritten.")
        if options["set_default"]:
            response_data(set_organization_default_model(
                request, str(organization.id), OrganizationDefaultModelRequest(model_id=str(model.id)),
            ))
        self.stdout.write(self.style.SUCCESS(
            f"Imported {model.model_name}: model_id={model.id}, scope={scope}. "
            "Existing model settings are preserved; verify a real chat and tool call before use."
        ))
