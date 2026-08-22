from apps.skills.api import _matches_market_search


def test_market_search_matches_display_slash_title():
    target = {
        "skill_id": "table-operator",
        "skill_key": "app:tabdata/table-operator",
        "name": "Tabular Writer",
        "description": "Edit schemas and records",
    }
    unrelated = {
        "skill_id": "browser-operator",
        "skill_key": "app:tabweb/browser-operator",
        "name": "Browser Operator",
        "description": "Operate browser sessions",
    }

    assert _matches_market_search(target, "/table-operator")
    assert not _matches_market_search(unrelated, "/table-operator")


def test_market_search_does_not_match_hidden_namespace():
    table_operator = {
        "skill_id": "table-operator",
        "skill_key": "app:tabdata/table-operator",
        "name": "Table Operator",
        "description": "表格结构与数据操作",
    }
    tabdoc = {
        "skill_id": "tabdoc-operator",
        "skill_key": "app:tabdoc/tabdoc-operator",
        "name": "TabDoc Operator",
        "description": "Create and manage documents",
    }

    assert not _matches_market_search(table_operator, "/tabd")
    assert _matches_market_search(tabdoc, "/tabd")


def test_market_search_slash_query_does_not_strip_slash_for_description():
    target = {
        "skill_id": "tabdoc-operator",
        "skill_key": "app:tabdoc/tabdoc-operator",
        "name": "TabDoc Operator",
        "description": "Create and manage documents",
    }
    unrelated = {
        "skill_id": "visualization/tabtin-widget",
        "skill_key": "platform:visualization/tabtin-widget",
        "name": "Tabtin Widget",
        "description": "长期可编辑产物可使用 TabDoc。",
    }

    assert _matches_market_search(target, "/tabdoc")
    assert not _matches_market_search(unrelated, "/tabdoc")


def test_market_search_uses_title_and_description_only():
    entry = {
        "name": "Weekly Report",
        "description": "Summarize progress",
        "tags": ["productivity"],
    }

    assert _matches_market_search(entry, "weekly")
    assert _matches_market_search(entry, "progress")
    assert not _matches_market_search(entry, "productivity")
