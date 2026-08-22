package com.tabtin.mobile.util

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

public enum class NetworkStatus {
    Available,
    Lost,
}

@Singleton
public class NetworkMonitor @Inject constructor(
    @ApplicationContext private val context: Context
) {
    public companion object {
        private const val TAG = "NetworkMonitor"
    }

    private val connectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val _status = MutableStateFlow(currentStatus())
    public val status: StateFlow<NetworkStatus> = _status.asStateFlow()

    private val _networkRestored = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    public val networkRestoredEvents: SharedFlow<Unit> = _networkRestored.asSharedFlow()

    public val isConnected: Boolean get() = _status.value == NetworkStatus.Available
    public val connectionTypeName: String?
        get() = currentConnectionType()

    private var isMonitoring = false

    public fun startMonitoring() {
        if (isMonitoring) return
        isMonitoring = true

        val callback = object : ConnectivityManager.NetworkCallback() {
            private var wasLost = !isNetworkAvailable()

            override fun onAvailable(network: Network) {
                Log.i(TAG, "Network available")
                _status.value = NetworkStatus.Available
                if (wasLost) {
                    _networkRestored.tryEmit(Unit)
                    wasLost = false
                }
            }

            override fun onLost(network: Network) {
                Log.i(TAG, "Network lost")
                _status.value = NetworkStatus.Lost
                wasLost = true
            }
        }

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        try {
            connectivityManager.registerNetworkCallback(request, callback)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to register network callback: ${e.message}")
            isMonitoring = false
        }
    }

    private fun currentStatus(): NetworkStatus =
        if (isNetworkAvailable()) NetworkStatus.Available else NetworkStatus.Lost

    private fun isNetworkAvailable(): Boolean {
        val network = connectivityManager.activeNetwork ?: return false
        val caps = connectivityManager.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun currentConnectionType(): String? {
        val network = connectivityManager.activeNetwork ?: return null
        val caps = connectivityManager.getNetworkCapabilities(network) ?: return null
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "bluetooth"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            else -> "unknown"
        }
    }
}
