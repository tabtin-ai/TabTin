"""飞书树浏览 client 归一化单测（不打真实 OpenAPI）。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.integrations_feishu.client import FeishuAPIError, FeishuClient
from apps.integrations_feishu.constants import WIKI_SPACE_MY_LIBRARY


class TenantDomainTests(SimpleTestCase):
    def test_get_tenant_domain_uses_app_identity(self):
        client = FeishuClient()
        with patch.object(
            client,
            "validate_tenant_credentials",
            return_value={"tenant_access_token": "tenant-token"},
        ), patch.object(
            client,
            "_get_json",
            return_value={
                "data": {
                    "tenant": {
                        "tenant_key": "tenant-key",
                        "domain": "Tenant.Feishu.Cn",
                    },
                },
            },
        ) as get_json:
            tenant = client.get_tenant_domain("app-id", "app-secret")

        self.assertEqual(tenant, {
            "tenant_key": "tenant-key",
            "domain": "tenant.feishu.cn",
        })
        get_json.assert_called_once_with(
            f"{client.api_base}/open-apis/tenant/v2/tenant/query",
            access_token="tenant-token",
        )


class DriveRootMetaTests(SimpleTestCase):
    def test_get_my_space_root_folder_token_reads_data_token(self):
        client = FeishuClient()
        with patch.object(
            client,
            "_get_json",
            return_value={"code": 0, "data": {"token": "fldRoot", "id": "1"}},
        ):
            self.assertEqual(client.get_my_space_root_folder_token("tok"), "fldRoot")

    def test_get_my_space_root_folder_token_propagates_permission_error(self):
        from apps.integrations_feishu.client import FeishuAPIError

        client = FeishuClient()
        with patch.object(
            client,
            "_get_json",
            side_effect=FeishuAPIError(
                "need drive:drive.metadata:readonly",
                code=99991679,
            ),
        ):
            with self.assertRaises(FeishuAPIError):
                client.get_my_space_root_folder_token("tok")


class DriveChildrenNormalizeTests(SimpleTestCase):
    def test_list_drive_folder_children_keeps_folders_and_leaves(self):
        client = FeishuClient()
        fake = {
            "data": {
                "files": [
                    {"token": "fld1", "name": "项目", "type": "folder"},
                    {"token": "basexx", "name": "订单库", "type": "bitable"},
                    {"token": "docxx", "name": "说明", "type": "docx"},
                    {"token": "sht1", "name": "表", "type": "sheet"},
                ],
                "has_more": False,
            }
        }
        with patch.object(client, "_get_json", return_value=fake):
            page = client.list_drive_folder_children("tok", "fldRoot")
        kinds = {row["node_kind"] for row in page["items"]}
        self.assertEqual(kinds, {"folder", "bitable", "docx"})
        folder = next(row for row in page["items"] if row["node_kind"] == "folder")
        self.assertFalse(folder["selectable"])
        self.assertTrue(folder["expandable"])
        bitable = next(row for row in page["items"] if row["node_kind"] == "bitable")
        self.assertTrue(bitable["selectable"])
        self.assertEqual(bitable["token"], "basexx")

    def test_missing_resource_names_never_fall_back_to_tokens(self):
        client = FeishuClient()
        fake = {
            "data": {
                "files": [
                    {"token": "fld1", "name": "", "type": "folder"},
                    {"token": "basexx", "name": "", "type": "bitable"},
                    {"token": "docxx", "name": "", "type": "docx"},
                ],
                "has_more": False,
            }
        }
        with patch.object(client, "_get_json", return_value=fake):
            page = client.list_drive_folder_children("tok", "fldRoot")

        names = {row["node_kind"]: row["name"] for row in page["items"]}
        self.assertEqual(names["folder"], "未命名文件夹")
        self.assertEqual(names["bitable"], "未命名多维表")
        self.assertEqual(names["docx"], "未命名文档")
        self.assertNotIn("basexx", names.values())
        self.assertNotIn("docxx", names.values())


class WikiNormalizeTests(SimpleTestCase):
    def test_list_wiki_spaces_prepends_my_library(self):
        client = FeishuClient()
        fake = {
            "data": {
                "items": [{"space_id": "7123", "name": "团队库"}],
                "has_more": False,
            }
        }
        with patch.object(client, "_get_json", return_value=fake):
            page = client.list_wiki_spaces("tok")
        self.assertEqual(page["items"][0]["space_id"], WIKI_SPACE_MY_LIBRARY)
        self.assertEqual(page["items"][0]["name"], "我的文档库")
        self.assertEqual(page["items"][1]["space_id"], "7123")

    def test_normalize_wiki_node_selectable_docx(self):
        client = FeishuClient()
        node = client._normalize_wiki_node(
            {
                "node_token": "wikN",
                "title": "周报",
                "obj_type": "docx",
                "obj_token": "docxABC",
                "has_child": False,
            },
            space_id=WIKI_SPACE_MY_LIBRARY,
        )
        self.assertTrue(node["selectable"])
        self.assertEqual(node["import_kind"], "docx")
        self.assertEqual(node["token"], "docxABC")
        self.assertFalse(node["expandable"])

    def test_normalize_wiki_node_bitable_expandable(self):
        client = FeishuClient()
        node = client._normalize_wiki_node(
            {
                "node_token": "wikB",
                "title": "需求库",
                "obj_type": "bitable",
                "obj_token": "baseABC",
                "has_child": False,
            },
            space_id="7123",
        )
        self.assertTrue(node["selectable"])
        self.assertTrue(node["expandable"])
        self.assertEqual(node["node_kind"], "bitable")

    def test_normalize_unnamed_wiki_doc_uses_readable_fallback(self):
        client = FeishuClient()
        node = client._normalize_wiki_node(
            {
                "node_token": "wikN",
                "title": "",
                "obj_type": "docx",
                "obj_token": "docxABC",
                "has_child": True,
            },
            space_id=WIKI_SPACE_MY_LIBRARY,
        )
        self.assertEqual(node["name"], "未命名文档")
        self.assertTrue(node["selectable"])
        self.assertTrue(node["expandable"])


class ResourceSearchNormalizeTests(SimpleTestCase):
    def test_search_limits_results_to_requested_owners(self):
        client = FeishuClient()
        with patch.object(
            client,
            "_post_json",
            return_value={"data": {"docs_entities": []}},
        ) as search:
            client.list_importable_resources(
                "tok",
                search_key="项目",
                kinds=["bitable", "docx"],
                owner_ids=["ou_current_user"],
            )

        self.assertEqual(
            search.call_args.kwargs["json"]["doc_filter"]["creator_ids"],
            ["ou_current_user"],
        )
        self.assertEqual(
            search.call_args.kwargs["json"]["wiki_filter"]["creator_ids"],
            ["ou_current_user"],
        )

    def test_search_excludes_unsupported_entities_even_when_doc_type_is_importable(
        self,
    ):
        client = FeishuClient()
        fake = {
            "data": {
                "res_units": [
                    {
                        "title_highlighted": "Project application",
                        "entity_type": "APPLICATION",
                        "result_meta": {
                            "token": "applicationResource",
                            "doc_types": "BITABLE",
                            "is_cross_tenant": False,
                            "url": "https://tenant.feishu.cn/base/applicationResource",
                        },
                    },
                    {
                        "title_highlighted": "Project base",
                        "entity_type": "UNKNOWN",
                        "result_meta": {
                            "token": "unknownResource",
                            "doc_types": "BITABLE",
                            "is_cross_tenant": False,
                            "url": "https://tenant.feishu.cn/base/unknownResource",
                        },
                    },
                    {
                        "title_highlighted": "Project base",
                        "entity_type": "DOC",
                        "result_meta": {
                            "token": "baseResource",
                            "doc_types": "BITABLE",
                            "is_cross_tenant": False,
                            "url": "https://tenant.feishu.cn/base/baseResource",
                        },
                    },
                ],
                "has_more": False,
            }
        }

        with patch.object(client, "_post_json", return_value=fake):
            resources = client.list_importable_resources(
                "tok",
                search_key="Project",
                kinds=["bitable", "docx"],
            )

        self.assertEqual(resources, [{
            "token": "baseResource",
            "name": "Project base",
            "kind": "bitable",
        }])

    def test_search_excludes_cross_tenant_resources(self):
        client = FeishuClient()
        fake = {
            "data": {
                "res_units": [
                    {
                        "title_highlighted": "<h>项目</h>多维表",
                        "entity_type": "DOC",
                        "result_meta": {
                            "token": "baseInternal",
                            "doc_types": "BITABLE",
                            "is_cross_tenant": False,
                            "url": "https://tenant.feishu.cn/base/baseInternal",
                        },
                    },
                    {
                        "title_highlighted": "外部<h>项目</h>文档",
                        "entity_type": "DOC",
                        "result_meta": {
                            "token": "docxExternal",
                            "doc_types": "DOCX",
                            "is_cross_tenant": True,
                        },
                    },
                    {
                        "title_highlighted": "未知企业项目文档",
                        "entity_type": "DOC",
                        "result_meta": {
                            "token": "docxUnknownTenant",
                            "doc_types": "DOCX",
                        },
                    },
                    {
                        "title_highlighted": "企业知识库项目文档",
                        "entity_type": "WIKI",
                        "result_meta": {
                            "token": "wikiInternal",
                            "doc_types": "DOCX",
                            "url": "https://tenant.feishu.cn/wiki/wikiInternal",
                        },
                    },
                    {
                        "title_highlighted": "未知企业知识库文档",
                        "entity_type": "WIKI",
                        "result_meta": {
                            "token": "wikiUnknownTenant",
                            "doc_types": "DOCX",
                            "url": "https://external.feishu.cn/wiki/wikiUnknownTenant",
                        },
                    },
                ],
                "has_more": False,
            }
        }

        with patch.object(client, "_post_json", return_value=fake) as search, patch.object(
            client,
            "get_wiki_node",
            return_value={
                "token": "docxInternal",
                "import_kind": "docx",
            },
        ) as resolve_wiki:
            resources = client.list_importable_resources(
                "tok",
                search_key="项目",
                kinds=["bitable", "docx"],
            )

        self.assertEqual(resources, [
            {
                "token": "baseInternal",
                "name": "项目多维表",
                "kind": "bitable",
            },
            {
                "token": "docxInternal",
                "name": "企业知识库项目文档",
                "kind": "docx",
            },
        ])
        resolve_wiki.assert_called_once_with("tok", "wikiInternal")
        self.assertIn(
            "/open-apis/search/v2/doc_wiki/search",
            search.call_args.args[0],
        )
        self.assertEqual(
            search.call_args.kwargs["json"]["doc_filter"]["doc_types"],
            ["BITABLE", "DOCX"],
        )
        self.assertTrue(
            search.call_args.kwargs["json"]["doc_filter"]["only_title"],
        )

    def test_search_can_defer_wiki_resolution_for_interactive_results(self):
        client = FeishuClient()
        fake = {
            "data": {
                "res_units": [
                    {
                        "title_highlighted": "Project document",
                        "entity_type": "DOC",
                        "result_meta": {
                            "token": "docxInternal",
                            "doc_types": "DOCX",
                            "is_cross_tenant": False,
                            "url": "https://tenant.feishu.cn/docx/docxInternal",
                        },
                    },
                    {
                        "title_highlighted": "Wiki project document",
                        "entity_type": "WIKI",
                        "result_meta": {
                            "token": "wikiInternal",
                            "doc_types": "DOCX",
                            "url": "https://tenant.feishu.cn/wiki/wikiInternal",
                        },
                    },
                ],
                "has_more": False,
            }
        }

        with patch.object(client, "_post_json", return_value=fake), patch.object(
            client,
            "get_wiki_node",
        ) as resolve_wiki:
            resources = client.list_importable_resources(
                "tok",
                search_key="project",
                kinds=["docx"],
                defer_wiki_resolution=True,
            )

        self.assertEqual(resources, [
            {
                "token": "docxInternal",
                "name": "Project document",
                "kind": "docx",
            },
            {
                "token": "wikiInternal",
                "name": "Wiki project document",
                "kind": "docx",
                "wiki_node_token": "wikiInternal",
            },
        ])
        resolve_wiki.assert_not_called()

    def test_wiki_only_search_uses_provider_tenant_domain(self):
        client = FeishuClient()
        wiki_page = {
            "data": {
                "res_units": [{
                    "title_highlighted": "Wiki-only document",
                    "entity_type": "WIKI",
                    "result_meta": {
                        "token": "wikiInternal",
                        "doc_types": "DOCX",
                        "url": "https://tenant.feishu.cn/wiki/wikiInternal",
                    },
                }],
                "has_more": False,
            },
        }
        with patch.object(
            client,
            "_post_json",
            return_value=wiki_page,
        ) as search, patch.object(client, "get_wiki_node") as resolve_wiki:
            resources = client.list_importable_resources(
                "tok",
                search_key="Wiki-only",
                kinds=["docx"],
                defer_wiki_resolution=True,
                max_search_pages=1,
                tenant_host_resolver=lambda: "tenant.feishu.cn",
            )

        self.assertEqual(resources, [{
            "token": "wikiInternal",
            "name": "Wiki-only document",
            "kind": "docx",
            "wiki_node_token": "wikiInternal",
        }])
        self.assertEqual(search.call_count, 1)
        resolve_wiki.assert_not_called()

    def test_wiki_only_search_excludes_other_tenant_domain(self):
        client = FeishuClient()
        wiki_page = {
            "data": {
                "res_units": [{
                    "title_highlighted": "External Wiki",
                    "entity_type": "WIKI",
                    "result_meta": {
                        "token": "wikiExternal",
                        "doc_types": "DOCX",
                        "url": "https://other.feishu.cn/wiki/wikiExternal",
                    },
                }],
                "has_more": False,
            },
        }

        with patch.object(client, "_post_json", return_value=wiki_page):
            resources = client.list_importable_resources(
                "tok",
                search_key="External",
                kinds=["docx"],
                defer_wiki_resolution=True,
                max_search_pages=1,
                tenant_host_resolver=lambda: "tenant.feishu.cn",
            )

        self.assertEqual(resources, [])

    def test_single_kind_search_does_not_guess_missing_type(self):
        client = FeishuClient()
        fake = {
            "data": {
                "res_units": [
                    {
                        "title_highlighted": "项目周报",
                        "entity_type": "DOC",
                        "result_meta": {
                            "token": "docxABC",
                            "doc_types": "DOCX",
                            "is_cross_tenant": False,
                        },
                    },
                    {
                        "title_highlighted": "项目周报.xmind",
                        "entity_type": "DOC",
                        "result_meta": {
                            "token": "fileXYZ",
                            "doc_types": "",
                            "is_cross_tenant": False,
                        },
                    },
                ],
                "has_more": False,
            }
        }
        with patch.object(client, "_post_json", return_value=fake):
            resources = client.list_importable_resources(
                "tok",
                search_key="项目周报",
                kinds=["docx"],
            )

        self.assertEqual(resources, [{
            "token": "docxABC",
            "name": "项目周报",
            "kind": "docx",
        }])

    def test_search_matches_normalized_name_only(self):
        client = FeishuClient()
        fake = {
            "data": {
                "res_units": [
                    {
                        "title_highlighted": "其他文档",
                        "entity_type": "DOC",
                        "result_meta": {
                            "token": "keyword-in-token",
                            "doc_types": "DOCX",
                            "is_cross_tenant": False,
                        },
                    },
                    {
                        "title_highlighted": "关键词方案",
                        "entity_type": "DOC",
                        "result_meta": {
                            "token": "docxABC",
                            "doc_types": "DOCX",
                            "is_cross_tenant": False,
                        },
                    },
                ],
                "has_more": False,
            }
        }
        with patch.object(client, "_post_json", return_value=fake):
            resources = client.list_importable_resources(
                "tok",
                search_key="关键词",
                kinds=["bitable", "docx"],
            )

        self.assertEqual([row["token"] for row in resources], ["docxABC"])

    def test_search_includes_untitled_display_names(self):
        client = FeishuClient()

        def fake_search(_url, **kwargs):
            if kwargs["json"]["query"] == "":
                return {
                    "data": {
                        "res_units": [
                            {
                                "title_highlighted": "",
                                "entity_type": "DOC",
                                "result_meta": {
                                    "token": "docxBlank",
                                    "doc_types": "DOCX",
                                    "is_cross_tenant": False,
                                },
                            },
                            {
                                "title_highlighted": "",
                                "entity_type": "DOC",
                                "result_meta": {
                                    "token": "baseBlank",
                                    "doc_types": "BITABLE",
                                    "is_cross_tenant": False,
                                },
                            },
                            {
                                "title_highlighted": "",
                                "entity_type": "DOC",
                                "result_meta": {
                                    "token": "externalBlank",
                                    "doc_types": "DOCX",
                                    "is_cross_tenant": True,
                                },
                            },
                            {
                                "title_highlighted": "普通文档",
                                "entity_type": "DOC",
                                "result_meta": {
                                    "token": "namedDoc",
                                    "doc_types": "DOCX",
                                    "is_cross_tenant": False,
                                },
                            },
                        ],
                        "has_more": False,
                    }
                }
            return {
                "data": {
                    "res_units": [
                        {
                            "title_highlighted": "普通文档",
                            "entity_type": "DOC",
                            "result_meta": {
                                "token": "unrelatedDoc",
                                "doc_types": "DOCX",
                                "is_cross_tenant": False,
                            },
                        },
                    ],
                    "has_more": False,
                }
            }

        with patch.object(client, "_post_json", side_effect=fake_search) as search:
            resources = client.list_importable_resources(
                "tok",
                search_key="\u672a\u547d\u540d",
                kinds=["bitable", "docx"],
            )

        self.assertEqual(resources, [
            {"token": "docxBlank", "name": "\u672a\u547d\u540d\u6587\u6863", "kind": "docx"},
            {"token": "baseBlank", "name": "\u672a\u547d\u540d\u591a\u7ef4\u8868", "kind": "bitable"},
        ])
        catalog_call = next(
            call for call in search.call_args_list
            if call.kwargs["json"]["query"] == ""
        )
        self.assertEqual(catalog_call.kwargs["json"]["query"], "")
        self.assertIn("wiki_filter", catalog_call.kwargs["json"])

    def test_untitled_docs_catalog_reads_every_page(self):
        client = FeishuClient()
        page_tokens = []

        def fake_search(_url, **kwargs):
            page_token = kwargs["json"].get("page_token")
            page_tokens.append(page_token)
            if page_token is None:
                return {
                    "data": {
                        "res_units": [
                            {
                                "title_highlighted": f"文档 {index}",
                                "entity_type": "DOC",
                                "result_meta": {
                                    "token": f"named-{index}",
                                    "doc_types": "DOCX",
                                    "is_cross_tenant": False,
                                },
                            }
                            for index in range(20)
                        ],
                        "has_more": True,
                        "page_token": "next-page",
                    }
                }
            return {
                "data": {
                    "res_units": [
                        {
                            "title_highlighted": "",
                            "entity_type": "DOC",
                            "result_meta": {
                                "token": "blank-doc",
                                "doc_types": "DOCX",
                                "is_cross_tenant": False,
                            },
                        },
                    ],
                    "has_more": False,
                }
            }

        with patch.object(client, "_post_json", side_effect=fake_search):
            resources = client._list_untitled_docs_search_resources(
                "tok",
                kinds=["docx"],
            )

        self.assertEqual(page_tokens, [None, "next-page"])
        self.assertEqual(resources, [
            {"token": "blank-doc", "name": "未命名文档", "kind": "docx"},
        ])

    def test_untitled_catalog_marks_search_failure(self):
        client = FeishuClient()
        with patch.object(
            client,
            "_list_untitled_docs_search_resources",
            side_effect=FeishuAPIError("rate limited"),
        ):
            catalog = client.list_untitled_resource_catalog("tok")

        self.assertFalse(catalog.complete)
        self.assertEqual(catalog.failed_sources, ("search",))
        self.assertEqual(catalog.resources, [])


class WikiResolveEnrichTests(SimpleTestCase):
    def test_enrich_wiki_to_docx(self):
        from apps.integrations_feishu.url_resolve import (
            enrich_resolved_with_access,
            parse_feishu_resource_url,
        )

        client = MagicMock()
        client.get_wiki_node.return_value = {
            "selectable": True,
            "import_kind": "docx",
            "token": "docxReal",
            "name": "解析后的文档",
        }
        client.get_drive_file_name.return_value = "解析后的文档"
        parsed = parse_feishu_resource_url("https://x.feishu.cn/wiki/WikiNodeTok")
        out = enrich_resolved_with_access(client, "access", parsed)
        self.assertEqual(out["kind"], "docx")
        self.assertEqual(out["token"], "docxReal")
        self.assertTrue(out["accessible"])
