"""测试 github_api 模块——mock HTTP 调用。"""

import json
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread
from typing import Any, Dict, List, Optional

import pytest

from cli.github_api import (
    GitHubAPIError,
    close_issue,
    create_issue,
    get_issue,
    list_issues,
)


class MockGitHubHandler(BaseHTTPRequestHandler):
    """最小 GitHub API mock server。"""

    issues_db: List[Dict[str, Any]] = []
    next_number: int = 1

    def do_POST(self):
        if self.path.endswith("/issues"):
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            issue = {
                "number": MockGitHubHandler.next_number,
                "title": body.get("title", ""),
                "body": body.get("body", ""),
                "state": "open",
                "labels": [{"name": l} for l in body.get("labels", [])],
                "html_url": f"https://github.com/test/repo/issues/{MockGitHubHandler.next_number}",
            }
            MockGitHubHandler.issues_db.append(issue)
            MockGitHubHandler.next_number += 1
            self._respond(201, issue)
        else:
            self._respond(404, {"message": "Not found"})

    def do_GET(self):
        parts = self.path.split("?")[0].rstrip("/").split("/")
        if parts[-1] == "issues":
            self._respond(200, MockGitHubHandler.issues_db)
        elif len(parts) >= 2 and parts[-2] == "issues":
            try:
                num = int(parts[-1])
            except ValueError:
                self._respond(404, {"message": "Not found"})
                return
            for issue in MockGitHubHandler.issues_db:
                if issue["number"] == num:
                    self._respond(200, issue)
                    return
            self._respond(404, {"message": "Not found"})
        else:
            self._respond(404, {"message": "Not found"})

    def do_PATCH(self):
        parts = self.path.rstrip("/").split("/")
        if len(parts) >= 2 and parts[-2] == "issues":
            try:
                num = int(parts[-1])
            except ValueError:
                self._respond(404, {"message": "Not found"})
                return
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            for issue in MockGitHubHandler.issues_db:
                if issue["number"] == num:
                    issue["state"] = body.get("state", issue["state"])
                    self._respond(200, issue)
                    return
            self._respond(404, {"message": "Not found"})
        else:
            self._respond(404, {"message": "Not found"})

    def _respond(self, status: int, data: Any):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        pass  # suppress request logs


@pytest.fixture
def mock_server():
    MockGitHubHandler.issues_db = []
    MockGitHubHandler.next_number = 1
    server = HTTPServer(("127.0.0.1", 0), MockGitHubHandler)
    port = server.server_address[1]
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    server.shutdown()


TOKEN = "ghp_test_token_12345"


def test_create_issue(mock_server):
    result = create_issue(
        TOKEN, "owner/repo", "Test Issue",
        body="Test body", labels=["bug"],
        base_url=mock_server,
    )
    assert result["number"] == 1
    assert result["title"] == "Test Issue"
    assert result["state"] == "open"
    assert result["labels"][0]["name"] == "bug"


def test_list_issues_empty(mock_server):
    issues = list_issues(TOKEN, "owner/repo", base_url=mock_server)
    assert issues == []


def test_list_issues_with_data(mock_server):
    create_issue(TOKEN, "owner/repo", "Issue 1", base_url=mock_server)
    create_issue(TOKEN, "owner/repo", "Issue 2", base_url=mock_server)
    issues = list_issues(TOKEN, "owner/repo", base_url=mock_server)
    assert len(issues) == 2


def test_get_issue(mock_server):
    create_issue(TOKEN, "owner/repo", "Specific Issue", base_url=mock_server)
    issue = get_issue(TOKEN, "owner/repo", 1, base_url=mock_server)
    assert issue["title"] == "Specific Issue"


def test_get_issue_not_found(mock_server):
    with pytest.raises(GitHubAPIError) as exc_info:
        get_issue(TOKEN, "owner/repo", 999, base_url=mock_server)
    assert exc_info.value.status == 404


def test_close_issue(mock_server):
    create_issue(TOKEN, "owner/repo", "To Close", base_url=mock_server)
    result = close_issue(TOKEN, "owner/repo", 1, base_url=mock_server)
    assert result["state"] == "closed"


def test_close_nonexistent_issue(mock_server):
    with pytest.raises(GitHubAPIError) as exc_info:
        close_issue(TOKEN, "owner/repo", 999, base_url=mock_server)
    assert exc_info.value.status == 404


def test_create_issue_without_optional_fields(mock_server):
    result = create_issue(TOKEN, "owner/repo", "Minimal", base_url=mock_server)
    assert result["number"] == 1
    assert result["body"] == ""
    assert result["labels"] == []
