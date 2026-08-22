package com.tabtin.mobile.data.automation.handlers.l2

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import com.tabtin.mobile.data.automation.getApplicationInfoCompat
import com.tabtin.mobile.data.automation.installedApplicationsCompat
import com.tabtin.mobile.data.automation.queryIntentActivitiesCompat

/**
 * Shared app-name → package-name resolution logic used by both
 * [ScreenOpenAppHandler] and [ScreenForceStopAppHandler].
 *
 * Resolution priority: alias → intent action → exact label → prefix → substring → package-name.
 */
internal object AppNameResolver {

    private const val TAG = "AppNameResolver"

    public const val SCORE_ALIAS: Int = 100
    public const val SCORE_EXACT: Int = 100
    public const val SCORE_PREFIX: Int = 80
    public const val SCORE_LABEL_CONTAINS: Int = 60
    public const val SCORE_PKG_CONTAINS: Int = 40
    public const val CONFIDENT_THRESHOLD: Int = SCORE_LABEL_CONTAINS
    public const val MAX_CANDIDATES: Int = 5

    private const val LAUNCHER_RESOLVE = "LAUNCHER_RESOLVE"
    private const val MIN_QUERY_LEN_LABEL = 2
    private const val MIN_QUERY_LEN_PKG = 3

    public data class ScoredApp(
        val packageName: String,
        val label: String,
        val score: Int,
        val isSystem: Boolean,
    )

    public sealed class ResolveResult {
        public data class Found(val packageName: String, val label: String, val score: Int = SCORE_ALIAS) : ResolveResult()
        public data class NotInstalled(val packageName: String, val appName: String) : ResolveResult()
        public data class Ambiguous(val candidates: List<ScoredApp>) : ResolveResult()
        public data class NotFound(val appName: String) : ResolveResult()
    }

