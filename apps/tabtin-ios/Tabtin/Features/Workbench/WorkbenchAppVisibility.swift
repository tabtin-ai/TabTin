import Foundation

/// catalog `mobile_mode` 门禁：与 manifest `runtimeSupport.mobile.mode` 对齐，不另写本地支持表。
enum TaskWorkbenchMobileRuntime {
    static func normalized(_ mode: String?) -> String? {
        guard let mode = mode?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !mode.isEmpty else {
            return nil
        }
        return mode
    }

    /// unsupported / unavailable → 明确不可进入。
    static func isBlocked(_ mode: String?) -> Bool {
        switch normalized(mode) {
        case "unsupported", "unavailable":
            return true
        default:
            return false
        }
    }

    /// full → 可进 App 首页；未声明则回退 `hasAppRoute`（兼容尚未声明 mobile 的 tabdoc/tabdata）。
    static func allowsAppHome(_ mode: String?, appId: String) -> Bool {
        if let mode = normalized(mode) {
            return mode == "full"
        }
        return SpaceResource.hasAppRoute(forType: appId)
    }
}


/// 移动端工作台的 App 可见性闸门，对标 Electron `moduleRegistryUtils.ts` 的 `HIDDEN_APPS`
/// 与「更多应用」总览的 `DESKTOP_APPS_EXCLUDED_IDS`。
///
/// 组织级 catalog 会把所有 manifest 原样吐给客户端，服务端不区分端上有没有入口；
/// 没开放的 App 摆在工作台里只会让用户点进死路，所以移动端在投影阶段统一挡掉。
/// 这里是唯一的过滤点，增删都改这一处，别把判断散到调用方。
enum TaskWorkbenchAppVisibility {
    /// 每条都写清「凭什么挡」和「什么条件下删掉」，避免下一个人只能靠猜。
    private static let hiddenAppIds: Set<String> = [
        // ── 一、Electron 硬门禁：桌面连 ContextTypeHandler / HomeSection 都不注册，
        //     两端都打不开，属于产品层面尚未开放的能力。
        //
        // 单根契约（docs/single-root-space-prd.md §2.6）下架：`Site.code_project_path`
        // 是隐性的第二个项目根。桌面重开入口时同步删这条。
        "tabsite",
        // ：TabSlide App UI 暂不上线，Agent「做 PPT」改为交付本地 .pptx。
        // 桌面由 `TABSLIDE_UI_ENABLED` 控制，移动端没有等价开关，故常量屏蔽。
        "tabslide",
        // 2026-06-03 决策：Tin 暂不开放正式入口，桌面由 `TINS_UI_ENABLED` 控制。
        // 当前 catalog 尚未下发该 id，先按桌面口径对齐，避免开放当天移动端漏挡。
        "tins",

        // ── 二、Electron 软门禁（`TEMPORARILY_HIDDEN_AGENT_APP_IDS`）里 iOS 也承载不了的。
        //     桌面用户仍能手动打开，但移动端两条路都断：`SpaceAppRoute` 没有对应 case
        //     所以进不去资源列表，Agent `<apps>` 段又排除了它们所以交给 Agent 也不会被采纳。
        //
        // ：白板未达可交付状态；iOS 无白板承载页。
        "tabwhiteboard",
        // ：视频未达可交付状态；iOS 无视频承载页。
        "tabvideo",
        // ：「安卓手机」暂不作为可推荐能力；iOS 无设备控制页。
        "tabphone",
        // ：邮箱按同口径隐藏；iOS 无邮箱承载页。
        "tabmail",

        // ── 三、工作台入口收敛：这些能力不该以「应用磁贴」出现在移动端工作台。
        //
        // Agent 是对话主体，不是工作台里的一个 App；入口应留在对话 Tab。
        "orchestration",
        // 对标 Electron `DESKTOP_APPS_EXCLUDED_IDS`：入口中心暂不在应用总览露出。
        "tabinbox",
        // Desktop / 本机桌面控制未上线移动端，catalog 下发也不应露出死入口。
        "tabdesktop",
        // 对标 Electron DESKTOP_APPS_EXCLUDED_IDS，碎片笔记不再以工作台磁贴呈现。
        // MemoAppHome / 深链 / Agent 记忆 UI 仍保留，仅隐藏工作台总览入口。
        "tabmemo",
    ]

    static func isHidden(appId: String) -> Bool {
        hiddenAppIds.contains(normalized(appId))
    }

    static func normalized(_ appId: String) -> String {
        appId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

/// 工作台 / 应用 Tab 展示名：对齐 Electron `context.json` 的 `appName.*`。
///
/// Manifest / API 的 `name` 是英文产品代号（Tables / Docs），中文界面直接展示会
/// 像没本地化。这里只覆盖标题；描述不再进紧凑卡片，故不做 description 映射。
enum TaskWorkbenchAppDisplayName {
    private static let titles: [String: String] = [
        "tabdoc": "文档",
        "tabdata": "多维表",
        "tabslide": "演示",
        "tabvideo": "视频",
        "tabwhiteboard": "白板",
        "tabmemo": "笔记",
        "tabsite": "站点",
        "tabfolder": "本地目录",
        // 产品入口对齐 Electron「云盘」（cloud-resources）；tabfiles 是云盘里的文件类型。
        "tabfiles": "云盘",
        "tabcode": "代码",
        "tabweb": "浏览器",
        "tabdesktop": "桌面",
        "orchestration": "Agent",
        "tabphone": "安卓手机",
        "terminal": "终端",
        "tabtracker": "自动化",
        "tabinbox": "入口中心",
        "tabmail": "邮箱",
        "marketplace": "市场",
        "skill": "Skill",
        "tins": "Tins",
    ]

    /// 优先中文产品名；未知 App 回退 API/manifest 名称。
    static func resolve(appId: String, fallback: String) -> String {
        let key = TaskWorkbenchAppVisibility.normalized(appId)
        if let title = titles[key] { return title }
        let trimmed = fallback.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? appId : trimmed
    }
}
