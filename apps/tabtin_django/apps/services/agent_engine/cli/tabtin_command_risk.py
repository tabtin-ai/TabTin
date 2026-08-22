"""tabtin 命令风险表查询（ — Go ``CommandDef.Risk`` 为 SSoT）。

数据源：``tabtin_command_risk.generated.json``，由
``scripts/gen-tabtin-cli-risk.mjs`` 从 ``tabtin commands --format json``
生成（词表已归一化为 Django 三档 safe/review/strict），生成物入库。

职责边界：
- 只服务 ``binary == "tabtin"`` 的命令——marketplace App 独立 binary /
  未知 binary 仍走 ``cli_rules.yaml`` 模式匹配与 parser 的 fail-safe 路径。
- 表加载失败 / 命令未登记时返回 ``None``，由调用方 fallback 到 yaml 规则
  （行为与接入前一致，非降级）。

匹配语义：**最长前缀匹配 + 组前缀护栏**。Go 命令路径可为 1–3 段（如
``about`` / ``doc list`` / ``agent db info``），argv 里命令段后面跟着
flags / 位置参数——从非 flag 前缀 tokens 由长到短找已登记路径。

护栏（fail-safe）：命中的前缀若同时是"命令组"（表里存在以它开头的更长
命令）且 argv 里紧跟着还有非 flag 段，说明用户调用的是该组下**未登记的
子命令**（如 ``tabtin table create_in_prod``）——不能拿父命令的档冒充，
返回 ``None`` 让 yaml 规则兜底。代价是「叶子命令 + 位置参数」在该叶子
同时为组前缀时也会回退 yaml（偏严格，方向安全）。
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from apps.services.agent_engine.cli.spec import RISK_LEVELS

logger = logging.getLogger(__name__)

_GENERATED_PATH = Path(__file__).parent / "tabtin_command_risk.generated.json"

# Go 命令路径最深 3 段（`tabtin agent db info`）；留 1 段余量防未来加深后静默截断。
_MAX_PATH_SEGMENTS = 4

_cache_lock = threading.Lock()
_cached_table: Optional[Dict[str, str]] = None
_cached_group_prefixes: Optional[frozenset] = None
_cache_loaded = False


def _build_group_prefixes(commands: Dict[str, str]) -> frozenset:
    """所有命令路径的真前缀集合（用于识别"命令组"）。"""
    prefixes = set()
    for path in commands:
        parts = path.split(" ")
        for i in range(1, len(parts)):
            prefixes.add(" ".join(parts[:i]))
    return frozenset(prefixes)


def _load_table() -> Optional[Dict[str, str]]:
    """加载生成表（进程内缓存一次；失败缓存 None 走 yaml fallback）。"""
    global _cached_table, _cached_group_prefixes, _cache_loaded
    if _cache_loaded:
        return _cached_table
    with _cache_lock:
        if _cache_loaded:
            return _cached_table
        table: Optional[Dict[str, str]] = None
        try:
            with _GENERATED_PATH.open("r", encoding="utf-8") as fp:
                data = json.load(fp)
            commands = data.get("commands")
            if not isinstance(commands, dict) or not commands:
                raise ValueError("generated table missing non-empty 'commands' mapping")
            invalid = {
                path: risk
                for path, risk in commands.items()
                if not isinstance(risk, str) or risk not in RISK_LEVELS
            }
            if invalid:
                raise ValueError(f"generated table contains invalid risk values: {invalid}")
            table = dict(commands)
        except FileNotFoundError:
            logger.error(
                "[cli.tabtin_command_risk] 生成表缺失（%s）——tabtin 命令回退 cli_rules.yaml。"
                "复跑 `node scripts/gen-tabtin-cli-risk.mjs` 生成。",
                _GENERATED_PATH,
            )
        except Exception as exc:
            logger.error(
                "[cli.tabtin_command_risk] 生成表加载失败（%s: %s）——tabtin 命令回退 cli_rules.yaml",
                type(exc).__name__,
                exc,
            )
        _cached_table = table
        _cached_group_prefixes = (
            _build_group_prefixes(table) if table is not None else None
        )
        _cache_loaded = True
        return _cached_table


def reset_cache_for_tests() -> None:
    """测试专用：清空进程缓存以便替换生成表路径/内容后重新加载。"""
    global _cached_table, _cached_group_prefixes, _cache_loaded
    with _cache_lock:
        _cached_table = None
        _cached_group_prefixes = None
        _cache_loaded = False


def lookup_tabtin_command_risk(
    rest_tokens: Sequence[str],
) -> Optional[Tuple[str, str]]:
    """按最长前缀匹配查 tabtin 命令的风险档（含组前缀护栏，见模块 docstring）。

    :param rest_tokens: ``tabtin`` 之后的 argv tokens（含 flags/参数）。
    :return: ``(risk_level, command_path)``；表不可用、未登记或命中组前缀
        护栏时 ``None``（调用方 fallback 到 yaml 规则）。
    """
    table = _load_table()
    if table is None:
        return None
    group_prefixes = _cached_group_prefixes or frozenset()

    segments: List[str] = []
    for token in rest_tokens:
        if token.startswith("-"):
            break
        segments.append(token)
        if len(segments) >= _MAX_PATH_SEGMENTS:
            break
    if not segments:
        return None

    for length in range(len(segments), 0, -1):
        path = " ".join(segments[:length])
        risk = table.get(path)
        if risk is None:
            continue
        # 组前缀护栏：命中的路径同时是命令组，且 argv 里还有未消费的非 flag
        # 段——大概率是该组下未登记的子命令，拒绝用父命令档冒充。
        if length < len(segments) and path in group_prefixes:
            return None
        return risk, path
    return None


__all__ = [
    "lookup_tabtin_command_risk",
    "reset_cache_for_tests",
]
