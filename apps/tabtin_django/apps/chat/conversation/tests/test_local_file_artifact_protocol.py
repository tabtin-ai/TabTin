from datetime import datetime, timezone

from apps.chat.conversation.api.message import _slim_content_blocks
from apps.chat.conversation.schemas import ChatMessageSchema


def _local_file_block(file_type: str, relative_path: str, filename: str, mime_type: str) -> dict:
    return {
        "type": "tabtin_rich_content",
        "kind": "file",
        "summary": filename,
        "payload": {
            "artifact_kind": "local_file",
            "file_type": file_type,
            "relative_path": relative_path,
            "filename": filename,
            "url": f"tabtin://resource/file/{relative_path.replace('/', '%2F')}?hint=tabfiles",
            "mime_type": mime_type,
            "file_size": 12345,
            "self_check": {
                "status": "passed",
                "summary": "Checked file format",
            },
        },
    }


def _local_file_block_xlsx() -> dict:
    return _local_file_block(
        "xlsx",
        "artifacts/weather.xlsx",
        "weather.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


def test_slim_history_response_keeps_local_file_artifact_payload():
    """Local-file payload is the open contract, so list/history API must keep it."""
    block = _local_file_block_xlsx()

    slimmed = _slim_content_blocks([block], strip_types=None)

    assert slimmed == [block]
    assert slimmed[0]["payload"]["relative_path"] == "artifacts/weather.xlsx"
    assert slimmed[0]["payload"]["url"].startswith("tabtin://resource/file/")
    assert slimmed[0]["payload"]["self_check"]["status"] == "passed"


def test_slim_history_response_still_strips_generic_rich_content_payloads():
    block = {
        "type": "tabtin_rich_content",
        "kind": "table_preview",
        "summary": "Large table",
        "payload": {"rows": [{"i": i} for i in range(100)]},
    }

    slimmed = _slim_content_blocks([block], strip_types=None)

    assert "payload" not in slimmed[0]
    assert slimmed[0]["_slim_marker"] is True
    assert slimmed[0]["_slim_stripped"] == ["payload"]


def test_chat_message_schema_serializes_tool_artifact_local_file_fields():
    block = _local_file_block_xlsx()

    data = ChatMessageSchema(
        id="00000000-0000-4000-8000-000000000001",
        role="assistant",
        content="[富内容]",
        content_blocks_json=[block],
        attachments_json=[],
        agent_type=None,
        intent=None,
        message_kind="tool_artifact",
        has_artifacts=False,
        created_at=datetime(2026, 6, 22, tzinfo=timezone.utc),
    ).model_dump(mode="json")

    payload = data["content_blocks_json"][0]["payload"]
    assert data["message_kind"] == "tool_artifact"
    assert payload["artifact_kind"] == "local_file"
    assert payload["file_type"] == "xlsx"
    assert payload["relative_path"] == "artifacts/weather.xlsx"
    assert payload["url"] == "tabtin://resource/file/artifacts%2Fweather.xlsx?hint=tabfiles"
    assert payload["mime_type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert payload["file_size"] == 12345
    assert payload["self_check"]["status"] == "passed"


def test_slim_history_response_keeps_docx_and_pdf_local_file_artifact_payload():
    for file_type, filename, mime_type in (
        (
            "docx",
            "report.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
        ("pdf", "summary.pdf", "application/pdf"),
        (
            "pptx",
            "deck.pptx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
    ):
        block = _local_file_block(
            file_type,
            f"artifacts/{filename}",
            filename,
            mime_type,
        )
        slimmed = _slim_content_blocks([block], strip_types=None)
        assert slimmed == [block]
        assert slimmed[0]["payload"]["file_type"] == file_type


def test_slim_history_response_keeps_oss_file_artifact_payload():
    """#5477：oss_file payload（file_id / access_url）是打开契约，slim 必须保留。"""
    file_id = "550e8400-e29b-41d4-a716-446655440000"
    block = {
        "type": "tabtin_rich_content",
        "kind": "file",
        "summary": "chart.png",
        "payload": {
            "artifact_kind": "oss_file",
            "file_id": file_id,
            "file_type": "png",
            "filename": "chart.png",
            "url": f"tabtin://resource/file/{file_id}?hint=tabfiles&title=chart.png",
            "mime_type": "image/png",
            "access_url": "https://cdn.example.com/agent/uploads/chart.png",
            "self_check": {"status": "passed", "summary": "OSS upload succeeded"},
        },
    }
    slimmed = _slim_content_blocks([block], strip_types=None)
    assert slimmed == [block]
    assert slimmed[0]["payload"]["file_id"] == file_id
    assert slimmed[0]["payload"]["access_url"].startswith("https://")
