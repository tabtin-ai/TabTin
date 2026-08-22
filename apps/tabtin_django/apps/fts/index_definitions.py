"""6 个索引的 mapping + 模板 + Helper（PRD 3.8 / 4.4 / 4.5，ADR-06 / 08）。

设计要点：
    - 分析器分离（ADR-06）：
        - `tabtin_text_index`：`icu_folding` + `lowercase` +
          `cjk_bigram_with_unigrams`（保留单字，兜底召回）
        - `tabtin_text_query`：`icu_folding` + `lowercase` +
          `cjk_bigram_only`（不出单字，杜绝"性能"误召"性/能"的噪音）
    - `tabtin-messages` 按月 rollover（ADR-08）：index template +
      月度索引 + alias 聚合；其他索引单索引 + 2 分片。
    - ES 8.x 不再支持 mapping-level `boost`（8.0 起移除），所有
      字段加权逻辑由 Wave 2 在查询层（multi_match 的 `field^boost`）
      承担；这里只声明字段类型与分析器。

Helper：
    - `ensure_indices(client)`：幂等创建全部索引（含 template + 当月消息索引）。
    - `ensure_monthly_index(client, base_name, dt)`：为消息 rollover 按月
      派生索引名并创建（若不存在）。

索引前缀：所有对外名字通过 `_index_name()` 拼接 `settings.SEARCH_INDEX_PREFIX`
（默认 `tabtin`），允许多租户/多环境隔离（例如 CI 用 `SEARCH_INDEX_PREFIX=tabtin-ci`）。
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from django.conf import settings

__all__ = [
    "ANALYZER_INDEX",
    "ANALYZER_QUERY",
    "INDEX_SETTINGS",
    "INDEX_DEFINITIONS",
    "get_index_name",
    "get_messages_alias",
    "get_messages_template_name",
    "ensure_indices",
    "ensure_monthly_index",
    "iter_index_names",
]

logger = logging.getLogger(__name__)

# ── 分析器 / 基础 settings ──────────────────────────────────────
ANALYZER_INDEX = "tabtin_text_index"
ANALYZER_QUERY = "tabtin_text_query"

# 通用索引级 settings（2 分片 + 1 副本 + 分析器定义）
# 字段 mapping 引用 `analyzer` / `search_analyzer` 分别对应两个分析器。
INDEX_SETTINGS: dict[str, Any] = {
    "number_of_shards": 2,
    "number_of_replicas": 1,
    "analysis": {
        "analyzer": {
            ANALYZER_INDEX: {
                "type": "custom",
                "tokenizer": "icu_tokenizer",
                "filter": [
                    "icu_folding",
                    "lowercase",
                    "cjk_bigram_with_unigrams",
                ],
            },
            ANALYZER_QUERY: {
                "type": "custom",
                "tokenizer": "icu_tokenizer",
                "filter": [
                    "icu_folding",
                    "lowercase",
                    "cjk_bigram_only",
                ],
            },
        },
        "filter": {
            # 索引时：保留单字（便于单字兜底召回）
            "cjk_bigram_with_unigrams": {
                "type": "cjk_bigram",
                "output_unigrams": True,
            },
            # 查询时：只出双字（避免"性能"命中"性/能"单字）
            "cjk_bigram_only": {
                "type": "cjk_bigram",
                "output_unigrams": False,
            },
        },
    },
}


# ── Helper：字段工厂 ────────────────────────────────────────────
# 字段定义必须用**工厂函数**，避免共享同一 dict 实例被下游原地修改后
# 污染全部 mapping（Wave 1+ 的 `update mapping` 脚本若就地改动，会让
# 其他索引同名字段一起动）。
def _text(multi_keyword: bool = False) -> dict[str, Any]:
    """标准 text 字段：索引/查询双分析器分离。

    `multi_keyword=True` 时附加 `.keyword` 子字段（Elasticsearch 标准
    multi-field），方便精确匹配 / 聚合（resources.title 代码标识符场景、
    spaces.name 聚合等）。
    """
    field: dict[str, Any] = {
        "type": "text",
        "analyzer": ANALYZER_INDEX,
        "search_analyzer": ANALYZER_QUERY,
    }
    if multi_keyword:
        field["fields"] = {"keyword": {"type": "keyword", "ignore_above": 256}}
    return field


def _keyword() -> dict[str, Any]:
    return {"type": "keyword"}


def _date() -> dict[str, Any]:
    return {"type": "date"}


def _bool() -> dict[str, Any]:
    return {"type": "boolean"}


def _integer() -> dict[str, Any]:
    return {"type": "integer"}


# ── 6 个索引 mapping 定义 ──────────────────────────────────────
# 说明：
#   - 所有索引均包含 `organization_id`（租户隔离 filter，PRD 5.1）
#   - `creator_type`（user/agent，PRD 3.8.B，P0 要求）
#   - 易改字段（Space name/Agent name）不入索引，Hydration 时批查 PG
#     （PRD 4.4 ADR-07）

# 1) tabtin-messages：按月 rollover，PRD 4.4
#
# 字段来源映射（Wave 1 同步管道参考，模型字段参见
# `apps/chat/conversation/models.py`）：
#   message_id             ← ChatMessage.id
#   session_id             ← ChatMessage.session_id
#   session_title          ← ChatSession.title（易改字段——rename 后
#                            需触发 update_by_query；Wave 1 实现
#                            `ChatSession.save` 后钩）
#   session_status         ← ChatSession.status（active/archived）
#   session_revert_state_index ← ChatSession.revert_state_index
#                            （会话级 state 冗余快照，便于 hydrate；
#                            **不**作为回滚消息过滤主键，主键是
#                            `checkpoint_state_index`，见 ADR-16）
#   checkpoint_state_index ← ChatMessage.checkpoint_state_index
#                            （Wave 2 回滚消息过滤主键 ADR-16；assistant
#                            消息产 checkpoint 时的 ConversationState
#                            messages_json 长度，与 session.revert_state_index
#                            同一整数空间，可做范围过滤）
#   organization_id            ← ChatSession.organization_id / workspace.organization_id
#   space_id               ← ChatSession.workspace_id（：索引字段名仍为 space_id）
#   user_id                ← ChatMessage.sender_user_id；assistant 消
#                            息留空或填 session 所属用户（Wave 1 决定）
#   creator_type           ← role='user' → 'user'；role='assistant'
#                            → 'agent'；其他（system/tool）不索引
#   agent_id               ← ChatMessage.agent_id（实际执行者）；
#                            用户消息无执行者时保持空
#   role                   ← ChatMessage.role
#   content                ← ChatMessage.content（敏感数据过滤前置，
#                            PRD 5.5）
#   tool_call_summary      ← Wave 1 生成 summary，P0 可留空
#   tool_names             ← Wave 1 提取 tool_calls 的 name 列表
#   created_at             ← ChatMessage.created_at
#
# 注意：**Wave 1 QC 后字段变更**（2026-04-17）：
#   - 移除 `message_index_in_session`（ADR-16 死字段；Wave 2 用
#     `checkpoint_state_index` 做回滚过滤，无需 COUNT 查询）
#   - 新增 `checkpoint_state_index`（直接来自 ChatMessage 模型字段，
#     无需跨库查询，无需 COUNT）
# 字段移除后 mapping 不兼容已存在的索引（dynamic: strict）；本地需重建
# 当月索引：`curl -XDELETE http://localhost:9200/tabtin-messages-YYYY-MM`
# 然后重新 ensure_indices()。生产由 Wave 5 reindex 命令统一处理。
MESSAGES_MAPPING: dict[str, Any] = {
    "dynamic": "strict",
    "properties": {
        "message_id": _keyword(),
        "session_id": _keyword(),
        "organization_id": _keyword(),
        "space_id": _keyword(),
        "user_id": _keyword(),
        "creator_type": _keyword(),
        "agent_id": _keyword(),
        "role": _keyword(),
        "content": _text(),
        "session_title": _text(),
        "session_status": _keyword(),
        "session_revert_state_index": _integer(),
        # ADR-16：Wave 2 回滚消息过滤主键，与 session_revert_state_index
        # 同一整数空间（PG ConversationState.messages_json 的长度）
        "checkpoint_state_index": _integer(),
        # Wave 1+ 预留字段：tool_call_summary / tool_names（PRD 3.8.D）
        "tool_call_summary": _text(),
        "tool_names": _keyword(),
        "created_at": _date(),
    },
}

# 2) tabtin-resources：PRD 4.5，title 使用 multi-field keyword
#
# `preview.keyword` multi-field（PRD 4.5「代码标识符处理」原文）：
#     对 `tabtin-resources` 中 `item_type='tabcode'` 的资源，额外建
#     `content.keyword` multi-field，支持精确匹配驼峰标识符。
# 实施说明：
#     - PRD 原文字段名 `content`，TabTin 实际模型 `ContextItem.preview`
#       承载预览片段（含代码预览）；此处落到 `preview.keyword` 更贴合
#       实际数据位置。Wave 1 同步管道把 `ContextItem.preview` 写入本字段。
#     - 非 tabcode 资源也会写 `preview.keyword`，但 Wave 2 搜索层的精
#       确匹配查询仅对 `item_type='tabcode'` 生效（用 bool filter），
#       其他类型仍走 `preview`（文本 + ICU + bigram）。
#     - `ignore_above=256`：避免长 preview 单个 token 超限影响 segment。
#
# 字段来源映射（Wave 1 参考，模型 `apps/tabtinspace/models.py:ContextItem`）：
#   item_id          ← ContextItem.id（对应搜索结果的文档主键）
#   item_type        ← ContextItem.item_type（tabdoc/tabdata/tabslide/tabcode/...）
#   title            ← ContextItem.title
#   preview          ← ContextItem.preview（含 `.keyword` 子字段用于 tabcode 精确匹配）
#   resource_id      ← ContextItem.resource_id（底层业务资源 pk）
#   space_id/organization_id ← ContextItem 所属 Space / Organization
#   creator_type/creator_id ← ContextItem.creator_type + creator_id
#   is_archived      ← ContextItem.is_archived
#   trashed_at       ← ContextItem.trashed_at
#                      Wave 1 同步：trashed_at != NULL 触发 delete
#   visibility       ← ContextItem.visibility（public/private/share）
#   object_scope_id  ← 预留字段，语义待 Wave 2 ACL 设计敲定：
#                      候选方案 A：若历史 object_scope 命中该
#                      ContextItem.id，填入 share.id；可空。参见
#                      总控遗留项 R0-03。
RESOURCES_MAPPING: dict[str, Any] = {
    "dynamic": "strict",
    "properties": {
        "item_id": _keyword(),
        "item_type": _keyword(),
        "title": _text(multi_keyword=True),
        # preview 采用 multi-field：text 走 ICU+bigram 做全文召回，
        # keyword 分支用于 PRD 4.5 的 tabcode 驼峰标识符精确匹配
        "preview": _text(multi_keyword=True),
        "resource_id": _keyword(),
        "space_id": _keyword(),
        "organization_id": _keyword(),
        "creator_type": _keyword(),
        "creator_id": _keyword(),
        "is_archived": _bool(),
        "trashed_at": _date(),
        "visibility": _keyword(),
        "object_scope_id": _keyword(),
        "created_at": _date(),
        "updated_at": _date(),
    },
}

# 3) tabtin-agents：PRD 3.8.C（去除 ES 8.x 已废弃的 mapping-level boost）
#
# 字段来源映射（模型 `apps/tabtinspace/models.py:Agent`）：
#   agent_id     ← Agent.id
#   name         ← Agent.name（易改字段同样走 Wave 1 `update_by_query`）
#   description  ← Agent.goal（Agent 无独立 description，用 goal 作可搜索描述）
#   type         ← Agent.type（当前仅 bot）
#   organization_id  ← Agent.organization_id
#   user_id      ← Agent.owner_user_id（Agent 所有者；检索筛选用：
#                  "我的 Agent" 筛）
#   space_ids    ← Agent 绑定的 Space id 列表（type='bot' 时为专属
#                  Space；可通过 SpaceMembership.agent=... 反查）
AGENTS_MAPPING: dict[str, Any] = {
    "dynamic": "strict",
    "properties": {
        "agent_id": _keyword(),
        "name": _text(multi_keyword=True),
        "description": _text(),
        "type": _keyword(),
        "organization_id": _keyword(),
        "user_id": _keyword(),
        "space_ids": _keyword(),
        "created_at": _date(),
    },
}

# 4) tabtin-spaces：PRD 3.8.C 同规则
#
# 字段来源映射（模型 `apps/tabtinspace/models.py:Space`）：
#   space_id      ← Space.id
#   name          ← Space.name
#   description   ← Space.description
#   type          ← Space.type（personal/team/bot/dm/group）
#                   前端 Wave 3 需按 type 展示不同图标
#   is_archived   ← Space.is_archived
#   organization_id   ← Space.organization_id
SPACES_MAPPING: dict[str, Any] = {
    "dynamic": "strict",
    "properties": {
        "space_id": _keyword(),
        "name": _text(multi_keyword=True),
        "description": _text(),
        "type": _keyword(),
        "is_archived": _bool(),
        "organization_id": _keyword(),
        "created_at": _date(),
    },
}

# 5) tabtin-memos：PRD 4.5 索引 5
#
# 字段来源映射（模型 `apps/tabmemo/models.py:Memo`）：
#   memo_id       ← Memo.id
#   content       ← Memo.content_plaintext
#   tags          ← Memo.tags
#   ai_tags       ← Memo.ai_tags
#   status        ← Memo.status（active/archived/trashed）
#                   Wave 1 同步：status != 'active' 触发 delete
#   memo_type     ← Memo.memo_type（note/bookmark/about_you/insight/...）
#                   按 Agent-first 心智，Agent 产物（about_you/insight/
#                   task_summary/skill）前端可做类型筛
#   source        ← Memo.source（manual/browser/agent/voice/...）
#   is_pinned     ← Memo.is_pinned
#   trashed_at    ← Memo.trashed_at（软删索引标记）
#   space_id/organization_id/user_id/creator_type ← Memo 所属上下文
MEMOS_MAPPING: dict[str, Any] = {
    "dynamic": "strict",
    "properties": {
        "memo_id": _keyword(),
        "content": _text(),
        "tags": _keyword(),
        "ai_tags": _keyword(),
        "status": _keyword(),
        "memo_type": _keyword(),
        "source": _keyword(),
        "is_pinned": _bool(),
        "trashed_at": _date(),
        "space_id": _keyword(),
        "organization_id": _keyword(),
        "user_id": _keyword(),
        "creator_type": _keyword(),
        "created_at": _date(),
        "updated_at": _date(),
    },
}

# 6) tabtin-im：PRD 4.5 索引 6
#
# 字段来源映射（模型 `apps/tabchat/models.py:Message` + `Conversation`）：
#   message_id        ← Message.id
#   conversation_id   ← Message.conversation_id
#   conversation_name ← Conversation.name（易改字段；群聊改名走
#                       Wave 1 update_by_query）
#   sender_id         ← Message.sender_user_id
#   creator_type      ← 目前 IM 仅用户发送（'user'）；Agent 参与 IM
#                       Wave >= P1 再填值
#   space_id          ← Conversation.space_id（可空：纯私聊无 Space）
#   content           ← Message.content
#   is_deleted        ← Message.is_deleted
#                       Wave 1 同步：is_deleted=true 触发 delete
#   organization_id       ← Conversation.organization_id
IM_MAPPING: dict[str, Any] = {
    "dynamic": "strict",
    "properties": {
        "message_id": _keyword(),
        "conversation_id": _keyword(),
        "conversation_name": _text(),
        "sender_id": _keyword(),
        "creator_type": _keyword(),
        "space_id": _keyword(),
        "content": _text(),
        "is_deleted": _bool(),
        "organization_id": _keyword(),
        "created_at": _date(),
    },
}


# ── 统一的索引定义清单（供 ensure_indices / 测试遍历） ────────────
#
# `rollover=True` 表示按月 rollover（PRD 4.5 ADR-08）。对应 helper 走
# index template + 月度索引 + alias 聚合；其他索引走单索引 + 2 分片。
INDEX_DEFINITIONS: dict[str, dict[str, Any]] = {
    "messages": {
        "base_name": "messages",
        "mapping": MESSAGES_MAPPING,
        "rollover": True,
    },
    "resources": {
        "base_name": "resources",
        "mapping": RESOURCES_MAPPING,
        "rollover": False,
    },
    "agents": {
        "base_name": "agents",
        "mapping": AGENTS_MAPPING,
        "rollover": False,
    },
    "spaces": {
        "base_name": "spaces",
        "mapping": SPACES_MAPPING,
        "rollover": False,
    },
    "memos": {
        "base_name": "memos",
        "mapping": MEMOS_MAPPING,
        "rollover": False,
    },
    "im": {
        "base_name": "im",
        "mapping": IM_MAPPING,
        "rollover": False,
    },
}

# ── ES 错误处理辅助 ────────────────────────────────────────────
def _is_resource_already_exists(exc: Exception) -> bool:
    """判断异常是否为 "索引已存在" 的 ES 可幂等跳过错误。

    优先走结构化判定（`elasticsearch-py` 8.x 的 `BadRequestError`
    携带 `body['error']['type']`），回退到字符串匹配仅作兼容兜底。

    Why not just catch everything：
        直接 `except Exception` + 子串匹配会把磁盘满、鉴权失败等
        严重错误误吞成"幂等成功"（Review C1）。
    """
    try:
        from elasticsearch import BadRequestError
    except Exception:  # pragma: no cover - 延迟导入失败场景不应发生
        BadRequestError = type("BadRequestError", (Exception,), {})  # type: ignore[assignment]

    if isinstance(exc, BadRequestError):
        body = getattr(exc, "body", None)
        if isinstance(body, dict):
            err = body.get("error") or {}
            if isinstance(err, dict):
                return err.get("type") == "resource_already_exists_exception"
    # ES 客户端某些路径仍抛裸 ApiError；兜底字符串匹配只作辅助
    return "resource_already_exists_exception" in str(exc)


# ── 名称生成辅助 ────────────────────────────────────────────────
def _prefix() -> str:
    return getattr(settings, "SEARCH_INDEX_PREFIX", "tabtin") or "tabtin"


def get_index_name(base: str) -> str:
    """拼接索引/模板的前缀，例如 `messages` -> `tabtin-messages`。"""
    return f"{_prefix()}-{base}"


def get_messages_alias() -> str:
    """消息索引的查询 alias，对应 rollover 聚合视图。"""
    return get_index_name(INDEX_DEFINITIONS["messages"]["base_name"])


def get_messages_template_name() -> str:
    """消息 rollover index template 的名字，派生自 `SEARCH_INDEX_PREFIX`。

    不同环境（tabtin / tabtin-ci / tabtin-stg）连同一 ES 集群时
    template 不会互相覆盖：
        - 默认主环境  -> "tabtin-messages-template"
        - CI 环境     -> "tabtin-ci-messages-template"
        - 预发环境    -> "tabtin-stg-messages-template"
    """
    return f"{_prefix()}-messages-template"


# 历史兼容：保留旧常量名，仍指向默认 prefix 下的 template 名。
# **新代码必须用 `get_messages_template_name()`**，直接引用本常量在
# `@override_settings(SEARCH_INDEX_PREFIX=...)` 下会失效。
MESSAGES_TEMPLATE_NAME = "tabtin-messages-template"


def iter_index_names() -> list[str]:
    """返回所有"基准索引名"（不含 rollover 后缀）。

    - 非 rollover 索引：返回实际索引名
    - rollover 索引（messages）：返回 alias 名（查询入口）
    """
    return [get_index_name(d["base_name"]) for d in INDEX_DEFINITIONS.values()]


def get_monthly_index_name(base: str, dt: datetime | None = None) -> str:
    """为 rollover 索引派生月度实际索引名。

    PRD 4.5 格式：`tabtin-messages-2026-04`
    """
    dt = dt or datetime.now(tz=timezone.utc)
    return f"{get_index_name(base)}-{dt.strftime('%Y-%m')}"


# ── Helper：幂等创建 ─────────────────────────────────────────────
def _ensure_messages_template(client) -> None:
    """确保消息 rollover 的 index template 存在。

    使用 `_index_template` API（composable template，ES 7.8+ 正统接口）。
    template 名称派生自 `SEARCH_INDEX_PREFIX`，见
    `get_messages_template_name()` 说明。
    """
    template_name = get_messages_template_name()
    pattern = f"{get_index_name('messages')}-*"
    alias_name = get_messages_alias()
    body = {
        "index_patterns": [pattern],
        "priority": 500,
        "template": {
            "settings": INDEX_SETTINGS,
            "mappings": MESSAGES_MAPPING,
            "aliases": {
                alias_name: {},
            },
        },
    }
    # put_index_template 是幂等的：覆盖写入 (upsert)
    # 注意：template 只影响未来新创建的索引；已存在的月度索引 mapping
    # 不会追溯更新，Wave 5 的 reindex 命令负责补偿。
    client.indices.put_index_template(name=template_name, **body)
    logger.info("[FTS] index template ensured: %s", template_name)


def ensure_monthly_index(client, base: str = "messages", dt: datetime | None = None) -> str:
    """为 rollover 索引按月创建实际索引，幂等。

    因为 template 已登记，创建时 ES 自动应用 settings / mappings / aliases。
    返回实际索引名。

    注意：`put_index_template` 只影响**未来**创建的索引；既有月度索引
    mapping 不会追溯更新，Wave 5 的 reindex 命令负责补偿。
    """
    index_name = get_monthly_index_name(base, dt)
    if client.indices.exists(index=index_name):
        logger.debug("[FTS] monthly index exists: %s", index_name)
        return index_name
    try:
        client.indices.create(index=index_name)
    except Exception as exc:
        # 并发启动场景：create 与 exists 之间可能被其他进程抢先创建；
        # ES 返回 `resource_already_exists_exception`，此时视为成功。
        # 其他任何错误（鉴权失败、磁盘满、mapping 不兼容）必须继续上抛。
        if _is_resource_already_exists(exc):
            logger.info("[FTS] monthly index already created (race): %s", index_name)
            return index_name
        raise
    logger.info("[FTS] monthly index created: %s", index_name)
    return index_name


def _ensure_plain_index(client, base: str, mapping: dict[str, Any]) -> str:
    """为非 rollover 索引幂等创建（含 settings + mappings）。"""
    index_name = get_index_name(base)
    if client.indices.exists(index=index_name):
        logger.debug("[FTS] index exists: %s", index_name)
        return index_name
    try:
        client.indices.create(
            index=index_name,
            settings=INDEX_SETTINGS,
            mappings=mapping,
        )
    except Exception as exc:
        if _is_resource_already_exists(exc):
            logger.info("[FTS] index already created (race): %s", index_name)
            return index_name
        raise
    logger.info("[FTS] index created: %s", index_name)
    return index_name


def ensure_indices(client, *, include_current_month: bool = True) -> dict[str, str]:
    """幂等创建所有索引。

    - 消息：确保 index template + 当月索引
    - 其他：确保单索引（含 settings / mappings）
    - Wave 5：末尾应用 slow_log 配置（PRD 6.4）

    参数：
        client: `elasticsearch.Elasticsearch` 实例（或兼容的 mock）。
        include_current_month: 是否顺带创建当月消息索引；
            回填命令场景可置 False 仅同步 template。

    返回：dict，key=逻辑名（messages/resources/...），value=实际创建的索引名
    （对于消息即当月索引名）。
    """
    created: dict[str, str] = {}
    for logical, definition in INDEX_DEFINITIONS.items():
        base = definition["base_name"]
        if definition["rollover"]:
            _ensure_messages_template(client)
            if include_current_month:
                created[logical] = ensure_monthly_index(client, base=base)
            else:
                created[logical] = get_index_name(base)  # alias 名
        else:
            created[logical] = _ensure_plain_index(client, base, definition["mapping"])

    # Wave 5：slow_log 配置（PRD 6.4 Observability）
    _ensure_slow_log_settings(client)

    return created


def _ensure_slow_log_settings(client) -> None:
    """对全部 `tabtin-*` 索引应用 slow_log 阈值（PRD 6.4）。

    设置：
        - search.slowlog.threshold.query.warn=500ms（搜索查询慢于 500ms 打 WARN）
        - indexing.slowlog.threshold.index.warn=1s（写入慢于 1s 打 WARN）
    幂等：已设置过则 ES 自动 merge，不会失败。

    失败 swallow（不阻塞 ensure_indices 主流程）：阿里云 ES 部分版本不支持
    某些 slowlog 字段，错误降级为 warning 日志即可。
    """
    pattern = f"{_prefix()}-*"
    try:
        client.indices.put_settings(
            index=pattern,
            body={
                "index.search.slowlog.threshold.query.warn": "500ms",
                "index.search.slowlog.threshold.query.info": "200ms",
                "index.indexing.slowlog.threshold.index.warn": "1s",
                "index.indexing.slowlog.threshold.index.info": "500ms",
            },
        )
        logger.info("[FTS] slow_log thresholds applied to %s", pattern)
    except Exception as exc:  # pragma: no cover
        logger.warning("[FTS] slow_log put_settings failed (non-fatal): %s", exc)