    public val ALIAS_MAP: Map<String, String> = mapOf(
        // ── Messaging & Social ──
        "wechat" to "com.tencent.mm",
        "weixin" to "com.tencent.mm",
        "微信" to "com.tencent.mm",
        "qq" to "com.tencent.mobileqq",
        "whatsapp" to "com.whatsapp",
        "telegram" to "org.telegram.messenger",
        "微博" to "com.sina.weibo",
        "weibo" to "com.sina.weibo",

        // ── Work & Collaboration ──
        "企业微信" to "com.tencent.wework",
        "wechat work" to "com.tencent.wework",
        "wecom" to "com.tencent.wework",
        "钉钉" to "com.alibaba.android.rimet",
        "dingtalk" to "com.alibaba.android.rimet",
        "dingding" to "com.alibaba.android.rimet",
        "飞书" to "com.ss.android.lark",
        "lark" to "com.ss.android.lark",
        "feishu" to "com.ss.android.lark",

        // ── Payment ──
        "alipay" to "com.eg.android.AlipayGphone",
        "zhifubao" to "com.eg.android.AlipayGphone",
        "支付宝" to "com.eg.android.AlipayGphone",

        // ── Shopping ──
        "taobao" to "com.taobao.taobao",
        "淘宝" to "com.taobao.taobao",
        "jingdong" to "com.jingdong.app.mall",
        "jd" to "com.jingdong.app.mall",
        "京东" to "com.jingdong.app.mall",
        "拼多多" to "com.xunmeng.pinduoduo",
        "pinduoduo" to "com.xunmeng.pinduoduo",
        "pdd" to "com.xunmeng.pinduoduo",
        "闲鱼" to "com.taobao.idlefish",
        "xianyu" to "com.taobao.idlefish",
        "天猫" to "com.tmall.wireless",
        "tmall" to "com.tmall.wireless",

        // ── Local Life ──
        "meituan" to "com.sankuai.meituan",
        "美团" to "com.sankuai.meituan",
        "didi" to "com.sdu.didi.psnger",
        "滴滴" to "com.sdu.didi.psnger",
        "滴滴出行" to "com.sdu.didi.psnger",
        "饿了么" to "me.ele",
        "eleme" to "me.ele",
        "大众点评" to "com.dianping.v1",
        "dianping" to "com.dianping.v1",

        // ── Video & Streaming ──
        "douyin" to "com.ss.android.ugc.aweme",
        "抖音" to "com.ss.android.ugc.aweme",
        "tiktok" to "com.ss.android.ugc.trill",
        "bilibili" to "tv.danmaku.bili",
        "b站" to "tv.danmaku.bili",
        "哔哩哔哩" to "tv.danmaku.bili",
        "快手" to "com.smile.gifmaker",
        "kuaishou" to "com.smile.gifmaker",
        "youtube" to "com.google.android.youtube",
        "netflix" to "com.netflix.mediaclient",
        "腾讯视频" to "com.tencent.qqlive",
        "tencent video" to "com.tencent.qqlive",
        "爱奇艺" to "com.qiyi.video",
        "iqiyi" to "com.qiyi.video",
        "优酷" to "com.youku.phone",
        "youku" to "com.youku.phone",
        "芒果tv" to "com.hunantv.imgo.activity",
        "mangotv" to "com.hunantv.imgo.activity",

        // ── Content & Knowledge ──
        "xiaohongshu" to "com.xingin.xhs",
        "redbook" to "com.xingin.xhs",
        "小红书" to "com.xingin.xhs",
        "知乎" to "com.zhihu.android",
        "zhihu" to "com.zhihu.android",
        "百度" to "com.baidu.searchbox",
        "baidu" to "com.baidu.searchbox",
        "今日头条" to "com.ss.android.article.news",
        "toutiao" to "com.ss.android.article.news",
        "头条" to "com.ss.android.article.news",

        // ── Music ──
        "spotify" to "com.spotify.music",
        "网易云音乐" to "com.netease.cloudmusic",
        "cloudmusic" to "com.netease.cloudmusic",
        "网易云" to "com.netease.cloudmusic",
        "qq音乐" to "com.tencent.qqmusic",
        "qqmusic" to "com.tencent.qqmusic",
        "酷狗音乐" to "com.kugou.android",
        "kugou" to "com.kugou.android",

        // ── Reading ──
        "微信读书" to "com.tencent.weread",
        "weread" to "com.tencent.weread",
        "喜马拉雅" to "com.ximalaya.ting.android",
        "ximalaya" to "com.ximalaya.ting.android",

        // ── Meetings ──
        "腾讯会议" to "com.tencent.wemeet.app",
        "tencent meeting" to "com.tencent.wemeet.app",
        "voov" to "com.tencent.wemeet.app",
        "zoom" to "us.zoom.videomeetings",

        // ── Browser ──
        "chrome" to "com.android.chrome",
        "谷歌浏览器" to "com.android.chrome",

        // ── Cloud & Office ──
        "wps" to "cn.wps.moffice_eng",
        "wps office" to "cn.wps.moffice_eng",
        "百度网盘" to "com.baidu.netdisk",
        "baidu netdisk" to "com.baidu.netdisk",
        "网盘" to "com.baidu.netdisk",

        // ── Maps & Navigation ──
        "高德地图" to "com.autonavi.minimap",
        "高德" to "com.autonavi.minimap",
        "amap" to "com.autonavi.minimap",
        "gaode" to "com.autonavi.minimap",
        "百度地图" to "com.baidu.BaiduMap",
        "baidu map" to "com.baidu.BaiduMap",
        "baidu maps" to "com.baidu.BaiduMap",
        "腾讯地图" to "com.tencent.map",
        "tencent map" to "com.tencent.map",
        "maps" to "com.google.android.apps.maps",
        "google maps" to "com.google.android.apps.maps",
        "google map" to "com.google.android.apps.maps",
        "谷歌地图" to "com.google.android.apps.maps",
        "高德导航" to "com.autonavi.minimap",
        "tencent maps" to "com.tencent.map",
        "waze" to "com.waze",

        // ── Express & Logistics ──
        "菜鸟" to "com.cainiao.wireless",
        "菜鸟裹裹" to "com.cainiao.wireless",
        "cainiao" to "com.cainiao.wireless",
        "快递100" to "com.Kingdee.kuaidi",
        "kuaidi100" to "com.Kingdee.kuaidi",
        "顺丰" to "com.sf.activity",
        "顺丰速运" to "com.sf.activity",
        "sf express" to "com.sf.activity",
        "sf" to "com.sf.activity",
        "京东快递" to "com.jd.jdlite",
        "圆通" to "com.yto.net.mobile",
        "中通" to "com.ztop.app",
        "韵达" to "com.yunda.express",

        // ── Carrier Apps ──
        "中国移动" to "com.chinamobile.mobilemarket",
        "移动营业厅" to "com.chinamobile.mobilemarket",
        "中国联通" to "com.chinaunicom.myunicom.globalweb",
        "联通营业厅" to "com.chinaunicom.myunicom.globalweb",
        "中国电信" to "cn.cj.pe",
        "电信营业厅" to "cn.cj.pe",

        // ── Travel ──
        "12306" to "com.MobileTicket",
        "铁路12306" to "com.MobileTicket",
        "携程" to "ctrip.android.view",
        "ctrip" to "ctrip.android.view",
        "飞猪" to "com.taobao.trip",
        "fliggy" to "com.taobao.trip",
        "去哪儿" to "com.Qunar",
        "qunar" to "com.Qunar",

        // ── Global Social ──
        "twitter" to "com.twitter.android",
        "x" to "com.twitter.android",
        "instagram" to "com.instagram.android",
        "ins" to "com.instagram.android",
        "facebook" to "com.facebook.katana",
        "fb" to "com.facebook.katana",
        "gmail" to "com.google.android.gm",
        "linkedin" to "com.linkedin.android",
        "snapchat" to "com.snapchat.android",
        "line" to "jp.naver.line.android",

        // ── System (LAUNCHER_RESOLVE) ──
        "settings" to LAUNCHER_RESOLVE,
        "设置" to LAUNCHER_RESOLVE,
        "camera" to LAUNCHER_RESOLVE,
        "相机" to LAUNCHER_RESOLVE,
        "calculator" to LAUNCHER_RESOLVE,
        "计算器" to LAUNCHER_RESOLVE,
        "calendar" to LAUNCHER_RESOLVE,
        "日历" to LAUNCHER_RESOLVE,
        "clock" to LAUNCHER_RESOLVE,
        "时钟" to LAUNCHER_RESOLVE,
        "闹钟" to LAUNCHER_RESOLVE,
        "alarm" to LAUNCHER_RESOLVE,
        "alarm clock" to LAUNCHER_RESOLVE,
        "files" to LAUNCHER_RESOLVE,
        "文件" to LAUNCHER_RESOLVE,
        "文件管理" to LAUNCHER_RESOLVE,
        "phone" to LAUNCHER_RESOLVE,
        "电话" to LAUNCHER_RESOLVE,
        "拨号" to LAUNCHER_RESOLVE,
        "dialer" to LAUNCHER_RESOLVE,
        "messages" to LAUNCHER_RESOLVE,
        "短信" to LAUNCHER_RESOLVE,
        "信息" to LAUNCHER_RESOLVE,
        "sms" to LAUNCHER_RESOLVE,
        "contacts" to LAUNCHER_RESOLVE,
        "联系人" to LAUNCHER_RESOLVE,
        "通讯录" to LAUNCHER_RESOLVE,
        "gallery" to LAUNCHER_RESOLVE,
        "photos" to LAUNCHER_RESOLVE,
        "相册" to LAUNCHER_RESOLVE,
        "图库" to LAUNCHER_RESOLVE,
        "browser" to LAUNCHER_RESOLVE,
        "浏览器" to LAUNCHER_RESOLVE,
        "email" to LAUNCHER_RESOLVE,
        "邮件" to LAUNCHER_RESOLVE,
        "邮箱" to LAUNCHER_RESOLVE,
    )

