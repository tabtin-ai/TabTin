package table

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// registerShareCommands 挂载 `table share <子命令>` + `table share shared-with-me`。
//
// 后端落在 apps/tabtin_django/apps/tabdata/api_share.py（router 在
// tabtin/urls_deferred.py:90-91 以 /tabdata 挂载），故完整路径前缀是
// /api/tabdata/...：
//   - set              POST   /tables/{table_id}/share       → create_data_share
//   - get              GET    /tables/{table_id}/share       → get_data_share
//   - off              DELETE /tables/{table_id}/share       → close_data_share
//   - shared-with-me   GET    /shared-with-me                → list_shared_with_me_endpoint
//
// 与 `doc share`（apps/tabtin_django/apps/tabdoc/api_share.py）的关键差异——
// **千万不要照抄 doc 的 public/organization 语义**：
//  1. share_type 是 **data / organization**（不是 public/organization）。
//     CreateDataShareRequest.share_type 默认 "organization"；校验白名单
//     data|organization。CLI set 仍用 Required:true 强制显式传，避免误建公开链接。
//  2. 扩大到 data 须 body.acknowledge_public_exposure=true，否则后端 409
//     PUBLIC_EXPOSURE_ACK_REQUIRED。CLI 暴露 --acknowledge-public-exposure，
//     并保留 Validate 本地门禁（与 doc share 同款）。
//  3. get 省略 --share-type 时返回当前有效分享（data / organization 互斥；
//     历史并存时优先 data）。也可显式传 data|organization。
//  4. off 端点 share_type 默认 "data"，仍暴露 --share-type（data|organization）。
//  5. organization 目标组织：与 doc share 完全同款坑——CLI 不提供命令级
//     --organization-id（会跟全局 persistent flag 撞名），set 命令 Long 里
//     说明改用全局 --organization-id。
//  6. 命名与 `view form-share-*`（表单分享，公开填表入口）严格分离。
//  7. 表侧无 refresh API——要换链接只能 off 再 set。
func registerShareCommands(parent *cobra.Command, f *cmdutil.Factory) {
	shareCmd := &cobra.Command{
		Use:   "share",
		Short: "表格数据分享管理（设置 / 查看 / 关闭；只读外链，非表单分享）",
		Long: `管理表格数据的只读分享——与 view form-share-*（可填写的公开表单入口）
是两套完全独立的系统，命名故意分开，别搞混。

两种分享类型（set 的 --share-type 必须显式传，避免误建公开链接）：
  data          免登录只读链接：任何拿到 share_id 短链的人都能访问表格数据
                （可加 --password / --expire-hours 收口；受 --allow-download 控制是否能导出）
  organization  组织限定：仅对应 organization 的成员登录后可访问；目标组织由全局 --organization-id 指定

子命令：
  tabtin table share set <table-id> --share-type organization                        开/改组织限定分享
  tabtin table share set <table-id> --share-type data --acknowledge-public-exposure   开/改公开分享
  tabtin table share get <table-id>                                                  查看当前有效分享（只读）
  tabtin table share off <table-id>                                                  关闭分享（物理删除分享记录，可重开靠 set）
  tabtin table share shared-with-me                                                  列出分享给我的表格（独立访问发现入口）

安全提示：data 分享 = 免登录、任何拿到链接者可访问；首次扩到 data 须加
--acknowledge-public-exposure，否则后端 409。敏感表优先 organization，或对 data
加 --password / --expire-hours。每表 data/organization 互斥（切换时旧链接失效）；
本组无 refresh，要换链接用 off 再 set。`,
	}

	// ── set（create-or-update，POST /tables/{table_id}/share）──
	// 后端 create_data_share 是 exists-then-update-else-create 的 upsert
	// （api_share.py:223-259），set 语义最贴切（同 doc share set 的用词理由）。
	cmdutil.MustRegisterCommand(shareCmd, f, cmdutil.CommandDef{
		Use: "set <table-id>", Short: "开启或更新表格数据分享（create-or-update）",
		Long: `开启或更新表格的只读数据分享（POST /tables/{table_id}/share，互斥 upsert）。
同一表 data 与 organization 互斥：切换范围时旧类型链接立即失效。返回分享详情
（含 share_id / 是否有密码 / 过期时间 / 访问次数等）。

--share-type（必填，显式选 data / organization）：
  data          免登录只读链接：任何拿到 share_id 的人都能访问表格数据。
                安全警示——这是**全网可达**的，敏感表请改用 organization，
                或务必加 --password / --expire-hours 限制。首次（或从
                organization）扩到 data 时必须加 --acknowledge-public-exposure，
                否则后端返回 409 PUBLIC_EXPOSURE_ACK_REQUIRED（CLI 本地也会拒绝）。
  organization  组织限定：仅目标 organization 成员登录后可访问；目标组织用
                **全局 --organization-id** 指定（不是命令级 flag——见下）；
                缺组织 id 时后端会尝试从表格归属推导，仍失败则 400。

可选配置：
  --permission     view / comment / edit（默认 view）——访问者拿到的权限级别。
  --password       访问密码。三态语义：不传=保留旧密码不动；传 ""=清空密码；传非空=设新密码。
  --expire-hours   有效期小时数（>0 生效，到点失效）；不传或 <=0 = 永不过期。
  --allow-download 是否允许下载（默认允许；传 --allow-download=false 禁止）。
  --view-id        绑定到指定视图（不传则分享全表默认视图）。
  --acknowledge-public-exposure  确认接受公网暴露风险（仅扩到 data 时必需，否则 409）。

关于 organization 目标组织：CLI **不提供** --organization-id 命令级 flag（它是全局 persistent flag，
命令级会撞名）。要建 organization 分享，用全局 --organization-id 指定目标组织，例如：
  tabtin table share set tbl_xxx --share-type organization --organization-id wt_yyy`,
		Example: "  tabtin table share set tbl_xxx --share-type data --acknowledge-public-exposure\n" +
			"  tabtin table share set tbl_xxx --share-type data --acknowledge-public-exposure --password s3cret --expire-hours 24\n" +
			"  tabtin table share set tbl_xxx --share-type data --acknowledge-public-exposure --permission view --allow-download=false\n" +
			"  tabtin table share set tbl_xxx --share-type organization --organization-id wt_yyy --permission edit\n" +
			"  tabtin table share set tbl_xxx --share-type data --acknowledge-public-exposure --dry-run --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdata/tables/{table_id}/share",
		ArgsMapping:  []string{"table_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			// 安全要求1：share_type 不给默认值，Required 强制显式选 data vs organization。
			{Name: "share-type", Type: cmdutil.FlagEnum, Required: true, Desc: "分享类型：data（免登录只读全网可达）/ organization（限组织成员）", Enum: []string{"data", "organization"}},
			{Name: "permission", Type: cmdutil.FlagEnum, Desc: "访问权限：view / comment / edit（默认 view）", Enum: []string{"view", "comment", "edit"}},
			// AllowEmpty=true 理由同 doc share set --password：三态 sentinel，
			// 空串=清空密码，不能被 buildRequestBody 当"未设置"过滤掉。
			{Name: "password", Type: cmdutil.FlagString, AllowEmpty: true, Desc: "访问密码（不传=保留旧密码；传空串=清空；传非空=设新密码）"},
			{Name: "expire-hours", Type: cmdutil.FlagInt, Desc: "有效期小时数（>0 生效；不传/<=0 = 永不过期）"},
			{Name: "allow-download", Type: cmdutil.FlagBool, Desc: "允许下载（默认允许；--allow-download=false 禁止）"},
			{Name: "view-id", Type: cmdutil.FlagString, Desc: "绑定到指定视图 ID（不传=分享全表默认视图）"},
			{Name: "acknowledge-public-exposure", Type: cmdutil.FlagBool, Desc: "确认接受公网暴露风险（扩到 data 时必填，否则 409）"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "share_id", Label: "分享短链 ID", Type: "id"},
			{Key: "share_type", Label: "类型", Type: "string"},
			{Key: "permission", Label: "权限", Type: "string"},
			{Key: "has_password", Label: "有密码", Type: "bool"},
			{Key: "expire_at", Label: "过期时间", Type: "datetime"},
			{Key: "allow_download", Label: "允许下载", Type: "bool"},
			{Key: "visit_count", Label: "访问次数", Type: "number"},
			{Key: "created_at", Label: "创建时间", Type: "datetime"},
		},
		// CLI 本地门禁 + 后端 409：data 分享必须显式 ack。
		Validate: func(ctx *cmdutil.RunContext) error {
			if ctx.Str("share-type") == "data" && !ctx.Bool("acknowledge-public-exposure") {
				return fmt.Errorf("share-type=data 是免登录全网可达的外链，请加 --acknowledge-public-exposure 确认接受公网暴露风险（否则后端 409 PUBLIC_EXPOSURE_ACK_REQUIRED）")
			}
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			tableID := "<table-id>"
			if len(ctx.Args) > 0 {
				tableID = ctx.Args[0]
			}
			body := map[string]any{}
			if v, ok := ctx.FlagValues["share-type"]; ok {
				body["share_type"] = v
			}
			if v, ok := ctx.FlagValues["permission"]; ok {
				body["permission"] = v
			}
			if v, ok := ctx.FlagValues["password"]; ok {
				body["password"] = v
			}
			if v, ok := ctx.FlagValues["expire-hours"]; ok {
				body["expire_hours"] = v
			}
			if v, ok := ctx.FlagValues["allow-download"]; ok {
				body["allow_download"] = v
			}
			if v, ok := ctx.FlagValues["view-id"]; ok {
				body["view_id"] = v
			}
			if v, ok := ctx.FlagValues["acknowledge-public-exposure"]; ok {
				body["acknowledge_public_exposure"] = v
			}
			// 分享目标 organization 由全局 --organization-id 注入 body.organization_id（pipeline 自动），此处不重复。
			return cmdutil.NewDryRunPlan().
				Desc("开启/更新表格数据分享（互斥 create-or-update；data 须 acknowledge_public_exposure）").
				Step("POST", "/api/tabdata/tables/"+tableID+"/share", body)
		},
	})

	// ── get（GET /tables/{table_id}/share，只读；省略 share_type=当前有效分享）──
	cmdutil.MustRegisterCommand(shareCmd, f, cmdutil.CommandDef{
		Use: "get <table-id>", Short: "查看表格当前有效分享设置",
		Long: `查看表格当前的只读数据分享设置（GET /tables/{table_id}/share）。
省略 --share-type 时返回当前有效分享（data / organization 互斥）；也可显式传
data|organization。未开启分享时返回 {share: null, enabled: false}；已开启返回
分享详情（share_id 短链 / 权限 / 是否有密码 / 过期时间 / 下载开关 / 访问次数等）。
只读操作。`,
		Example: "  tabtin table share get tbl_xxx\n" +
			"  tabtin table share get tbl_xxx --share-type organization\n" +
			"  tabtin table share get tbl_xxx --format json --jq .share.share_id\n" +
			"  tabtin table share get tbl_xxx --jq .enabled  # 未开启分享时为 false",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdata/tables/{table_id}/share",
		ArgsMapping:  []string{"table_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		Flags: []cmdutil.FlagDef{
			{Name: "share-type", Type: cmdutil.FlagEnum, Desc: "分享类型：data / organization（省略=当前有效分享）", Enum: []string{"data", "organization"}},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "share_id", Label: "分享短链 ID", Type: "id"},
			{Key: "share_type", Label: "类型", Type: "string"},
			{Key: "permission", Label: "权限", Type: "string"},
			{Key: "has_password", Label: "有密码", Type: "bool"},
			{Key: "expire_at", Label: "过期时间", Type: "datetime"},
			{Key: "allow_download", Label: "允许下载", Type: "bool"},
			{Key: "visit_count", Label: "访问次数", Type: "number"},
			{Key: "created_at", Label: "创建时间", Type: "datetime"},
			{Key: "enabled", Label: "生效中", Type: "bool"},
		},
	})

	// ── off（DELETE /tables/{table_id}/share，关闭分享）──
	// close_data_share（api_share.py:299-319）是真删（QuerySet.delete()），
	// 与 doc share off 的软删（is_active=False）不同——但删的只是分享记录，
	// 表数据本身不受影响，之后 set 可重新开启（拿到新 share_id）。定级
	// RiskWrite（不强制 --yes）：可通过 set 复原分享能力，语义上仍是可逆操作。
	//
	//  critical fix：CLI 声明式管线（pipeline.go buildRequestBody 之后的
	// body→query 转换）只对 GET 生效，DELETE 的 --share-type 仍走 JSON body 发送；
	// 而 Django Ninja 对 close_data_share 裸 str 形参默认按 query 绑定，两边错位会
	// 导致 --share-type=organization 被静默当成 data 关掉。已镜像  doc share off
	// 的方案在后端 close_data_share 里加 _share_type_from_request（优先读 body，
	// 查不到再退回 query），不改 CLI 管线——修复点在
	// apps/tabtin_django/apps/tabdata/api_share.py，不是这里。
	cmdutil.MustRegisterCommand(shareCmd, f, cmdutil.CommandDef{
		Use: "off <table-id>", Short: "关闭表格数据分享（data / organization）",
		Long: `关闭表格数据分享，让分享链接立即失效（DELETE /tables/{table_id}/share）。
后端物理删除该 share_type 的分享记录（不是软删），返回 {deleted_count}；
之后用 table share set 可重新开启分享（会生成新的 share_id）。表数据本身
不受影响，故定级 RiskWrite（不强制 --yes），不是 RiskDestructive。

省略 --share-type 时关闭 data 分享（后端默认）；也可显式传 organization。`,
		Example: "  tabtin table share off tbl_xxx\n" +
			"  tabtin table share off tbl_xxx --share-type organization\n" +
			"  tabtin table share off tbl_xxx --dry-run --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "DELETE",
		Path:         "/api/tabdata/tables/{table_id}/share",
		ArgsMapping:  []string{"table_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "share-type", Type: cmdutil.FlagEnum, Desc: "分享类型：data / organization（省略=data）", Enum: []string{"data", "organization"}},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "deleted_count", Label: "已关闭分享数", Type: "number"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			tableID := "<table-id>"
			if len(ctx.Args) > 0 {
				tableID = ctx.Args[0]
			}
			body := map[string]any{}
			if v, ok := ctx.FlagValues["share-type"]; ok {
				body["share_type"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("关闭表格数据分享（物理删除该 share_type 记录；省略 --share-type=data）").
				Step("DELETE", "/api/tabdata/tables/"+tableID+"/share", body)
		},
	})

	// ── shared-with-me（GET /shared-with-me，独立访问发现入口）──
	// 与 doc 对称：Agent 私有化后协作者看不到他人 workspace，只能靠资源级
	// TablePermission 发现被分享的表（list_tables_shared_with_me,
	// share_service.py:635-684）。静态路径避开 /tables/{table_id} 的 catch-all。
	cmdutil.MustRegisterCommand(shareCmd, f, cmdutil.CommandDef{
		Use: "shared-with-me", Short: "列出分享给我的表格（资源级协作，独立访问发现入口）",
		Long: `列出当前用户具备有效访问权限、但本人非 owner 的表格（GET /shared-with-me）。
与「分享给我的文档」（doc）对称的独立访问发现入口——Agent 私有化后协作者
无法看到他人的 workspace/Project，只能通过被显式邀请的 TablePermission
（table collaborator invite）访问这些表。已归档 / 已在回收站的表不会出现。

省略 --organization-id 时返回当前用户在全部 Organization 下的分享表；
传全局 --organization-id 可限定单个 Organization。`,
		Example: "  tabtin table share shared-with-me\n" +
			"  tabtin table share shared-with-me --organization-id wt_yyy\n" +
			"  tabtin table share shared-with-me --format json --jq '.tables[].table_id'",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdata/shared-with-me",
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "table_id", Label: "表格 ID", Type: "id"},
			{Key: "title", Label: "表名", Type: "string"},
			{Key: "permission", Label: "权限", Type: "string"},
			{Key: "organization_id", Label: "组织 ID", Type: "id"},
			{Key: "updated_at", Label: "更新时间", Type: "datetime"},
			{Key: "total", Label: "总数", Type: "number"},
		},
	})

	parent.AddCommand(shareCmd)
}
