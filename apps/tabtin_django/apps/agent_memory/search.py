"""AgentMemory 统一检索层（ 根因修）。

**问题**：``AgentMemoryRepository.list_page`` / ``AgentMemoryRecall.list_memories``
过去把 ``search`` 整句丢给 ``icontains``——等价于要求记忆原文**逐字包含**用户
的问法。自然语言改写（近义词替换、语序变化、疑问句 vs 陈述句）几乎必空：
记忆「用户每天早上 9 点开晨会」，问「我每天有什么固定日程？」整句子串必空。

**本模块**是 AgentMemory 所有读侧 search 的唯一分词 / 候选 / 打分实现——
``repository.list_page``（HTTP `/agent-memory/memories/`，面板 + memory_search
工具 + memory-injector 召回共用）与 ``recall.list_memories``（服务端内部
多-agent 管道）都经此收口，不再各自维护一份 ``icontains``。

**策略**（"最低可接受的正确方向"，够用即止，非语言学分词器 / 非 embedding）：
  1. **分词**：拉丁词按 ``[A-Za-z0-9_]+`` 切分、小写化，过滤长度 < 2 的噪声词
     与停用词；中文连续片段做 2 字滑动窗口 bigram（如"每天"）—— 不需要引入
     分词依赖，对近义改写 / 语序变化比整句子串更容易命中重叠片段。
  2. **候选集**：任一关键词 ``icontains`` 命中即入选（OR）——保证改写问法
     不空手；比"要求全部关键词命中"（AND）更宽松，换取召回率。
  3. **打分**：命中的**不同关键词个数**（多关键词命中优先，同时兼容单关键词
     擦边命中）——在 Python 侧计数，不再把 N 个 ``Case/When`` 链式 ``+`` 成
     Django ``CombinedExpression``（长中文 bigram 会把表达式树顶穿递归上限，
     见  / ）。
  4. **排序**：分数降序，新鲜度（``created_at``）降序打平；由调用方在物化
     候选行后调用 ``rank_by_search_score``。diary feed 只过滤，仍按新鲜度
     cursor 排。
  5. **阈值**：候选集本身即隐含阈值——分数为 0（零关键词命中）的行永远
     不进候选集，不会被召回注入。调用方可读取返回行上的 score 属性做更严格
     的二次过滤（如"至少命中 2 个关键词才注入"），本模块不强加更高阈值。
  6. **关键词上限**：分词结果截到 ``MAX_SEARCH_KEYWORDS``，避免 CJK 全文
     bigram 把 OR 条件树也堆到 Django ``WhereNode`` 递归上限。

**限制**（明确写在这里，不装作是终态）：
  - CJK bigram 对短句噴出的候选可能偏宽（如高频虚词 bigram），换取的是
    "改写几乎必空"这个更严重的问题被修好；后续要收紧精度可在打分上叠加
    idf 权重或引入 pgvector/embedding 语义检索（本 PR 明确留作后续）。
  - 不是全文检索引擎（无 tsvector / GIN 索引，仍是多个 ``icontains``
    OR 查询）——量级假设与既有实现一致（单 agent 记忆数百行）。
"""

from __future__ import annotations

import re
from typing import Optional

from django.db.models import Q, QuerySet

# 停用词：中英文高频功能词/疑问词——分词后若不过滤，几乎每条记忆都会被
# 这些词命中，稀释掉真正有信息量的关键词的打分权重。
STOPWORDS = frozenset(
    {
        # 英文虚词 / 疑问词
        "the", "a", "an", "is", "are", "was", "were", "be", "been", "of", "to",
        "in", "on", "at", "for", "and", "or", "with", "this", "that", "it", "as",
        "by", "from", "what", "how", "do", "does", "did", "my", "me", "we", "you",
        "he", "she", "they", "have", "has", "had", "will", "would", "can", "could",
        # 中文虚词 / 疑问词 / 代词
        "的", "了", "是", "在", "我", "你", "他", "她", "它", "们", "什么",
        "怎么", "哪", "吗", "呢", "啊", "有", "和", "与", "或", "都", "就",
        "也", "而", "着", "过", "把", "被", "让", "给", "对", "从", "到",
        "这", "那", "些", "个", "还", "又", "才", "很", "但", "又", "呀",
    }
)

# 拉丁词最短长度——过滤 "a" "i" 等单字母噪声；数字 token 不受此限（"9" 有信息量）。
MIN_LATIN_TOKEN_LEN = 2

# 参与 OR / 打分的关键词上限。CJK bigram 在 500 字内可喷出数百 token；
# Django 对左结合 CombinedExpression / WhereNode 的递归遍历约 190 层即 RecursionError。
MAX_SEARCH_KEYWORDS = 64

_LATIN_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")
_CJK_RUN_RE = re.compile(r"[\u4e00-\u9fff]+")