    private val INTENT_ACTION_MAP: Map<String, Intent> = mapOf(
        "settings" to Intent(Settings.ACTION_SETTINGS),
        "设置" to Intent(Settings.ACTION_SETTINGS),
        "camera" to Intent(MediaStore.ACTION_IMAGE_CAPTURE),
        "相机" to Intent(MediaStore.ACTION_IMAGE_CAPTURE),
        "calculator" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_CALCULATOR),
        "计算器" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_CALCULATOR),
        "clock" to Intent(AlarmClock.ACTION_SET_ALARM),
        "时钟" to Intent(AlarmClock.ACTION_SET_ALARM),
        "闹钟" to Intent(AlarmClock.ACTION_SET_ALARM),
        "alarm" to Intent(AlarmClock.ACTION_SET_ALARM),
        "alarm clock" to Intent(AlarmClock.ACTION_SET_ALARM),
        "calendar" to Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI),
        "日历" to Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI),
        "files" to Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"),
        "文件" to Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"),
        "文件管理" to Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"),
        "phone" to Intent(Intent.ACTION_DIAL),
        "电话" to Intent(Intent.ACTION_DIAL),
        "拨号" to Intent(Intent.ACTION_DIAL),
        "dialer" to Intent(Intent.ACTION_DIAL),
        "messages" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_MESSAGING),
        "短信" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_MESSAGING),
        "信息" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_MESSAGING),
        "sms" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_MESSAGING),
        "contacts" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_CONTACTS),
        "联系人" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_CONTACTS),
        "通讯录" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_CONTACTS),
        "gallery" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_GALLERY),
        "photos" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_GALLERY),
        "相册" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_GALLERY),
        "图库" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_GALLERY),
        "browser" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_BROWSER),
        "浏览器" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_BROWSER),
        "email" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_EMAIL),
        "邮件" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_EMAIL),
        "邮箱" to Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_EMAIL),
    )

    /**
     * Resolve a direct alias (non-LAUNCHER_RESOLVE) to a package name.
     * Returns null for LAUNCHER_RESOLVE entries or unknown aliases.
     */
    public fun resolveAlias(query: String): String? {
        val pkg = ALIAS_MAP[query] ?: return null
        return if (pkg == LAUNCHER_RESOLVE) null else pkg
    }

    /**
     * Full resolution: alias → intent action → scored label/package matching.
     */
    public fun resolve(context: Context, appName: String): ResolveResult {
        val pm = context.packageManager
        val query = appName.lowercase()

        val aliasPackage = ALIAS_MAP[query]
        if (aliasPackage != null && aliasPackage != LAUNCHER_RESOLVE) {
            val installed = try {
                pm.getApplicationInfoCompat(aliasPackage)
                true
            } catch (_: PackageManager.NameNotFoundException) {
                false
            }
            if (installed) {
                val label = getAppLabel(pm, aliasPackage) ?: appName
                return ResolveResult.Found(aliasPackage, label)
            }
            Log.i(TAG, "Alias '$query' -> '$aliasPackage' not installed, falling through to scored matching")
        }

        if (aliasPackage == LAUNCHER_RESOLVE) {
            val intentAction = INTENT_ACTION_MAP[query]
            if (intentAction != null) {
                val candidates = pm.queryIntentActivitiesCompat(intentAction)
                val resolvedPkg = candidates
                    .sortedByDescending { it.activityInfo.applicationInfo.flags and ApplicationInfo.FLAG_SYSTEM != 0 }
                    .firstOrNull()
                    ?.activityInfo?.packageName
                if (resolvedPkg != null) {
                    val label = getAppLabel(pm, resolvedPkg) ?: appName
                    return ResolveResult.Found(resolvedPkg, label)
                }
                Log.w(TAG, "LAUNCHER_RESOLVE fall-through for '$query': intent matched ${candidates.size} candidates but none resolved")
            } else {
                Log.w(TAG, "LAUNCHER_RESOLVE fall-through for '$query': no INTENT_ACTION_MAP entry, falling back to scored matching")
            }
        }

        val scored = scoreLaunchableApps(pm, query)

        if (scored.isEmpty()) {
            if (aliasPackage != null && aliasPackage != LAUNCHER_RESOLVE) {
                return ResolveResult.NotInstalled(aliasPackage, appName)
            }
            return ResolveResult.NotFound(appName)
        }

        val best = scored.first()
        if (best.score < CONFIDENT_THRESHOLD) {
            return ResolveResult.Ambiguous(scored.take(MAX_CANDIDATES))
        }

        return ResolveResult.Found(best.packageName, best.label, best.score)
    }

    public fun scoreLaunchableApps(pm: PackageManager, query: String): List<ScoredApp> {
        val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val launchablePackages = pm.queryIntentActivitiesCompat(launcherIntent)
            .map { it.activityInfo.packageName }
            .toSet()

        return pm.installedApplicationsCompat()
            .filter { it.packageName in launchablePackages }
            .mapNotNull { app ->
                val label = pm.getApplicationLabel(app).toString()
                val labelLower = label.lowercase()
                val pkgLower = app.packageName.lowercase()
                val isSystem = app.flags and ApplicationInfo.FLAG_SYSTEM != 0
                val score = when {
                    labelLower == query -> SCORE_EXACT
                    labelLower.startsWith(query) -> SCORE_PREFIX
                    query.length >= MIN_QUERY_LEN_LABEL && labelLower.contains(query) -> SCORE_LABEL_CONTAINS
                    query.length >= MIN_QUERY_LEN_PKG && pkgLower.contains(query) -> SCORE_PKG_CONTAINS
                    else -> 0
                }
                if (score > 0) ScoredApp(app.packageName, label, score, isSystem) else null
            }
            .sortedWith(compareByDescending<ScoredApp> { it.score }.thenBy { it.isSystem })
    }

    public fun getAppLabel(pm: PackageManager, packageName: String): String? = try {
        val ai = pm.getApplicationInfoCompat(packageName)
        pm.getApplicationLabel(ai).toString()
    } catch (_: Exception) {
        null
    }
}
