"""CLI behavior: stdin spec, type inference, structured errors, atomic write."""

from __future__ import annotations

import io
import json

from tabtin_filegen.__main__ import main


def _run(argv, stdin_text=None, monkeypatch=None, capsys=None):
    if stdin_text is not None:
        monkeypatch.setattr("sys.stdin", io.StringIO(stdin_text))
    code = main(argv)
    captured = capsys.readouterr()
    return code, captured


def test_create_via_stdin_infers_type_from_extension(tmp_path, monkeypatch, capsys):
    out = tmp_path / "report.xlsx"
    spec = json.dumps({"sheets": [{"rows": [["a", 1]]}]})
    code, captured = _run(
        ["create", "-o", str(out)], stdin_text=spec, monkeypatch=monkeypatch, capsys=capsys
    )
    assert code == 0
    result = json.loads(captured.out)
    assert result["file_type"] == "xlsx"
    assert result["file_size"] > 0
    assert out.exists()


def test_create_spec_from_file(tmp_path, capsys):
    spec_file = tmp_path / "spec.json"
    spec_file.write_text(json.dumps({"slides": [{"title": "Hi"}]}), encoding="utf-8")
    out = tmp_path / "deck.pptx"
    code = main(["create", "-t", "pptx", "-o", str(out), "-s", f"@{spec_file}"])
    captured = capsys.readouterr()
    assert code == 0
    assert json.loads(captured.out)["file_type"] == "pptx"


def test_invalid_json_emits_structured_error(tmp_path, monkeypatch, capsys):
    out = tmp_path / "x.docx"
    code, captured = _run(
        ["create", "-o", str(out)],
        stdin_text="{not json",
        monkeypatch=monkeypatch,
        capsys=capsys,
    )
    assert code == 1
    err = json.loads(captured.err)
    assert err["error"]["code"] == "spec_error"
    assert not out.exists()


def test_unsupported_type_error(tmp_path, monkeypatch, capsys):
    out = tmp_path / "x.rtf"
    code, captured = _run(
        ["create", "-t", "rtf", "-o", str(out)],
        stdin_text="{}",
        monkeypatch=monkeypatch,
        capsys=capsys,
    )
    assert code == 1
    assert json.loads(captured.err)["error"]["code"] == "unsupported_type"


def test_cannot_infer_type_without_extension(tmp_path, monkeypatch, capsys):
    out = tmp_path / "noext"
    code, captured = _run(
        ["create", "-o", str(out)],
        stdin_text="{}",
        monkeypatch=monkeypatch,
        capsys=capsys,
    )
    assert code == 1
    assert json.loads(captured.err)["error"]["code"] == "spec_error"


def test_failed_generation_leaves_no_partial_output(tmp_path, monkeypatch, capsys):
    out = tmp_path / "bad.xlsx"
    # empty sheets -> SpecError after temp file created; output must not appear
    code, _ = _run(
        ["create", "-t", "xlsx", "-o", str(out)],
        stdin_text=json.dumps({"sheets": []}),
        monkeypatch=monkeypatch,
        capsys=capsys,
    )
    assert code == 1
    assert not out.exists()
    # no leftover temp files in the directory
    assert list(tmp_path.iterdir()) == []


def test_list_types(capsys):
    code = main(["list-types"])
    captured = capsys.readouterr()
    assert code == 0
    entries = json.loads(captured.out)
    types = {entry["file_type"] for entry in entries}
    assert types == {"xlsx", "docx", "pptx", "pdf"}
    assert all(entry["can_generate"] and entry["can_read"] for entry in entries)


def test_read_infers_type_and_outputs_json(tmp_path, capsys):
    out = tmp_path / "data.xlsx"
    assert main(["create", "-t", "xlsx", "-o", str(out), "-s",
                 json.dumps({"sheets": [{"rows": [["甲", 1]]}]})]) == 0
    capsys.readouterr()
    code = main(["read", "-i", str(out)])  # type inferred from extension
    captured = capsys.readouterr()
    assert code == 0
    content = json.loads(captured.out)
    assert content["file_type"] == "xlsx"
    assert content["sheets"][0]["rows"] == [["甲", 1]]


def test_read_missing_file_errors(tmp_path, capsys):
    code = main(["read", "-t", "pdf", "-i", str(tmp_path / "nope.pdf")])
    captured = capsys.readouterr()
    assert code == 1
    assert json.loads(captured.err)["error"]["code"] == "spec_error"


def test_schema(capsys):
    code = main(["schema", "-t", "pdf"])
    captured = capsys.readouterr()
    assert code == 0
    assert "blocks" in captured.out


def test_no_command_prints_help(capsys):
    code = main([])
    assert code == 2
