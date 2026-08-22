package com.tabtin.mobile.util

import androidx.annotation.StringRes
import com.tabtin.mobile.R
import retrofit2.HttpException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

public object ErrorClassifier {

    public enum class Category { NETWORK, AUTH_EXPIRED, FORBIDDEN, SERVER, UNKNOWN }

    public fun categorize(e: Exception): Category = when {
        e is UnknownHostException -> Category.NETWORK
        e is SocketTimeoutException -> Category.NETWORK
        e is ConnectException -> Category.NETWORK
        e.message?.contains("timeout", ignoreCase = true) == true -> Category.NETWORK
        e.message?.contains("network", ignoreCase = true) == true -> Category.NETWORK
        e is HttpException && e.code() == 401 -> Category.AUTH_EXPIRED
        e is HttpException && e.code() == 403 -> Category.FORBIDDEN
        e is HttpException && e.code() in 500..599 -> Category.SERVER
        else -> Category.UNKNOWN
    }

    @StringRes
    public fun classify(e: Exception): Int = when (categorize(e)) {
        Category.NETWORK -> R.string.error_network
        Category.AUTH_EXPIRED -> R.string.error_session_expired
        Category.FORBIDDEN -> R.string.error_forbidden
        Category.SERVER -> R.string.error_server
        Category.UNKNOWN -> R.string.error_unknown
    }

    public fun <T> classifyAs(
        e: Exception,
        networkResult: T,
        serverResult: T,
        unknownResult: T,
    ): T = when (categorize(e)) {
        Category.NETWORK -> networkResult
        Category.AUTH_EXPIRED -> unknownResult
        Category.FORBIDDEN -> unknownResult
        Category.SERVER -> serverResult
        Category.UNKNOWN -> unknownResult
    }
}
