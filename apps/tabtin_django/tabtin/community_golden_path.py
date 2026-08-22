"""Self-contained Community golden-path probe.

This is an installation verifier, not an application API.  It drives the
same HTTP and WebSocket contracts used by Electron, while a local fake
OpenAI-compatible server supplies the only model response.
"""

from __future__ import annotations

import argparse
import asyncio
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import sys
import time
from typing import Any
from uuid import uuid4


HTTP_BASE = os.environ.get("COMMUNITY_PROBE_HTTP_BASE", "http://127.0.0.1:6060")
WS_URL = os.environ.get("COMMUNITY_PROBE_WS_URL", "ws://127.0.0.1:6060/ws/v1/gateway")
FAKE_LLM_BASE_URL = os.environ.get(
    "COMMUNITY_PROBE_LLM_BASE_URL",
    "http://host.docker.internal:18080/v1",
).rstrip("/")
FAKE_LLM_MODEL = "community-golden-model"
FAKE_LLM_KEY = "local-no-key"
REGISTER_CODE = "731905"


class _FakeOpenAIHandler(BaseHTTPRequestHandler):
    hits: list[dict[str, Any]] = []

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
        if self.path == "/health":
            self._json(200, {"status": "ok"})
        elif self.path == "/hits":
            self._json(200, {"hits": self.hits})
        else:
            self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
        if self.path != "/v1/chat/completions":
            self._json(404, {"error": "not_found"})
            return
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        model = str(payload.get("model") or "")
        self.hits.append(
            {
                "path": self.path,
                "model": model,
                "authorization_present": bool(self.headers.get("authorization")),
            }
        )
        self._json(
            200,
            {
                "id": "chatcmpl-community-local",
                "object": "chat.completion",
                "created": 0,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "community golden path response",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 3,
                    "completion_tokens": 4,
                    "total_tokens": 7,
                },
            },
        )

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def run_fake_llm() -> None:
    ThreadingHTTPServer(("127.0.0.1", 18080), _FakeOpenAIHandler).serve_forever()


def _setup_django() -> None:
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
    import django

    django.setup()


def _data(response: Any, expected_status: int = 200) -> Any:
    if response.status_code != expected_status:
        raise AssertionError(
            f"{response.request.method} {response.request.url.path} "
            f"returned {response.status_code}: {response.text[:300]}"
        )
    payload = response.json()
    if payload.get("success") is not True or payload.get("code") != "SUCCESS":
        raise AssertionError(
            f"{response.request.method} {response.request.url.path} "
            f"failed with {payload.get('code')}"
        )
    return payload.get("data")


