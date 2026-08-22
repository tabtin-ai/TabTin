"""tool_result ↔ assistant ChatMessage 合并/终态 supersede 的纯逻辑（无 channels）。

从 ``apps/services/common/ws/handlers/relay_message_writer.py`` 抽出——这几个函数只依赖
``json`` / ``django.db.transaction`` / ``logging``，**不碰 channels / ws handlers**。抽到中立
模块后：
  - **写路径**（relay_message_writer，在 ws.handlers 包内）import 它；
  - **读路径**（``apps/chat/conversation/api/message.py`` 的 ``_heal_missing_tool_results``）
    也 import 它做读时自愈 supersede——**不必再经 ws.handlers 包级 __init__ 把整条
    channels + 全套 gateway handler 依赖拉进历史读取路径**。

两端共享同一份「幂等合并 + 终态 `_terminal_update` 原地替换 + PTY session_id 防跨 run
串台」逻辑，单一真相源。

t1（终端"假运行"根治）背景：后台命令前台超时返回 `status:"running"` 快照作 tool_result
合并进 assistant；命令终结（完成/被 kill/hard_timeout/app_exit）时 host emit 一条带
`_terminal_update` 的终态 tool_result，期望**替换** running 快照，让重载时终端卡片显示真
实终态而非永远转圈。详见 packages/agent-runtime/src/engine/background-task-terminal-result.ts。
"""
from __future__ import annotations

import logging
from typing import Any

from django.db import transaction

logger = logging.getLogger(__name__)


def _is_terminal_tool_result_update(tr_block: dict[str, Any]) -> bool:
    """tool_result 是否为后台命令"终态更新"（content JSON 含 `_terminal_update: true`）。

    后台命令前台超时返回 `status:"running"` 快照后，命令终结（完成 / 被 kill /
    hard_timeout）时 host emit 一条带 `_terminal_update` 标记的终态 tool_result——
    merge 据此**替换** running 快照而非幂等跳过，让重载时终端卡片显示真实终态。
    详见 packages/agent-runtime/src/engine/background-task-terminal-result.ts。

    `content` 是 JSON 字符串：先做廉价子串预判（绝大多数 tool_result 不含此标记，
    直接短路不 parse），命中再 json.loads 确认布尔值，避免对每条 tool_result 都解 JSON。
    """
    content = tr_block.get('content')
    if not isinstance(content, str) or '_terminal_update' not in content:
        return False
    try:
        import json
        data = json.loads(content)
        return isinstance(data, dict) and data.get('_terminal_update') is True
    except Exception:
        return False


def _extract_terminal_session_id(block: dict[str, Any]) -> str | None:
    """从终端 tool_result block 的 content（JSON 字符串）提取 agent session_id。

    running 快照与终态 content 都带 `session_id`（= PTY agent session，**全局唯一**）。
    终态 supersede 用它精确匹配要覆盖的 running 快照——防 tool_use_id 跨 run 重用
    （`run_terminal_command:0` 在多段对话各出一次）导致终态盖到错误 run 的终端卡片
    （串台）。content 非 JSON / 缺字段时返回 None（不参与匹配，调用方据此跳过）。
    """
    if not isinstance(block, dict):
        return None
    content = block.get('content')
    if not isinstance(content, str) or 'session_id' not in content:
        return None
    try:
        import json
        data = json.loads(content)
        if not isinstance(data, dict):
            return None
        sid = data.get('session_id')
        return sid if isinstance(sid, str) and sid else None
    except Exception:
        return None


