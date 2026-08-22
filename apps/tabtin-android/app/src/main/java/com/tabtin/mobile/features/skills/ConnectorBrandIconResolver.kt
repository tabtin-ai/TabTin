package com.tabtin.mobile.features.skills

import android.content.Context
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference

/**
 * 连接器品牌标解析：规则来自 `assets/connector_brand_manifest.json`
 *（与 `@tabtin/connector-brand-icons` 同源）。UI 不要硬编码品牌 slug。
 */
public object ConnectorBrandIconResolver {
    public data class Query(
        val brandKey: String? = null,
        val catalogId: String? = null,
        val name: String? = null,
        val endpointUrl: String? = null,
    )

    public data class Result(
        val brandKey: String,
        val drawableRes: Int,
    )

    private data class Brand(
        val status: String,
        val file: String?,
        val ids: List<String>,
        val hosts: List<String>,
        val names: List<String>,
    )

    private val cache = AtomicReference<Map<String, Brand>?>(null)

    public fun resolve(context: Context, query: Query): Result? {
        val brands = load(context)
        fun approved(brand: Brand): Boolean =
            brand.status == "approved" && !brand.file.isNullOrBlank()

        normalize(query.brandKey)?.let { key ->
            val brand = brands[key]
            if (brand != null && approved(brand)) {
                return Result(key, drawableRes(context, key) ?: return null)
            }
        }

        normalize(query.catalogId)?.let { catalogId ->
            brands.forEach { (key, brand) ->
                if (approved(brand) && brand.ids.contains(catalogId)) {
                    drawableRes(context, key)?.let { return Result(key, it) }
                }
            }
        }

        hostFrom(query.endpointUrl)?.let { host ->
            brands.forEach { (key, brand) ->
                if (approved(brand) && brand.hosts.any { hostMatches(host, it) }) {
                    drawableRes(context, key)?.let { return Result(key, it) }
                }
            }
        }

        normalize(query.name)?.let { name ->
            brands.forEach { (key, brand) ->
                if (approved(brand) && brand.names.any { n ->
                        name == n || name.startsWith("$n ") || name.startsWith("$n·") || name.startsWith("$n-")
                    }
                ) {
                    drawableRes(context, key)?.let { return Result(key, it) }
                }
            }
        }

        return null
    }

    private fun load(context: Context): Map<String, Brand> {
        cache.get()?.let { return it }
        val parsed = runCatching {
            context.assets.open("connector_brand_manifest.json").bufferedReader().use { reader ->
                val root = JSONObject(reader.readText())
                val brandsObj = root.getJSONObject("brands")
                buildMap {
                    val keys = brandsObj.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        val item = brandsObj.getJSONObject(key)
                        val match = item.optJSONObject("match")
                        put(
                            key,
                            Brand(
                                status = item.optString("status"),
                                file = item.optString("file").takeIf { it.isNotBlank() },
                                ids = jsonStringList(match, "ids"),
                                hosts = jsonStringList(match, "hosts"),
                                names = jsonStringList(match, "names"),
                            ),
                        )
                    }
                }
            }
        }.getOrDefault(emptyMap())
        cache.compareAndSet(null, parsed)
        return cache.get() ?: parsed
    }

    private fun jsonStringList(obj: JSONObject?, key: String): List<String> {
        if (obj == null || !obj.has(key)) return emptyList()
        val arr = obj.getJSONArray(key)
        return buildList {
            for (i in 0 until arr.length()) {
                add(arr.getString(i).trim().lowercase(Locale.ROOT))
            }
        }
    }

    private fun drawableRes(context: Context, brandKey: String): Int? {
        // Android resource names cannot contain '-'.
        val resName = "connector_brand_${brandKey.replace('-', '_')}"
        val id = context.resources.getIdentifier(
            resName,
            "drawable",
            context.packageName,
        )
        return id.takeIf { it != 0 }
    }

    private fun normalize(value: String?): String? =
        value?.trim()?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() }

    private fun hostFrom(value: String?): String? {
        val raw = value?.trim().orEmpty()
        if (raw.isEmpty()) return null
        val withScheme = if (raw.contains("://")) raw else "https://$raw"
        return runCatching { java.net.URI(withScheme).host?.lowercase(Locale.ROOT) }.getOrNull()
    }

    private fun hostMatches(host: String, pattern: String): Boolean {
        val p = pattern.lowercase(Locale.ROOT)
        return host == p || host.endsWith(".$p")
    }
}
