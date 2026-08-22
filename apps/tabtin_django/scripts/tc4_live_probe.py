"""TC-4 live 探针：查 Centrifugo personal 频道实际收到的 im.unread.update payload。

用途
----
验证「红点增加但桌面通知不弹」时，live 进程（daphne / celery worker）真正推到
personal:{userId} 频道的 unread.update 是否携带 TC-4 所需的 preview/sender 字段。
这是区分「后端 payload 缺字段」vs「前端/系统通知权限」的决定性证据。

跑法
----
cd apps/tabtin_django && venv/bin/python scripts/tc4_live_probe.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
_DIR = Path(__file__).resolve().parent.parent
if str(_DIR) not in sys.path:
    sys.path.insert(0, str(_DIR))

import django

django.setup()

from django.conf import settings
from apps.tabchat.models import Message, ConversationMember
from apps.services.jinbao.constants import JINBAO_USER_ID


def history(channel: str, limit: int = 30) -> list[dict]:
    api_url = getattr(settings, "CENTRIFUGO_API_URL", "http://127.0.0.1:8100/api")
    api_key = getattr(settings, "CENTRIFUGO_API_KEY", "")
    body = json.dumps({"channel": channel, "limit": limit}).encode("utf-8")
    req = urllib.request.Request(
        f"{api_url}/history",
        data=body,
        headers={"Content-Type": "application/json", "X-API-Key": api_key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("error"):
        print(f"  history error for {channel}: {payload['error']}")
        return []
    return payload.get("result", {}).get("publications", [])


def main() -> int:
    print("CENTRIFUGO_API_URL =", getattr(settings, "CENTRIFUGO_API_URL", "(default)"))
    recent = Message.objects.order_by("-id").first()
    if not recent:
        print("DB 无任何 message")
        return 2
    print(f"最近 message id={recent.id} conv={recent.conversation_id} sender={recent.sender_id}")

    conv_id = recent.conversation_id
    members = list(
        ConversationMember.objects.filter(conversation_id=conv_id)
        .values_list("user_id", flat=True)
    )
    humans = [m for m in members if str(m) != JINBAO_USER_ID]
    print(f"会话成员={members}")
    print(f"真人成员={humans}")

    for h in humans:
        ch = f"personal:{h}"
        pubs = history(ch)
        unread = [p for p in pubs if p.get("data", {}).get("type") == "im.unread.update"]
        print(f"\n{ch}: 共 {len(pubs)} 条 pub，其中 unread.update {len(unread)} 条")
        for p in unread[-5:]:
            d = p.get("data", {}).get("data", {})
            has_preview = "preview" in d
            print(f"  unread.update keys={sorted(d.keys())} has_preview={has_preview}")
            print(f"    data={json.dumps(d, ensure_ascii=False)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