def _merge_tool_result_block_into_message(
    *,
    matched: Any,
    tr_block: dict[str, Any],
    tool_use_id: str,
    session_id: str,
) -> bool:
    """把单个 tool_result block 合并进 matched.content_blocks_json。

    Returns:
        True  —— 该 tool_result **现确定在 message 内**（幂等命中 / 新 append /
                 终态覆盖成功）；
        False —— 未能确定落入 message（save 失败已回滚内存 / 防串台拒绝 / 终态无对应
                 running 快照可覆盖）——caller 应**保留 pending** 待下次重试。

    返回语义是"操作后该结果是否确定在 message 内"——drain/heal 据此决定是否删
    pending：True 才删（避免 save 失败时误删 pending 造成既没合并又丢暂存）。

    **幂等 vs 终态覆盖**（t1 后台命令"假运行"根治）：
      - 已存在同 tool_use_id 的 tool_result + 新块**非**终态更新 → 幂等跳过
        （daemon retry / WS replay / 双 drain 撞同一 tool_use_id 不产生重复 block）；
      - 已存在 + 新块**是**终态更新（content 含 `_terminal_update`）→ **原地替换**
        原块（后台命令终结覆盖 `status:"running"` 快照，保持 block 顺序），让重载
        时终端卡片显示真实终态而非永远"运行中"；
      - 不存在 + 新块**是**终态更新 → **拒绝首次 append**（返回 False、保留 pending）。
        终态语义上是「替换某条 running 快照」；没有对应 running 块时首次 append 会
        **绕过 session_id 防串台**（无已存在块可比对 PTY session_id），跨 run 重用
        同 `run_terminal_command:N` 时可能把 A 命令的终态贴到 B 命令的卡片上。改为
        保留 pending，等对应 running 快照落库后再走 supersede（带 session 护栏）；
        正常流里 running 快照（前台超时返回）必先于终态产生，故等得到。
      - 不存在 + 新块**非**终态 → append（首次合并，普通 tool_result 正常路径）。
    """
    existing_blocks = matched.content_blocks_json or []
    is_terminal_update = _is_terminal_tool_result_update(tr_block)
    existing_idx = next(
        (
            i for i, b in enumerate(existing_blocks)
            if isinstance(b, dict)
            and b.get('type') == 'tool_result'
            and b.get('tool_use_id') == tool_use_id
        ),
        None,
    )

    if existing_idx is not None and not is_terminal_update:
        # 普通重发去重——已在 message 内，幂等跳过。
        logger.debug(
            "[Reassembler] tool_result 已在 ChatMessage 内（幂等跳过）: msg=%s tool_use_id=%s",
            matched.id, tool_use_id,
        )
        return True

    if existing_idx is None and is_terminal_update:
        # 终态但无对应 running 块可覆盖——拒绝首次 append（防无 session 护栏的跨 run
        # 串台），保留 pending 等 running 落库后走 supersede。
        logger.info(
            "[Reassembler] 终态无对应 running 快照可覆盖，保留 pending 待 running 落库后 supersede: "
            "msg=%s tool_use_id=%s",
            matched.id, tool_use_id,
        )
        return False

    if existing_idx is not None:
        # 终态更新覆盖已有（running）快照。
        existing_block = existing_blocks[existing_idx]
        # H2 兜底：session_id 校验——drain/heal 路径没有外层 session_id 精确匹配，
        # 这里防"跨 run 重用同 tool_use_id"把终态盖到别条命令的 running 快照（串台）。
        # 返回 False 让 caller 保留 pending，等正确 message（merge 主路径外层已精确
        # 匹配，此处恒等过；仅 drain/heal 可能触发）。
        new_sid = _extract_terminal_session_id(tr_block)
        existing_sid = _extract_terminal_session_id(existing_block)
        if new_sid and existing_sid and new_sid != existing_sid:
            logger.warning(
                "[Reassembler] 终态 session_id 不匹配，跳过覆盖（防串台）: "
                "msg=%s tool_use_id=%s new_sid=%s existing_sid=%s",
                matched.id, tool_use_id, new_sid, existing_sid,
            )
            return False
        # P2-3：内容完全一致（relay 重放）→ 幂等跳过，避免写放大 + 误导日志。
        if existing_block == tr_block:
            return True
        # 原地替换保持 block 顺序。
        new_blocks = list(existing_blocks)
        new_blocks[existing_idx] = tr_block
    else:
        # 首次合并——append（普通非终态 tool_result）。
        new_blocks = [*existing_blocks, tr_block]

    matched.content_blocks_json = new_blocks
    try:
        with transaction.atomic():
            matched.save(update_fields=['content_blocks_json', 'updated_at'])
        if existing_idx is not None:
            logger.info(
                "[Reassembler] tool_result 终态覆盖 running 快照: msg=%s tool_use_id=%s",
                matched.id, tool_use_id,
            )
        else:
            logger.debug(
                "[Reassembler] tool_result 合并入 ChatMessage: msg=%s tool_use_id=%s",
                matched.id, tool_use_id,
            )
        return True
    except Exception:
        # 回滚内存对象，避免"DB 没存但内存已改"的脏状态污染后续逻辑；
        # 返回 False 让 caller 保留 pending，等下次 drain / 读时自愈重试。
        matched.content_blocks_json = existing_blocks
        logger.error(
            "[Reassembler] tool_result 合并失败（保留 pending 待重试）: session=%s msg=%s tool_use_id=%s",
            session_id, matched.id, tool_use_id, exc_info=True,
        )
        return False
