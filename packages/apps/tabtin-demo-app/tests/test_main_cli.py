"""测试 main.py CLI argparse 入口——mock GitHub API。"""

import json
from unittest.mock import patch

import pytest

from cli.config import save_config
from cli.main import main


@pytest.fixture
def _with_token():
    save_config({"access_token": "ghp_test_cli"})


MOCK_ISSUE = {
    "number": 42,
    "title": "Test CLI",
    "state": "open",
    "body": "Hello from CLI test",
    "labels": [{"name": "demo"}],
    "html_url": "https://github.com/owner/repo/issues/42",
}


class TestIssueCreate:
    @patch("cli.main.github_api.create_issue", return_value=MOCK_ISSUE)
    def test_create_success(self, mock_create, _with_token, capsys):
        rc = main(["issue", "create", "--title", "Test CLI", "--repo", "owner/repo"])
        assert rc == 0
        mock_create.assert_called_once()
        out = capsys.readouterr().out
        assert "#42" in out

    @patch("cli.main.github_api.create_issue", return_value=MOCK_ISSUE)
    def test_create_json_output(self, mock_create, _with_token, capsys):
        rc = main(["issue", "create", "--title", "Test", "--repo", "o/r", "--json"])
        assert rc == 0
        out = capsys.readouterr().out
        data = json.loads(out)
        assert data["number"] == 42

    @patch("cli.main.github_api.create_issue", return_value=MOCK_ISSUE)
    def test_create_with_labels(self, mock_create, _with_token):
        rc = main(["issue", "create", "--title", "T", "--repo", "o/r", "--labels", "bug,feat"])
        assert rc == 0
        call_args = mock_create.call_args
        assert call_args.kwargs.get("labels") == ["bug", "feat"]

    def test_create_no_auth(self):
        with pytest.raises(SystemExit) as exc:
            main(["issue", "create", "--title", "T", "--repo", "o/r"])
        assert exc.value.code == 1


class TestIssueList:
    @patch("cli.main.github_api.list_issues", return_value=[MOCK_ISSUE])
    def test_list_success(self, mock_list, _with_token, capsys):
        rc = main(["issue", "list", "--repo", "owner/repo"])
        assert rc == 0
        out = capsys.readouterr().out
        assert "#42" in out

    @patch("cli.main.github_api.list_issues", return_value=[])
    def test_list_empty(self, mock_list, _with_token, capsys):
        rc = main(["issue", "list", "--repo", "o/r"])
        assert rc == 0
        out = capsys.readouterr().out
        assert "暂无" in out


class TestIssueGet:
    @patch("cli.main.github_api.get_issue", return_value=MOCK_ISSUE)
    def test_get_success(self, mock_get, _with_token, capsys):
        rc = main(["issue", "get", "--repo", "o/r", "--number", "42"])
        assert rc == 0
        out = capsys.readouterr().out
        assert "#42" in out


class TestIssueClose:
    @patch("cli.main.github_api.close_issue", return_value={**MOCK_ISSUE, "state": "closed"})
    def test_close_success(self, mock_close, _with_token, capsys):
        rc = main(["issue", "close", "--repo", "o/r", "--number", "42"])
        assert rc == 0
        out = capsys.readouterr().out
        assert "已关闭" in out


class TestAuthLogin:
    def test_login_mocked(self, capsys):
        rc = main(["auth", "login", "--mocked"])
        assert rc == 0
        out = capsys.readouterr().out
        assert "Mock" in out

    def test_login_no_client_id(self, capsys, monkeypatch):
        monkeypatch.delenv("GITHUB_CLIENT_ID", raising=False)
        rc = main(["auth", "login"])
        assert rc == 1


class TestAuthStatus:
    def test_status_no_token(self, capsys):
        rc = main(["auth", "status"])
        assert rc == 1

    def test_status_with_token(self, _with_token, capsys):
        rc = main(["auth", "status"])
        assert rc == 0
        out = capsys.readouterr().out
        assert "已认证" in out
