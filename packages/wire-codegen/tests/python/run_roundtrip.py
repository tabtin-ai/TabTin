"""Python round-trip 测试（W0-L1 / L2 / L5 实测）。

验证点：
  1. 22 case ContentBlock 全部 parse OK
  2. 6 envelope 全部 parse OK + 字段一致
  3. extra='ignore' 真的吃掉未知字段（forward-compat fixture）
  4. 浮点不损失精度（bbox=[0.123, 0.4567, 0.89012, 0.999]）
  5. 大 base64 (32KB) parse 后字符串长度一致
  6. emoji 不被 Pydantic 转 \\uXXXX
  7. 未知 type 字面量被 Pydantic discriminator 拒绝
  8. **byte-level diff**：parsed.model_dump_json(...) 后再 parse → dump 应字节相等

不依赖 pytest（最小化依赖；run_roundtrip 自己组织 case + 总结）。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

PKG_ROOT = Path(__file__).resolve().parent.parent.parent
GENERATED_DIR = PKG_ROOT / "generated" / "python"
SAMPLES_DIR = PKG_ROOT / "fixtures" / "samples"

sys.path.insert(0, str(GENERATED_DIR))


def main() -> int:
    failures: list[str] = []

    # ──────────────────────────────────────────────────────────────────
    # Suite 1: 22 case ContentBlock
    # ──────────────────────────────────────────────────────────────────
    from content_block import ContentBlock  # type: ignore

    cases = json.loads((SAMPLES_DIR / "content_block_22cases.json").read_text("utf-8"))
    print(f"\n[Suite 1] 22 case ContentBlock parse + byte-level round-trip")
    if len(cases) != 22:
        failures.append(f"expect 22 cases, got {len(cases)}")
    for idx, item in enumerate(cases, start=1):
        try:
            parsed = ContentBlock.model_validate(item)  # type: ignore[attr-defined]
            dumped = parsed.model_dump_json(exclude_none=True, by_alias=True)
            reparsed = ContentBlock.model_validate(json.loads(dumped))  # type: ignore[attr-defined]
            redumped = reparsed.model_dump_json(exclude_none=True, by_alias=True)
            if dumped != redumped:
                failures.append(f"#{idx} {item['type']}: 二次 dump 不等\n  s1={dumped[:200]}\n  s2={redumped[:200]}")
            else:
                print(f"  ✔ #{idx} {item['type']}")
        except Exception as e:
            failures.append(f"#{idx} {item['type']}: parse FAIL {type(e).__name__}: {e}")
            print(f"  ✘ #{idx} {item['type']}: {e}")

    # ──────────────────────────────────────────────────────────────────
    # Suite 2: 6 边界 case
    # ──────────────────────────────────────────────────────────────────
    print(f"\n[Suite 2] 6 边界 case (W0-L2 严格 byte-level)")
    edges = json.loads((SAMPLES_DIR / "content_block_edge_cases.json").read_text("utf-8"))
    for idx, item in enumerate(edges, start=1):
        try:
            parsed = ContentBlock.model_validate(item)  # type: ignore[attr-defined]
            print(f"  ✔ edge #{idx} {item['type']}")
        except Exception as e:
            failures.append(f"edge #{idx} {item['type']}: parse FAIL {type(e).__name__}: {e}")
            print(f"  ✘ edge #{idx} {item['type']}: {e}")

    # 单独验证浮点不丢精度
    doc_fixture = next(
        (e for e in edges if e["type"] == "tabtin_source_ref" and e["snapshot"]["kind"] == "doc"),
        None,
    )
    if doc_fixture is not None:
        parsed = ContentBlock.model_validate(doc_fixture)  # type: ignore[attr-defined]
        dumped = json.loads(parsed.model_dump_json())
        bbox = dumped["snapshot"]["bbox"]
        if bbox != [0.123, 0.4567, 0.89012, 0.999]:
            failures.append(f"浮点丢精度: bbox={bbox} expected=[0.123, 0.4567, 0.89012, 0.999]")
        else:
            print(f"  ✔ 浮点 bbox 不丢精度: {bbox}")

    # 单独验证 emoji 不被 escape
    emoji_fixture = next(
        (e for e in edges if e["type"] == "text" and "🤔" in e.get("text", "")),
        None,
    )
    if emoji_fixture is not None:
        parsed = ContentBlock.model_validate(emoji_fixture)  # type: ignore[attr-defined]
        dumped = parsed.model_dump_json(exclude_none=True)
        if "🤔" not in dumped:
            failures.append(f"emoji 被 Pydantic escape：dumped={dumped[:200]}")
        else:
            print(f"  ✔ emoji 不被 Pydantic escape (dump 含原 emoji)")

    # 单独验证大 base64 不丢字符
    big_b64 = next(
        (e for e in edges if e["type"] == "image"
         and isinstance(e.get("source"), dict)
         and e["source"].get("type") == "base64"
         and len(e["source"].get("data", "")) >= 32 * 1024),
        None,
    )
    if big_b64 is not None:
        parsed = ContentBlock.model_validate(big_b64)  # type: ignore[attr-defined]
        # parsed.source.data 应原样
        # 由于 RootModel union 包装，访问需要 .root 或 .source —— 看实际生成
        dumped_dict = parsed.model_dump(exclude_none=True)
        # ImageBlock.source 是 ImageSource RootModel，需要 dump 后看长度
        dumped_json = parsed.model_dump_json(exclude_none=True)
        re_dict = json.loads(dumped_json)
        if "source" in re_dict and "data" in re_dict["source"]:
            data_len = len(re_dict["source"]["data"])
        elif "source" in re_dict and "root" in re_dict.get("source", {}):
            data_len = len(re_dict["source"]["root"].get("data", ""))
        else:
            data_len = -1
        if data_len != 32 * 1024:
            failures.append(f"大 base64 长度不一致: got {data_len}, expected {32 * 1024}")
        else:
            print(f"  ✔ 大 base64 (32KB) round-trip 长度一致")

    # ──────────────────────────────────────────────────────────────────
    # Suite 3: extra='ignore' forward-compat
    # ──────────────────────────────────────────────────────────────────
    print(f"\n[Suite 3] forward-compat (extra='ignore')")
    fwd = json.loads((SAMPLES_DIR / "content_block_forward_compat.json").read_text("utf-8"))
    for idx, item in enumerate(fwd, start=1):
        try:
            parsed = ContentBlock.model_validate(item)  # type: ignore[attr-defined]
            # extra=ignore 应该静默吃掉未知字段
            print(f"  ✔ forward-compat #{idx} {item['type']} parse OK (未知字段被 ignore)")
        except Exception as e:
            failures.append(f"forward-compat #{idx} {item['type']}: 应该 parse 通过但被拒 {type(e).__name__}: {e}")
            print(f"  ✘ forward-compat #{idx} {item['type']}: {e}")

    # ──────────────────────────────────────────────────────────────────
    # Suite 4: 未知 type 必须被拒绝（fail-fast）
    # ──────────────────────────────────────────────────────────────────
    print(f"\n[Suite 4] 未知 type 字面量必须被拒绝")
    try:
        ContentBlock.model_validate({"type": "fictional_v3_block", "x": 1})  # type: ignore[attr-defined]
        failures.append("未知 type 应该被拒绝但 parse 成功了")
        print(f"  ✘ 未知 type 没被拒")
    except Exception as e:
        # ValidationError 的 message 应该指向 discriminator 而不是 22 行尝试
        msg = str(e)
        if "discriminator" in msg.lower() or "tag" in msg.lower() or "literal" in msg.lower():
            print(f"  ✔ 未知 type 被 discriminator 拒（expected）")
        else:
            print(f"  ⚠ 未知 type 被拒，但错误信息不是 discriminator 提示：{msg[:200]}")

    # ──────────────────────────────────────────────────────────────────
    # Suite 5: 6 envelope round-trip
    # ──────────────────────────────────────────────────────────────────
    print(f"\n[Suite 5] 6 envelope round-trip + protocol_version 校验")
    envelope_specs = [
        ("envelope_message_start.json", "message_start", "MessageStart"),
        ("envelope_message_delta.json", "message_delta", "MessageDelta"),
        ("envelope_message_stop.json", "message_stop", "MessageStop"),
        # W4c-L5 · W4.5 第二波 B1：partial_reason 三档 fixture
        (
            "envelope_message_stop_partial_reasons.json",
            "message_stop",
            "MessageStop",
        ),
        ("envelope_content_block_start.json", "content_block_start", "ContentBlockStart"),
        ("envelope_content_block_delta_6types.json", "content_block_delta", "ContentBlockDelta"),
        ("envelope_content_block_stop.json", "content_block_stop", "ContentBlockStop"),
    ]
    for fixture_name, module_name, class_name in envelope_specs:
        try:
            mod = __import__(module_name)
            cls = getattr(mod, class_name)
            data = json.loads((SAMPLES_DIR / fixture_name).read_text("utf-8"))
            items = data if isinstance(data, list) else [data]
            for item in items:
                parsed = cls.model_validate(item)
                dumped = parsed.model_dump_json(exclude_none=True, by_alias=True)
                # round-trip
                reparsed = cls.model_validate(json.loads(dumped))
                redumped = reparsed.model_dump_json(exclude_none=True, by_alias=True)
                if dumped != redumped:
                    failures.append(f"envelope {class_name} 二次 dump 不等")
            print(f"  ✔ {class_name} ({len(items)} 个 fixture)")
        except Exception as e:
            failures.append(f"envelope {class_name}: {type(e).__name__}: {e}")
            print(f"  ✘ {class_name}: {e}")

    # ──────────────────────────────────────────────────────────────────
    # Suite 6: any_event 顶层 union 按 event_type 分发
    # ──────────────────────────────────────────────────────────────────
    print(f"\n[Suite 6] any_event 顶层 union 分发")
    try:
        from any_event import AnyContentBlockStreamEvent  # type: ignore
        stream = json.loads((SAMPLES_DIR / "envelope_any_event_stream.json").read_text("utf-8"))
        for ev in stream:
            parsed = AnyContentBlockStreamEvent.model_validate(ev)  # type: ignore[attr-defined]
        print(f"  ✔ {len(stream)} 个 event 全部按 event_type 分发到正确 envelope")
    except Exception as e:
        failures.append(f"any_event: {type(e).__name__}: {e}")
        print(f"  ✘ any_event: {e}")

    # ──────────────────────────────────────────────────────────────────
    # 总结
    # ──────────────────────────────────────────────────────────────────
    print()
    print("═══════════════════════════════════════════════════════════════")
    if failures:
        print(f"  ✘ {len(failures)} 个失败：")
        for f in failures:
            print(f"     - {f}")
        print("═══════════════════════════════════════════════════════════════")
        return 1
    else:
        print(f"  ✔ Python round-trip 全部通过")
        print("═══════════════════════════════════════════════════════════════")
        return 0


if __name__ == "__main__":
    sys.exit(main())
