"""GitHub OAuth Device Flow 认证。

实际 OAuth 流程：
1. POST https://github.com/login/device/code 获取 device_code + user_code + verification_uri
2. 用户在浏览器打开 verification_uri 并输入 user_code
3. 轮询 POST https://github.com/login/oauth/access_token 直到获得 access_token

环境变量：
- GITHUB_CLIENT_ID: GitHub OAuth App 的 client_id（必须）
- GITHUB_DEMO_BASE_URL: mock server base URL（仅 --mocked 模式）
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .config import get_access_token, save_config


GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
DEFAULT_SCOPE = "repo"


def _post_form(url: str, data: Dict[str, str]) -> Dict[str, Any]:
    encoded = "&".join(f"{k}={v}" for k, v in data.items())
    req = Request(
        url,
        data=encoded.encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    with urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def run_device_flow(
    client_id: str,
    *,
    scope: str = DEFAULT_SCOPE,
    device_code_url: str = GITHUB_DEVICE_CODE_URL,
    token_url: str = GITHUB_TOKEN_URL,
) -> Optional[Dict[str, Any]]:
    """执行 GitHub Device Flow；成功时返回 token 响应 dict，失败返回 None。"""
    resp = _post_form(device_code_url, {
        "client_id": client_id,
        "scope": scope,
    })

    device_code = resp.get("device_code", "")
    user_code = resp.get("user_code", "")
    verification_uri = resp.get("verification_uri", "https://github.com/login/device")
    interval = int(resp.get("interval", 5))
    expires_in = int(resp.get("expires_in", 900))

    print(f"\n{'='*60}")
    print(f"  请在浏览器中打开: {verification_uri}")
    print(f"  输入验证码:       {user_code}")
    print(f"{'='*60}\n")
    print(f"等待授权... (超时 {expires_in} 秒)")

    deadline = time.time() + expires_in
    while time.time() < deadline:
        time.sleep(interval)
        try:
            token_resp = _post_form(token_url, {
                "client_id": client_id,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            })
        except HTTPError:
            continue

        error = token_resp.get("error")
        if error == "authorization_pending":
            continue
        if error == "slow_down":
            interval = int(token_resp.get("interval", interval + 5))
            continue
        if error == "expired_token":
            print("ERROR: 授权超时，请重试", file=sys.stderr)
            return None
        if error == "access_denied":
            print("ERROR: 用户拒绝授权", file=sys.stderr)
            return None
        if error:
            print(f"ERROR: OAuth 错误: {error}", file=sys.stderr)
            return None

        access_token = token_resp.get("access_token")
        if access_token:
            return token_resp

    print("ERROR: 等待超时", file=sys.stderr)
    return None


def login(*, mocked: bool = False) -> int:
    """执行 OAuth 登录流程。返回 exit code。"""
    if mocked:
        save_config({
            "access_token": "example-github-token",
            "token_type": "bearer",
            "scope": DEFAULT_SCOPE,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "mocked": True,
        })
        print("✓ Mock 模式：已写入模拟 token 到 ~/.tabtin-demo-app/config.json")
        return 0

    client_id = os.environ.get("GITHUB_CLIENT_ID", "")
    if not client_id:
        print(
            "ERROR: 未设置 GITHUB_CLIENT_ID 环境变量\n"
            "请先注册 GitHub OAuth App 并设置 GITHUB_CLIENT_ID\n"
            "或使用 --mocked 模式运行",
            file=sys.stderr,
        )
        return 1

    token_resp = run_device_flow(client_id)
    if not token_resp:
        return 1

    save_config({
        "access_token": token_resp["access_token"],
        "token_type": token_resp.get("token_type", "bearer"),
        "scope": token_resp.get("scope", DEFAULT_SCOPE),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    print("✓ 认证成功！Token 已保存到 ~/.tabtin-demo-app/config.json")
    return 0


def show_status() -> int:
    """显示当前认证状态。返回 exit code。"""
    token = get_access_token()
    if not token:
        print("未认证。请运行: tabtin-demo-app auth login")
        return 1
    masked = token[:8] + "..." + token[-4:] if len(token) > 12 else "***"
    print(f"已认证 (token: {masked})")
    return 0
