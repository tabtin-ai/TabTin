"""群聊正文 mention markdown：`[@名称](mention:user/<id>)`。

与 Electron `mentionMarkdown.ts` 同形；预览只露名称，匹配仍看 id。
"""

from __future__ import annotations

import re

MENTION_MARKDOWN_SCHEME = "mention"
MENTION_MARKDOWN_KIND_USER = "user"
MENTION_MARKDOWN_KIND_AGENT = "agent"
MENTION_MARKDOWN_KIND_ALL = "all"

_MENTION_MARKDOWN_RE = re.compile(
    rf"\[(@[^\]]*)\]\({re.escape(MENTION_MARKDOWN_SCHEME)}:"
    rf"(?:{re.escape(MENTION_MARKDOWN_KIND_ALL)}"
    rf"|{re.escape(MENTION_MARKDOWN_KIND_USER)}/[^)\s]+"
    rf"|{re.escape(MENTION_MARKDOWN_KIND_AGENT)}/[^)\s]+)\)"
)


def format_mention_display_text(text: str) -> str:
    """把 mention markdown 收成 `@名称`，不露出 href。"""
    if not text:
        return ""
    return _MENTION_MARKDOWN_RE.sub(r"\1", text)
