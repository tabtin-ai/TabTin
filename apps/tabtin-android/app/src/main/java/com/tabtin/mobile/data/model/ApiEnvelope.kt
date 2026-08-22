package com.tabtin.mobile.data.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

@Serializable
public data class ApiEnvelope<T>(
    val success: Boolean,
    val data: T? = null,
    val message: String? = null,
    @SerialName("error_code") val errorCode: String? = null,
    // 兼容少数历史接口仍返回的 code 字段；上传接口以 error_code 为准。
    @Serializable(with = ApiCodeAsStringSerializer::class)
    val code: String? = null,
) {
    public fun requireSuccess() {
        if (!success) throw AppError.RequestFailed(message, errorCode ?: code)
    }

    public fun unwrap(): T {
        requireSuccess()
        if (data == null) throw AppError.RequestFailed(message, errorCode ?: code)
        return data
    }
}

private object ApiCodeAsStringSerializer : KSerializer<String?> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("ApiCodeAsString", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): String? {
        val jsonDecoder = decoder as? JsonDecoder
        if (jsonDecoder != null) {
            return when (val element = jsonDecoder.decodeJsonElement()) {
                JsonNull -> null
                is JsonPrimitive -> element.contentOrNull
                else -> element.toString()
            }
        }
        return decoder.decodeString()
    }

    @OptIn(ExperimentalSerializationApi::class)
    override fun serialize(encoder: Encoder, value: String?) {
        if (value == null) {
            encoder.encodeNull()
        } else {
            encoder.encodeString(value)
        }
    }
}
