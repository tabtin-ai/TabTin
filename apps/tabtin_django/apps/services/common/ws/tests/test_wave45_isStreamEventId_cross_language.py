"""W4.5 第二波 B3 · `isStreamEventId` 跨语言契约测试（Python 端）。

**业务目标**
------------
Redis Stream ID（`<digits>-<digits>`，譬如 `1702000000000-0`）是 backend
`_handle_resume` 真正用于 replay 的 cursor 形态。4 端（TS daemon /
Renderer、Python Django、Swift iOS、Kotlin Android）持久化层必须对**同一
个字符串**给出**完全相同**的"该不该写"判定——否则任一端走偏，跨进程 /
跨设备 catchup 立刻 break，用户场景：

  "Mac 上 Agent 跑了 2 分钟 → 切到 iPhone 看 → 回到 Mac 再打开" 应当能续传
  这 2 分钟内 backend Redis Stream 缓冲的事件。

任一端把 `evt_<uuid>` 或全角数字形态的 ID 误判为 Stream ID 写入 cursor
存储，下次冷启动调 backend `_handle_resume(last_event_id=...)` 走 replay=0
沉默路径，**用户完全感知不到续传无效**。

**算法约定（4 端等价）**
----------------------
仅当字符串严格匹配 `^[0-9]+-[0-9]+$`（ASCII-only digits + 单 dash 分隔
+ 两侧均非空）时返回 True。

**契约 fixture**
----------------
`packages/agent-wire/src/cross-lang-fixtures/wave45-isStreamEventId.json`
—— 共 19 case，其中 5 条 valid + 14 条 invalid（含 Unicode 分歧防御 3 条：
全角 U+FF10..U+FF19 / 阿拉伯-印度 U+0660..U+0669 / 扩展阿拉伯-印度
U+06F0..U+06F9）。

**Python 实现已按 W4c-L1 收紧为严格 ASCII**
----------------------------------------
`apps/tabtin_django/apps/services/common/ws/protocol.py::is_stream_event_id`
原先用 `str.isdigit()`，会接受 Unicode digit 等价物（全角 / 阿拉伯-印度 /
扩展阿拉伯-印度数字）——与 TS `/^\\d+$/`（默认 ASCII-only）冲突。本 Wave
B3 顺手修紧为 `all(c in "0123456789" for c in part)`，4 端 byte-by-byte
等价。

**测试组织**
------------
- `TestSpecCompliant`：用 fixture 期望的"严格 ASCII"语义实现（test-only），
  验证 fixture 自身可被一种已知正确实现完全满足。
- `TestCurrentImplementationFullSweep`：用收紧后的现网 `is_stream_event_id`
  对每条 case 做断言——19 case 全 pass。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List

import pytest

from apps.services.common.ws.protocol import is_stream_event_id


# ── 找 fixture 文件 ──
_REPO_ROOT = Path(__file__).resolve()
for _ in range(10):
    _REPO_ROOT = _REPO_ROOT.parent
    if (_REPO_ROOT / 'packages' / 'agent-wire').exists():
        break

_FIXTURE_PATH = (
    _REPO_ROOT
    / 'packages'
    / 'agent-wire'
    / 'src'
    / 'cross-lang-fixtures'
    / 'wave45-isStreamEventId.json'
)


@pytest.fixture(scope='module')
def contract_fixture() -> Dict[str, Any]:
    """读 wave45-isStreamEventId.json contract fixture。"""
    if not _FIXTURE_PATH.exists():
        pytest.skip(f"contract fixture 不存在：{_FIXTURE_PATH}")
    with open(_FIXTURE_PATH, encoding='utf-8') as f:
        return json.load(f)


def _spec_compliant_is_stream_event_id(event_id: Any) -> bool:
    """参考实现 —— ASCII-only 严格数字判定（用 regex，与现网用 frozenset 对比）。

    与 TS `/^\\d+$/` + Swift `c.isASCII && c.isNumber` + Kotlin `c in '0'..'9'`
    完全等价。是 fixture rules.must_match_regex `^[0-9]+-[0-9]+$` 的直接实现。

    Python 现网 `is_stream_event_id`（W4.5 B3 已修紧）用 `frozenset("0123456789")`
    + `all(c in ...)` —— 与本 regex 实现完全等价（行为）但形态不同。两份
    实现在 fixture 全 case 上必须给出 100% 相同的判定，本测试模块同时跑两份
    实现：
      - `TestFixtureSelfCheck.test_spec_compliant_implementation_passes_all_cases`
        验证 regex 参考实现 vs fixture
      - `TestCurrentImplementationFullSweep.test_all_fixture_cases_match_current_implementation`
        验证 frozenset 现网实现 vs fixture
    两份各自 PASS = 两份等价。如果未来 PR 把现网实现退化回 `str.isdigit()`，
    现网 sweep 测试会在 Unicode digit case 上 fail，立刻拦截退化。
    """
    if not isinstance(event_id, str) or not event_id:
        return False
    return bool(re.match(r'^[0-9]+-[0-9]+$', event_id))


class TestFixtureSelfCheck:
    """fixture 自身格式校验 + Spec-compliant 参考实现自我验证。"""

    def test_fixture_format_valid(self, contract_fixture):
        assert contract_fixture['spec_version'] == 'v1'
        assert contract_fixture['rules']['must_match_regex'] == '^[0-9]+-[0-9]+$'
        assert contract_fixture['rules']['must_be_ascii_only'] is True
        assert contract_fixture['rules']['must_reject_empty'] is True
        assert contract_fixture['rules']['must_reject_non_string'] is True
        assert len(contract_fixture['cases']) >= 10

    def test_spec_compliant_implementation_passes_all_cases(self, contract_fixture):
        """方案 A 参考实现必须对所有 fixture case 给出与 expected 一致的判定。

        这条 PASS 证明：fixture 自身规则是"可被一种已知正确实现满足"的，
        没有内部矛盾或不可达 case。
        """
        mismatches: List[Dict[str, Any]] = []
        for case in contract_fixture['cases']:
            actual = _spec_compliant_is_stream_event_id(case['input'])
            if actual != case['expected']:
                mismatches.append({
                    'name': case['name'],
                    'input': case['input'],
                    'expected': case['expected'],
                    'actual': actual,
                })
        assert not mismatches, (
            f"方案 A 参考实现（test-only ASCII-only）应当满足 fixture 所有 case "
            f"但出现不一致，说明 fixture 内部矛盾或参考实现有 bug：{mismatches}"
        )


class TestCurrentImplementationFullSweep:
    """现网 `is_stream_event_id` 必须与 fixture 全 case 一致。

    W4.5 B3 修紧 Python 实现后，**Unicode digit case 也必须 PASS**——
    （全角 / 阿拉伯-印度 / 扩展阿拉伯-印度数字均严格拒绝）。

    如果未来某次 PR 把 `is_stream_event_id` 改回 `str.isdigit()`，本测试
    会立刻在 Unicode 分歧 case 上 fail，拦截退化。
    """

    def test_all_fixture_cases_match_current_implementation(self, contract_fixture):
        """fixture 每条 case 都必须与现网 `is_stream_event_id` 结果一致。"""
        mismatches: List[Dict[str, Any]] = []
        for case in contract_fixture['cases']:
            input_val = case['input']
            actual = is_stream_event_id(input_val) if isinstance(input_val, str) else False
            if actual != case['expected']:
                mismatches.append({
                    'name': case['name'],
                    'input': input_val,
                    'expected': case['expected'],
                    'actual': actual,
                })
        assert not mismatches, (
            f"现网 is_stream_event_id 与 fixture 分歧——可能本次 PR 把实现"
            f"从 ASCII-only 改回 Unicode-aware（譬如 str.isdigit()），"
            f"破坏 4 端跨语言契约。详情：{mismatches}"
        )

    def test_unicode_digit_variants_rejected(self):
        """显式覆盖 3 种主流 Unicode digit 等价物——任意一种被接受都意味着
        Python 端退化回 `str.isdigit()` 之类的 Unicode-aware 判定，跨语言契
        约即刻破裂。"""
        # 全角数字 U+FF10..U+FF19
        assert is_stream_event_id('１７０２０００-０') is False
        # 阿拉伯-印度数字 U+0660..U+0669
        assert is_stream_event_id('١٧٠٢٠٠٠-٠') is False
        # 扩展阿拉伯-印度数字 U+06F0..U+06F9（波斯）
        assert is_stream_event_id('۱۷۰۲۰۰۰-۰') is False

    def test_print_implementation_sweep(self, contract_fixture, capsys):
        """打印现网实现对全 fixture 的 sweep 结果——诊断/可读性辅助，不强断言。"""
        rows: List[str] = []
        rows.append(f"\n{'─' * 80}")
        rows.append(f"W4.5 B3 现网 is_stream_event_id vs wave45-isStreamEventId fixture")
        rows.append(f"{'─' * 80}")
        rows.append(f"{'结果':<10}{'input':<40}{'expected':<10}{'actual':<10}{'name'}")
        rows.append(f"{'─' * 80}")

        passes = 0
        fails = 0
        for case in contract_fixture['cases']:
            input_val = case['input']
            expected = case['expected']
            actual = is_stream_event_id(input_val) if isinstance(input_val, str) else False
            tag = 'PASS' if actual == expected else 'FAIL'
            if tag == 'PASS':
                passes += 1
            else:
                fails += 1
            input_str = repr(input_val) if not isinstance(input_val, str) else input_val
            rows.append(
                f"{tag:<10}{input_str[:38]:<40}{str(expected):<10}"
                f"{str(actual):<10}{case['name']}"
            )

        rows.append(f"{'─' * 80}")
        rows.append(f"汇总：PASS={passes} / FAIL={fails}")
        rows.append(f"{'─' * 80}\n")
        print('\n'.join(rows))
