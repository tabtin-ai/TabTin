#!/usr/bin/env python3
"""
TabData 关联字段端到端验证脚本（仅新增数据，不删除）。

覆盖场景：
1. 创建源表/目标表、基础字段与记录
2. 创建 link 字段并校验 lookupFieldId 自动回退（优先 Label）
3. 设置关联值，校验 LinkRecord 与对称字段同步
4. 目标标题变更后的 link title 传播
5. relationship 从 ManyMany 收紧到 ManyOne 的截断行为
6. ManyOne 基数校验（超限写入应失败）
7. lookupFieldId 切换后的 title 重建
8. linkable-records 的 selected/only_selected 协议行为
9. OneMany 的“目标记录占用排除”行为

运行方式：
    cd apps/tabtin_django
    ../../venv/bin/python tools/link_field_e2e_suite.py
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


def _bootstrap_django() -> None:
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
    import django  # pylint: disable=import-outside-toplevel

    django.setup()

    from django.conf import settings  # pylint: disable=import-outside-toplevel

    # Django test client 默认 host 为 testserver，显式加入白名单避免 400。
    allowed_hosts = set(settings.ALLOWED_HOSTS or [])
    allowed_hosts.update({"testserver", "localhost", "127.0.0.1"})
    settings.ALLOWED_HOSTS = list(allowed_hosts)


@dataclass
class ApiResult:
    status: int
    body: Dict[str, Any]


class LinkFieldE2ESuite:
    def __init__(self) -> None:
        _bootstrap_django()

        from django.test import Client  # pylint: disable=import-outside-toplevel
        from django.contrib.auth import get_user_model  # pylint: disable=import-outside-toplevel
        from apps.users.auth.utils import generate_jwt_token  # pylint: disable=import-outside-toplevel
        from apps.tabtinspace.models import Agent, SpaceMembership  # pylint: disable=import-outside-toplevel

        self.Client = Client
        self.User = get_user_model()
        self.generate_jwt_token = generate_jwt_token
        self.Agent = Agent
        self.SpaceMembership = SpaceMembership

        self.client = Client(HTTP_HOST="localhost")
        self.results: List[Tuple[str, bool, str]] = []
        self.run_id = uuid.uuid4().hex[:8]
        self.base_path = "/api/tabdata"

        self.user = None
        self.organization_id: Optional[str] = None
        self.project_id: Optional[str] = None
        self.token: Optional[str] = None

    def _record(self, name: str, passed: bool, detail: str = "") -> None:
        self.results.append((name, passed, detail))
        status = "PASS" if passed else "FAIL"
        print(f"[{status}] {name}")
        if detail:
            print(f"       {detail}")

    def _require(self, cond: bool, message: str) -> None:
        if not cond:
            raise AssertionError(message)

    def _auth_headers(self) -> Dict[str, str]:
        self._require(bool(self.token), "token 未初始化")
        return {"HTTP_AUTHORIZATION": f"Bearer {self.token}"}

    def _request(
        self,
        method: str,
        path: str,
        *,
        data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> ApiResult:
        headers = self._auth_headers()
        full_path = f"{self.base_path}{path}"

        if method == "GET":
            resp = self.client.get(full_path, data=params, **headers)
        elif method == "POST":
            resp = self.client.post(
                full_path,
                data=json.dumps(data or {}),
                content_type="application/json",
                **headers,
            )
        elif method == "PUT":
            resp = self.client.put(
                full_path,
                data=json.dumps(data or {}),
                content_type="application/json",
                **headers,
            )
        elif method == "DELETE":
            resp = self.client.delete(full_path, **headers)
        else:
            raise ValueError(f"不支持的方法: {method}")

        try:
            body = resp.json()
        except Exception:  # noqa: BLE001
            body = {"raw": resp.content.decode("utf-8", errors="replace")[:1000]}

        return ApiResult(status=resp.status_code, body=body)

    def _pick_owner_user(self) -> None:
        """
        选择已有 owner 用户，避免额外创建用户/项目导致系统表噪音。
        """
        users = self.User.objects.all().order_by("-date_joined")
        for user in users:
            agent_ids = self.Agent.objects.filter(
                user_id=user.id,
                is_active=True,
            ).values_list("id", flat=True)
            membership = (
                self.SpaceMembership.objects.filter(
                    agent_id__in=agent_ids,
                    role="owner",
                    is_active=True,
                )
                .select_related("project")
                .first()
            )
            if membership:
                self.user = user
                self.project_id = str(membership.project_id)
                self.organization_id = str(membership.project.organization_id)
                self.token = self.generate_jwt_token(user, expire_hours=2, token_type="access")
                self._record(
                    "选取测试账号与项目",
                    True,
                    f"user={user.email or user.username}, organization={self.organization_id}, project={self.project_id}",
                )
                return

        raise RuntimeError("未找到可用的 owner 用户，请先在环境中准备可操作项目")

    @staticmethod
    def _success_data(result: ApiResult) -> Dict[str, Any]:
        body = result.body or {}
        return body.get("data") if isinstance(body, dict) else {}

    def _create_table(self, name: str) -> str:
        result = self._request(
            "POST",
            "/tables",
            data={
                "project_id": self.project_id,
                "name": name,
                "description": "link-field-e2e",
                "use_default_fields": False,
            },
        )
        self._require(result.status == 201, f"创建表失败: status={result.status}, body={result.body}")
        table_id = self._success_data(result).get("id")
        self._require(bool(table_id), f"创建表返回缺少 id: {result.body}")
        return str(table_id)

    def _create_field(
        self,
        table_id: str,
        *,
        name: str,
        field_type: str,
        options: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "table_id": table_id,
            "name": name,
            "field_type": field_type,
        }
        if options is not None:
            payload["options"] = options

        result = self._request("POST", "/fields", data=payload)
        self._require(result.status == 201, f"创建字段失败: status={result.status}, body={result.body}")
        data = self._success_data(result)
        self._require(bool(data and data.get("id")), f"创建字段返回异常: {result.body}")
        return data

    def _create_record(self, table_id: str, fields_by_id: Dict[str, Any]) -> Dict[str, Any]:
        result = self._request(
            "POST",
            "/records",
            data={
                "table_id": table_id,
                "fields": fields_by_id,
                "fieldKeyType": "id",
            },
        )
        self._require(result.status == 201, f"创建记录失败: status={result.status}, body={result.body}")
        data = self._success_data(result)
        self._require(bool(data and data.get("id")), f"创建记录返回异常: {result.body}")
        return data

    def _update_record(self, record_id: str, fields_by_id: Dict[str, Any]) -> ApiResult:
        return self._request(
            "PUT",
            f"/records/{record_id}",
            data={
                "fields": fields_by_id,
                "fieldKeyType": "id",
            },
        )

    def _fetch_record(self, record_id: str) -> Dict[str, Any]:
        result = self._request(
            "GET",
            f"/records/{record_id}",
            params={"fieldKeyType": "id"},
        )
        self._require(result.status == 200, f"获取记录失败: status={result.status}, body={result.body}")
        data = self._success_data(result)
        self._require(bool(data and data.get("id")), f"获取记录返回异常: {result.body}")
        return data

    def run(self) -> int:
        from apps.tabdata.models import LinkRecord, TableField  # pylint: disable=import-outside-toplevel

        self._pick_owner_user()

        source_table_id = self._create_table(f"E2E-Link-Source-{self.run_id}")
        target_table_id = self._create_table(f"E2E-Link-Target-{self.run_id}")
        self._record("创建源表/目标表", True, f"source={source_table_id}, target={target_table_id}")

        source_name = self._create_field(source_table_id, name="Name", field_type="text")
        target_name = self._create_field(target_table_id, name="Name", field_type="text")
        target_label = self._create_field(target_table_id, name="Label", field_type="text")
        target_code = self._create_field(target_table_id, name="Code", field_type="text")
        self._record(
            "创建基础字段",
            True,
            f"source_name={source_name['id']}, target_name={target_name['id']}, label={target_label['id']}, code={target_code['id']}",
        )

        source_record = self._create_record(source_table_id, {source_name["id"]: "Source-1"})
        target_record_a = self._create_record(
            target_table_id,
            {
                target_name["id"]: "Target-A",
                target_label["id"]: "Label-A",
                target_code["id"]: "A001",
            },
        )
        target_record_b = self._create_record(
            target_table_id,
            {
                target_name["id"]: "Target-B",
                target_label["id"]: "Label-B",
                target_code["id"]: "B001",
            },
        )
        self._record(
            "创建测试记录",
            True,
            f"source_record={source_record['id']}, target_a={target_record_a['id']}, target_b={target_record_b['id']}",
        )

        link_field_data = self._create_field(
            source_table_id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": target_table_id,
                "relationship": "ManyMany",
                "isOneWay": False,
            },
        )
        link_field_id = str(link_field_data["id"])
        link_opts = link_field_data.get("options") or {}
        sym_field_id = str(link_opts.get("symmetricFieldId") or "")
        lookup_field_id = str(link_opts.get("lookupFieldId") or "")

        self._record(
            "创建 link 字段并自动回填 lookup/symmetric",
            bool(sym_field_id and lookup_field_id == str(target_label["id"])),
            f"lookupFieldId={lookup_field_id}, symmetricFieldId={sym_field_id}",
        )

        update_result = self._update_record(
            str(source_record["id"]),
            {
                link_field_id: [str(target_record_a["id"]), str(target_record_b["id"])],
            },
        )
        self._record(
            "写入 link 多值关联（ManyMany）",
            update_result.status == 200,
            f"status={update_result.status}",
        )
        self._require(update_result.status == 200, f"设置 link 失败: {update_result.body}")

        source_after_link = self._fetch_record(str(source_record["id"]))
        source_link_value = (source_after_link.get("fields") or {}).get(link_field_id)
        link_count = LinkRecord.objects.filter(link_field_id=link_field_id).count()
        sym_count = LinkRecord.objects.filter(link_field_id=sym_field_id).count() if sym_field_id else 0
        self._record(
            "LinkRecord 与对称字段同步",
            isinstance(source_link_value, list) and len(source_link_value) == 2 and link_count == 2 and sym_count == 2,
            f"source_cell={source_link_value}, link_count={link_count}, sym_count={sym_count}",
        )

        update_target_title = self._update_record(
            str(target_record_a["id"]),
            {str(target_label["id"]): "Label-A-Updated"},
        )
        self._require(update_target_title.status == 200, f"更新目标标题失败: {update_target_title.body}")
        source_after_title_change = self._fetch_record(str(source_record["id"]))
        link_value_after_title = (source_after_title_change.get("fields") or {}).get(link_field_id) or []
        title_map = {item.get("id"): item.get("title") for item in link_value_after_title if isinstance(item, dict)}
        self._record(
            "目标标题变化触发 link title 传播",
            title_map.get(str(target_record_a["id"])) == "Label-A-Updated",
            f"title_map={title_map}",
        )

        link_field_obj = TableField.objects.get(id=link_field_id)
        many_one_options = dict(link_field_obj.config or {})
        many_one_options["relationship"] = "ManyOne"
        update_field_result = self._request(
            "PUT",
            f"/fields/{link_field_id}",
            data={"options": many_one_options},
        )
        self._require(update_field_result.status == 200, f"关系收紧失败: {update_field_result.body}")
        source_after_narrow = self._fetch_record(str(source_record["id"]))
        narrowed_value = (source_after_narrow.get("fields") or {}).get(link_field_id)
        narrowed_link_count = LinkRecord.objects.filter(link_field_id=link_field_id).count()
        self._record(
            "ManyMany -> ManyOne 截断生效",
            isinstance(narrowed_value, dict) and narrowed_link_count == 1,
            f"narrowed_value={narrowed_value}, narrowed_link_count={narrowed_link_count}",
        )

        violate_result = self._update_record(
            str(source_record["id"]),
            {
                link_field_id: [str(target_record_a["id"]), str(target_record_b["id"])],
            },
        )
        violate_msg = (violate_result.body or {}).get("message", "")
        self._record(
            "ManyOne 基数超限返回校验错误",
            violate_result.status == 400
            and ("最多关联 1 条记录" in violate_msg or "值类型不正确" in violate_msg),
            f"status={violate_result.status}, message={violate_msg}",
        )

        link_field_obj.refresh_from_db()
        lookup_switch_options = dict(link_field_obj.config or {})
        lookup_switch_options["lookupFieldId"] = str(target_code["id"])
        switch_lookup_result = self._request(
            "PUT",
            f"/fields/{link_field_id}",
            data={"options": lookup_switch_options},
        )
        self._require(switch_lookup_result.status == 200, f"切换 lookupFieldId 失败: {switch_lookup_result.body}")
        source_after_lookup_switch = self._fetch_record(str(source_record["id"]))
        lookup_switched_value = (source_after_lookup_switch.get("fields") or {}).get(link_field_id)
        current_title = lookup_switched_value.get("title") if isinstance(lookup_switched_value, dict) else None
        self._record(
            "切换 lookupFieldId 后 title 重建",
            current_title == "A001",
            f"cell={lookup_switched_value}",
        )

        selected_ids = f"{target_record_b['id']},{target_record_a['id']}"
        selected_only_result = self._request(
            "GET",
            f"/tables/{source_table_id}/fields/{link_field_id}/linkable-records",
            params={
                "selected_record_ids": selected_ids,
                "only_selected": "true",
                "page": 1,
                "page_size": 10,
            },
        )
        selected_only_data = self._success_data(selected_only_result) or {}
        selected_only_records = selected_only_data.get("records") or []
        selected_only_ids = [item.get("id") for item in selected_only_records]
        self._record(
            "linkable-records only_selected 顺序保持",
            selected_only_result.status == 200 and selected_only_ids == [str(target_record_b["id"]), str(target_record_a["id"])],
            f"ids={selected_only_ids}",
        )

        candidate_result = self._request(
            "GET",
            f"/tables/{source_table_id}/fields/{link_field_id}/linkable-records",
            params={
                "selected_record_ids": f"{target_record_a['id']},{target_record_b['id']}",
                "page": 1,
                "page_size": 10,
            },
        )
        candidate_data = self._success_data(candidate_result) or {}
        self._record(
            "linkable-records 候选模式排除 selected_record_ids",
            candidate_result.status == 200 and (candidate_data.get("total") == 0),
            f"total={candidate_data.get('total')}",
        )

        one_many_field = self._create_field(
            source_table_id,
            name="RelOneMany",
            field_type="link",
            options={
                "foreignTableId": target_table_id,
                "relationship": "OneMany",
                "isOneWay": True,
            },
        )
        one_many_field_id = str(one_many_field["id"])
        source_record_2 = self._create_record(source_table_id, {source_name["id"]: "Source-2"})
        occupy_result = self._update_record(
            str(source_record["id"]),
            {one_many_field_id: [str(target_record_b["id"])]},
        )
        self._require(occupy_result.status == 200, f"OneMany 占用初始化失败: {occupy_result.body}")

        occupied_filter_result = self._request(
            "GET",
            f"/tables/{source_table_id}/fields/{one_many_field_id}/linkable-records",
            params={
                "exclude_record_id": str(source_record_2["id"]),
                "page": 1,
                "page_size": 20,
            },
        )
        occupied_data = self._success_data(occupied_filter_result) or {}
        occupied_ids = [item.get("id") for item in (occupied_data.get("records") or [])]
        self._record(
            "OneMany 模式过滤已被占用目标记录",
            occupied_filter_result.status == 200 and str(target_record_b["id"]) not in occupied_ids,
            f"occupied_filtered_ids={occupied_ids}",
        )

        passed_count = sum(1 for _, passed, _ in self.results if passed)
        total_count = len(self.results)
        print("\n========== Link 字段 E2E 汇总 ==========")
        print(f"RUN_ID: {self.run_id}")
        print(f"成功: {passed_count}/{total_count}")
        print(f"测试数据前缀: E2E-Link-*-{self.run_id}（仅新增，未删除）")

        return 0 if passed_count == total_count else 1


def main() -> int:
    suite = LinkFieldE2ESuite()
    return suite.run()


if __name__ == "__main__":
    sys.exit(main())