def _envelope(
    message_type: str,
    *,
    fingerprint: str,
    payload: dict[str, Any],
    organization_id: str | None = None,
    thread_id: str | None = None,
    request_id: str | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {
        "v": 1,
        "type": message_type,
        "request_id": request_id or f"community-{uuid4().hex}",
        "ts": int(time.time()),
        "device_id": fingerprint,
        "role": "electron",
        "payload": payload,
    }
    if organization_id:
        message["organization_id"] = organization_id
    if thread_id:
        message["thread_id"] = thread_id
    return message


async def _receive(websocket: Any, predicate: Any, label: str) -> dict[str, Any]:
    seen: list[str] = []
    for _ in range(40):
        message = json.loads(await asyncio.wait_for(websocket.recv(), timeout=10))
        seen.append(str(message.get("type")))
        if predicate(message):
            return message
        if message.get("type") in {"error", "chat.send_message.nak"}:
            raise AssertionError(f"WebSocket failed waiting for {label}: {message}")
    raise AssertionError(f"WebSocket did not produce {label}; seen={seen}")


def _register_login_onboard(http: Any, suffix: str) -> dict[str, Any]:
    from django.contrib.auth import get_user_model
    from apps.users.auth.verification_manager import VerificationCodeManager
    from apps.tabtinspace.models import Agent, Organization, OrganizationMember

    email = f"community-{suffix}@example.com"
    username = f"c_{suffix[:12]}"
    password = f"Community!Aa{suffix[:12]}"
    if get_user_model().objects.filter(email=email).exists():
        raise AssertionError("fresh probe identity already exists")
    if not VerificationCodeManager.cache_code(email, REGISTER_CODE, "register"):
        raise AssertionError("could not seed isolated registration verification code")

    registered = _data(
        http.post(
            "/api/auth/register",
            json={
                "email": email,
                "username": username,
                "password": password,
                "verification_code": REGISTER_CODE,
                "language": "en-US",
            },
        )
    )
    logged_in = _data(
        http.post(
            "/api/auth/login",
            json={"username": email, "password": password, "remember_me": False},
        )
    )
    user = get_user_model().objects.get(id=registered["user"]["id"])
    organizations = list(Organization.objects.filter(owner=user))
    if len(organizations) != 1:
        raise AssertionError("registration did not create one Organization")
    organization = organizations[0]
    if not OrganizationMember.objects.filter(
        organization=organization,
        user=user,
        role="owner",
    ).exists():
        raise AssertionError("registration did not create owner membership")
    agents = list(
        Agent.objects.filter(
            organization=organization,
            owner_user=user,
            is_active=True,
        )
    )
    if len(agents) != 1:
        raise AssertionError("registration did not create one default Agent")
    return {
        "user": user,
        "organization": organization,
        "agent": agents[0],
        "token": str(logged_in["access_token"]),
        "email": email,
    }


def _assert_fresh_ai_state() -> dict[str, Any]:
    from apps.maintenance.community_bootstrap import get_community_ai_readiness
    from apps.services.llm.models import LLMModel, LLMProvider, LLMSceneBinding

    counts = {
        "provider": LLMProvider.objects.count(),
        "model": LLMModel.objects.count(),
        "binding": LLMSceneBinding.objects.count(),
    }
    if counts != {"provider": 0, "model": 0, "binding": 0}:
        raise AssertionError(f"fresh AI catalog is not empty: {counts}")
    readiness = get_community_ai_readiness().status.value
    if readiness != "NOT_CONFIGURED":
        raise AssertionError(f"unexpected fresh AI readiness: {readiness}")
    return {**counts, "status": "AI_NOT_CONFIGURED"}


def _configure_byok(http: Any, *, token: str, organization: Any) -> dict[str, str]:
    from apps.services.llm.models import LLMModel, LLMProvider, LLMSceneBinding
    from apps.services.llm.scenes.registry import SCENES
    from apps.services.llm.scenes.policy import resolve_runtime_scene_payer
    from apps.services.llm.services._runtime.byok_resolver import resolve_scene_execution

    headers = {"authorization": f"Bearer {token}"}
    base = f"/api/services/llm/organizations/{organization.id}"
    provider_data = _data(
        http.post(
            f"{base}/providers",
            headers=headers,
            json={
                "provider_name": "openai",
                "provider_key": "openai",
                "display_name": "Local OpenAI compatible",
                "base_url": FAKE_LLM_BASE_URL,
                "api_key": FAKE_LLM_KEY,
                "scope": "organization",
            },
        )
    )
    model_data = _data(
        http.post(
            f"{base}/models",
            headers=headers,
            json={
                "provider_id": provider_data["provider_id"],
                "model_name": FAKE_LLM_MODEL,
                "display_name": "Community Golden Model",
                "context_window_tokens": 200000,
                "max_output_tokens": 16384,
                "capabilities_config": {
                    "supports_streaming": True,
                    "supports_function_calling": True,
                    "supports_json_mode": True,
                    "json_mode": {"modes": ["json_object"]},
                },
            },
        )
    )
    provider = LLMProvider.objects.get(id=provider_data["provider_id"])
    model = LLMModel.objects.get(id=model_data["model_id"])
    if provider.encrypted_api_key == FAKE_LLM_KEY or provider.api_key != FAKE_LLM_KEY:
        raise AssertionError("BYOK credential encryption/decryption contract failed")
    if LLMSceneBinding.objects.count() != 0:
        raise AssertionError("BYOK configuration created a SceneBinding")

    scene = SCENES["_main_chat"]
    execution = resolve_scene_execution(
        scene_key=scene.scene_key,
        payer=resolve_runtime_scene_payer(scene.scene_key),
        selected_model_id=str(model.id),
        organization_id=str(organization.id),
        user_id=str(organization.owner_id),
        capability_domain=scene.capability_domain,
        capability_requirements=scene.capability_requirements,
    )
    if str(execution.model_id) != str(model.id):
        raise AssertionError("_main_chat did not resolve the selected BYOK model")
    return {
        "provider_id": str(provider.id),
        "model_id": str(model.id),
        "model_name": model.model_name,
        "provider_scope": provider.scope,
        "credential_encrypted": "yes",
    }


def _prepare_runtime(
    http: Any,
    *,
    token: str,
    organization: Any,
    agent: Any,
    model_id: str,
    suffix: str,
) -> dict[str, str]:
    headers = {"authorization": f"Bearer {token}"}
    fingerprint = f"community-electron-{suffix}"
    register_payload = {
        "organization_id": str(organization.id),
        "fingerprint": fingerprint,
        "device_type": "electron",
        "name": "Community Electron",
        "capabilities": ["terminal_execute", "terminal_read", "file", "browser"],
    }
    first = _data(
        http.post("/api/context/devices/register", headers=headers, json=register_payload)
    )
    second = _data(
        http.post("/api/context/devices/register", headers=headers, json=register_payload)
    )
    if first["id"] != second["id"]:
        raise AssertionError("Device registration is not idempotent")
    heartbeat = _data(
        http.post(
            "/api/context/devices/heartbeat",
            headers=headers,
            json={
                "fingerprint": fingerprint,
                "capabilities": register_payload["capabilities"],
                "system_info": {"home_dir": "/tmp/tabtin-community"},
            },
        )
    )
    if heartbeat["status"] != "online":
        raise AssertionError("Device heartbeat did not become online")
    workspace_payload = {
        "organization_id": str(organization.id),
        "device_id": first["id"],
        "working_dir": "/tmp/tabtin-community/workspace",
        "working_dir_type": "mixed",
        "name": "Community Home",
    }
    workspace = _data(
        http.post(
            "/api/context/workspaces/ensure-home",
            headers=headers,
            json=workspace_payload,
        )
    )
    workspace_again = _data(
        http.post(
            "/api/context/workspaces/ensure-home",
            headers=headers,
            json=workspace_payload,
        )
    )
    if workspace["id"] != workspace_again["id"]:
        raise AssertionError("Workspace ensure-home is not idempotent")

    session_id = str(uuid4())
    session = _data(
        http.post(
            "/api/chat/sessions",
            headers=headers,
            json={
                "session_id": session_id,
                "agent_id": str(agent.id),
                "workspace_id": workspace["id"],
                "organization_id": str(organization.id),
                "model_id": model_id,
            },
        )
    )
    return {
        "device_id": str(first["id"]),
        "fingerprint": fingerprint,
        "workspace_id": str(workspace["id"]),
        "workspace_root": str(workspace["working_dir"]),
        "session_id": str(session["id"]),
    }


async def _chat_roundtrip(
    *,
    token: str,
    organization_id: str,
    agent_id: str,
    model: dict[str, str],
    runtime: dict[str, str],
) -> dict[str, Any]:
    import httpx
    import websockets
    from apps.services.common.agent_protocol.namespace import device_action_topic

    headers = {"authorization": f"Bearer {token}"}
    user_message_id = str(uuid4())
    assistant_message_id = str(uuid4())
    thread_id = f"chat-session-{runtime['session_id']}"

    async with httpx.AsyncClient(base_url=HTTP_BASE, timeout=20) as http:
        async with websockets.connect(WS_URL, open_timeout=10) as websocket:
            await websocket.send(
                json.dumps(
                    _envelope(
                        "auth",
                        fingerprint=runtime["fingerprint"],
                        organization_id=organization_id,
                        payload={
                            "access_token": token,
                            "organization_id": organization_id,
                            "client_type": "electron",
                            "capabilities": ["context.sync", "agent.stream", "agent.action"],
                            "device": {"name": "Community Electron"},
                        },
                    )
                )
            )
            await _receive(websocket, lambda item: item.get("type") == "auth.ok", "auth.ok")
            await websocket.send(
                json.dumps(
                    _envelope(
                        "subscribe",
                        fingerprint=runtime["fingerprint"],
                        payload={
                            "topics": [device_action_topic(runtime["fingerprint"])]
                        },
                    )
                )
            )
            await _receive(
                websocket,
                lambda item: item.get("type") == "subscribe.ok",
                "subscribe.ok",
            )

            request_id = f"community-chat-{uuid4().hex}"
            await websocket.send(
                json.dumps(
                    _envelope(
                        "chat.send_message",
                        fingerprint=runtime["fingerprint"],
                        organization_id=organization_id,
                        thread_id=thread_id,
                        request_id=request_id,
                        payload={
                            "session_id": runtime["session_id"],
                            "message": "Community golden path prompt",
                            "client_event_id": user_message_id,
                            "agent_id": agent_id,
                        },
                    )
                )
            )
            ack = await _receive(
                websocket,
                lambda item: item.get("type") == "chat.send_message.ok"
                and item.get("request_id") == request_id,
                "chat.send_message.ok",
            )
            prompt = await _receive(
                websocket,
                lambda item: item.get("type") == "agent.prompt.forward"
                and item.get("payload", {}).get("client_message_id") == user_message_id,
                "agent.prompt.forward",
            )
            prompt_payload = prompt["payload"]
            if str(prompt_payload.get("model_id")) != model["model_id"]:
                raise AssertionError("prompt.forward selected the wrong BYOK model")

            await websocket.send(
                json.dumps(
                    _envelope(
                        "agent.prompt.admitted",
                        fingerprint=runtime["fingerprint"],
                        organization_id=organization_id,
                        thread_id=thread_id,
                        payload={
                            "buffered_event_id": prompt["event_id"],
                            "run_id": prompt_payload["run_id"],
                        },
                    )
                )
            )
            await _receive(
                websocket,
                lambda item: item.get("type") == "agent.prompt.admitted.ok",
                "agent.prompt.admitted.ok",
            )

            llm_response = _data(
                await http.post(
                    "/api/services/llm/chat",
                    headers=headers,
                    json={
                        "model": model["model_name"],
                        "messages": [
                            {"role": "user", "content": "Community golden path prompt"}
                        ],
                        "organization_id": organization_id,
                        "stream": False,
                    },
                )
            )
            response_text = str(llm_response["content"])
            if response_text != "community golden path response":
                raise AssertionError("fake LLM response did not traverse the BYOK API")

            relay_id = f"community-relay-{uuid4().hex}"
            await websocket.send(
                json.dumps(
                    _envelope(
                        "relay_events",
                        fingerprint=runtime["fingerprint"],
                        organization_id=organization_id,
                        thread_id=thread_id,
                        request_id=relay_id,
                        payload={
                            "session_id": runtime["session_id"],
                            "events": [
                                {
                                    "type": "agent.stream.persist_message",
                                    "payload": {
                                        "message_id": assistant_message_id,
                                        "client_event_id": assistant_message_id,
                                        "source_client_event_id": user_message_id,
                                        "run_id": prompt_payload["run_id"],
                                        "agent_run_id": prompt_payload["run_id"],
                                        "agent_id": agent_id,
                                        "role": "assistant",
                                        "message_kind": "llm",
                                        "model_id": model["model_id"],
                                        "model_name": model["model_name"],
                                        "stop_reason": "end_turn",
                                        "blocks_json": [
                                            {"type": "text", "text": response_text}
                                        ],
                                    },
                                }
                            ],
                        },
                    )
                )
            )
            relay = await _receive(
                websocket,
                lambda item: item.get("type") == "relay_events.ok"
                and item.get("request_id") == relay_id,
                "relay_events.ok",
            )
            if relay.get("payload", {}).get("relayed") != 1:
                raise AssertionError("canonical assistant result was not relayed")

        history = _data(
            await http.get(
                f"/api/chat/sessions/{runtime['session_id']}/messages?limit=50",
                headers=headers,
            )
        )
        rows = [row for row in history["messages"] if row.get("id") == assistant_message_id]
        if len(rows) != 1 or rows[0].get("text_summary") != response_text:
            raise AssertionError("assistant result was not recoverable from chat history")
        return {
            "delivery": ack.get("payload", {}).get("delivery"),
            "prompt_forwarded": True,
            "fake_llm_response": response_text,
            "assistant_message_id": assistant_message_id,
            "canonical_result": "persisted-and-readable",
        }


def _funding_snapshot(organization_id: str) -> dict[str, Any]:
    from apps.services.billing.models import (
        ProviderCreditGrant,
        ProviderCreditTransaction,
    )
    from apps.services.llm.models import LLMProvider
    from apps.services.payment.models import PaymentOrder
    from apps.users.wallet.models import OrganizationWallet, WalletTransaction

    wallet = OrganizationWallet.objects.filter(
        organization_id=organization_id
    ).first()
    grants = ProviderCreditGrant.objects.filter(organization_id=organization_id)
    return {
        "wallet_exists": wallet is not None,
        "wallet_balance": str(wallet.credits_precise) if wallet else None,
        "wallet_frozen": str(wallet.credits_frozen_precise) if wallet else None,
        "wallet_transactions": WalletTransaction.objects.filter(
            organization_id=organization_id
        ).count(),
        "wallet_consumptions": WalletTransaction.objects.filter(
            organization_id=organization_id,
            transaction_type="consume",
        ).count(),
        "provider_credit_grants": grants.count(),
        "provider_credit_consumed": str(
            sum(grants.values_list("consumed_credits", flat=True), Decimal("0"))
        ),
        "provider_credit_reserved": str(
            sum(
                grants.values_list("active_reserved_credits", flat=True),
                Decimal("0"),
            )
        ),
        "provider_credit_consumptions": ProviderCreditTransaction.objects.filter(
            organization_id=organization_id,
            transaction_type=ProviderCreditTransaction.TransactionType.CONSUME,
        ).count(),
        "payment_orders": PaymentOrder.objects.filter(
            organization_id=organization_id
        ).count(),
        "official_providers": LLMProvider.objects.filter(scope="global").count(),
    }


def _fake_llm_hits(httpx_module: Any) -> list[dict[str, Any]]:
    root = FAKE_LLM_BASE_URL.removesuffix("/v1")
    response = httpx_module.get(f"{root}/hits", timeout=5)
    response.raise_for_status()
    return list(response.json().get("hits") or [])


def run_probe() -> None:
    _setup_django()
    import httpx

    suffix = uuid4().hex[:16]
    with httpx.Client(base_url=HTTP_BASE, timeout=20) as http:
        ready = http.get("/health/ready")
        if ready.status_code != 200:
            raise AssertionError("backend is not ready before AI configuration")
        fresh_ai = _assert_fresh_ai_state()
        identity = _register_login_onboard(http, suffix)
        organization = identity["organization"]
        token = identity["token"]
        model = _configure_byok(http, token=token, organization=organization)
        runtime = _prepare_runtime(
            http,
            token=token,
            organization=organization,
            agent=identity["agent"],
            model_id=model["model_id"],
            suffix=suffix,
        )
        funding_before = _funding_snapshot(str(organization.id))
        fake_hits_before = _fake_llm_hits(httpx)

    chat = asyncio.run(
        _chat_roundtrip(
            token=token,
            organization_id=str(organization.id),
            agent_id=str(identity["agent"].id),
            model=model,
            runtime=runtime,
        )
    )
    funding_after = _funding_snapshot(str(organization.id))
    if funding_after != funding_before:
        raise AssertionError(
            "Community BYOK chat changed TabTin funding state: "
            f"before={funding_before} after={funding_after}"
        )
    fake_hits_after = _fake_llm_hits(httpx)
    new_fake_hits = fake_hits_after[len(fake_hits_before):]
    if new_fake_hits != [
        {
            "path": "/v1/chat/completions",
            "model": FAKE_LLM_MODEL,
            "authorization_present": True,
        }
    ]:
        raise AssertionError(
            f"BYOK chat did not make exactly one expected provider call: {new_fake_hits}"
        )
    if model["provider_scope"] != "organization" or funding_after["official_providers"]:
        raise AssertionError("Community chat used an official provider fallback")
    print(
        json.dumps(
            {
                "status": "PASS",
                "backend_ready_without_ai": True,
                "fresh_ai": fresh_ai,
                "register": {"user_id": str(identity["user"].id), "email": identity["email"]},
                "login": "PASS",
                "organization_id": str(organization.id),
                "agent_id": str(identity["agent"].id),
                "byok": model,
                "runtime": runtime,
                "chat": chat,
                "funding_before": funding_before,
                "funding_after": funding_after,
                "funding_delta": "unchanged",
                "official_provider_invocations": 0,
                "fake_llm_new_hits": new_fake_hits,
            },
            sort_keys=True,
        )
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("fake-llm", "probe"))
    mode = parser.parse_args(argv).mode
    if mode == "fake-llm":
        run_fake_llm()
    else:
        run_probe()


if __name__ == "__main__":
    main(sys.argv[1:])