# 参与 icontains 候选匹配的字段——与既有实现（content_plaintext/content_markdown）
# 对齐，额外加 title（diary 等面向用户展示的记忆行标题也应可被搜到）。
SEARCH_FIELDS: tuple[str, ...] = ("content_plaintext", "content_markdown", "title")


def tokenize_query(text: str) -> list[str]:
    """把自然语言 query 拆成关键词 token 列表（去重，保留首次出现顺序）。

    空 / 全是停用词 / 全过短 → 返回 ``[]``（调用方应视为"退化为不过滤"，
    与"完全没传 search"同语义——不能让一句寒暄式短查询导致误判为"零结果"）。
    """
    if not text:
        return []
    seen: set[str] = set()
    tokens: list[str] = []

    def _add(tok: str) -> None:
        if tok and tok not in seen and tok not in STOPWORDS:
            seen.add(tok)
            tokens.append(tok)

    for match in _LATIN_TOKEN_RE.finditer(text):
        tok = match.group(0).lower()
        if tok.isdigit() or len(tok) >= MIN_LATIN_TOKEN_LEN:
            _add(tok)

    for run in _CJK_RUN_RE.finditer(text):
        chars = run.group(0)
        if len(chars) == 1:
            _add(chars)
            continue
        for i in range(len(chars) - 1):
            bigram = chars[i : i + 2]
            # 两个字都是停用词（如"的了"）→ 整个 bigram 也没有信息量，跳过；
            # 只要有一个字不是停用词（如"每天"），bigram 就可能承载实际语义。
            if all(ch in STOPWORDS for ch in bigram):
                continue
            _add(bigram)

    return tokens[:MAX_SEARCH_KEYWORDS]


def apply_keyword_search(
    queryset: QuerySet,
    search: str,
    *,
    fields: tuple[str, ...] = SEARCH_FIELDS,
) -> QuerySet:
    """把 ``search`` 应用到 ``queryset``：分词 → OR 候选过滤。

    - ``search`` 分词后为空（空串 / 纯停用词 / 全过短）→ 原样返回 ``queryset``，
      不过滤、不改排序——调用方原有排序（通常按新鲜度）继续生效，与"完全不传
      search"行为一致，避免把"查询没有信息量"误判成"查无结果"。
    - 否则：只按候选 OR 过滤（任一关键词 icontains 命中），**不** annotate、
      **不**改排序。打分见 ``rank_by_search_score``。
    - 分词为空时返回**同一个** ``queryset`` 对象，调用方可用 ``is`` 判断
      要不要走打分分页。
    """
    keywords = tokenize_query(search)
    if not keywords:
        return queryset

    candidate_q = Q()
    for keyword in keywords:
        field_q = Q()
        for field in fields:
            field_q |= Q(**{f"{field}__icontains": keyword})
        candidate_q |= field_q

    return queryset.filter(candidate_q)


def _score_memory(
    memory,
    keywords: list[str],
    *,
    fields: tuple[str, ...] = SEARCH_FIELDS,
) -> int:
    """命中的不同关键词个数；``str.casefold`` 近似 ``icontains``。"""
    haystacks = [str(getattr(memory, field, None) or "").casefold() for field in fields]
    score = 0
    for keyword in keywords:
        needle = keyword.casefold()
        if needle and any(needle in haystack for haystack in haystacks):
            score += 1
    return score


def _attach_search_scores(
    rows: list,
    search: str,
    *,
    score_field: str = "search_score",
    fields: tuple[str, ...] = SEARCH_FIELDS,
) -> list:
    keywords = tokenize_query(search)
    if not keywords:
        return rows
    for row in rows:
        setattr(row, score_field, _score_memory(row, keywords, fields=fields))
    return rows


def rank_by_search_score(
    rows: list,
    search: str,
    *,
    score_field: str = "search_score",
    fields: tuple[str, ...] = SEARCH_FIELDS,
) -> list:
    """分数降序，``created_at`` / ``id`` 降序打平。"""
    _attach_search_scores(rows, search, score_field=score_field, fields=fields)
    return sorted(
        rows,
        key=lambda row: (
            getattr(row, score_field) or 0,
            getattr(row, "created_at", None),
            getattr(row, "id", None),
        ),
        reverse=True,
    )


def read_score(memory, *, score_field: str = "search_score") -> Optional[int]:
    """读取 ``rank_by_search_score`` 写在行上的分数；未打分返回 ``None``。

    调用方（序列化 / 召回阈值判断）统一经此读取，不直接 ``getattr``——
    字段名是本模块的实现细节，不应该在多处硬编码字符串。
    """
    return getattr(memory, score_field, None)


__all__ = [
    "STOPWORDS",
    "SEARCH_FIELDS",
    "MAX_SEARCH_KEYWORDS",
    "tokenize_query",
    "apply_keyword_search",
    "rank_by_search_score",
    "read_score",
]
