package com.tabtin.mobile.data.adb

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.RequiresApi
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume

@RequiresApi(Build.VERSION_CODES.R)
@Singleton
public class AdbMdns @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    public companion object {
        public const val TLS_CONNECT: String = "_adb-tls-connect._tcp"
        public const val TLS_PAIRING: String = "_adb-tls-pairing._tcp"
        private const val TAG = "AdbMdns"
    }

    private val nsdManager: NsdManager = context.getSystemService(NsdManager::class.java)
    private val handler = Handler(Looper.getMainLooper())

    public suspend fun discoverOnce(
        serviceType: String,
        timeout: Long = 10_000,
    ): Int? = suspendCancellableCoroutine { cont ->
        val stopped = AtomicBoolean(false)
        val timeoutRef = arrayOfNulls<Runnable>(1)

        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) {
                Log.d(TAG, "Discovery started: $type")
            }

            override fun onStartDiscoveryFailed(type: String, errorCode: Int) {
                Log.e(TAG, "Discovery start failed: $type, error=$errorCode")
                if (stopped.compareAndSet(false, true)) {
                    timeoutRef[0]?.let { handler.removeCallbacks(it) }
                    if (cont.isActive) cont.resume(null)
                }
            }

            override fun onDiscoveryStopped(type: String) {
                Log.d(TAG, "Discovery stopped: $type")
            }

            override fun onStopDiscoveryFailed(type: String, errorCode: Int) {
                Log.e(TAG, "Discovery stop failed: $type, error=$errorCode")
            }

            override fun onServiceFound(info: NsdServiceInfo) {
                if (stopped.get()) return
                val outerListener = this
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    resolveServiceModern(info, outerListener, stopped, timeoutRef, cont)
                } else {
                    @Suppress("DEPRECATION")
                    nsdManager.resolveService(info, object : NsdManager.ResolveListener {
                        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                            Log.w(TAG, "Service resolve failed: ${info.serviceName}, error=$errorCode")
                        }
                        override fun onServiceResolved(resolved: NsdServiceInfo) {
                            if (stopped.get()) return
                            if (isLocalAddress(resolved) && isPortInUse(resolved.port)) {
                                if (!stopped.compareAndSet(false, true)) return
                                timeoutRef[0]?.let { handler.removeCallbacks(it) }
                                runCatching { nsdManager.stopServiceDiscovery(outerListener) }
                                if (cont.isActive) cont.resume(resolved.port)
                            }
                        }
                    })
                }
            }

            override fun onServiceLost(info: NsdServiceInfo) {}
        }

        cont.invokeOnCancellation {
            if (stopped.compareAndSet(false, true)) {
                timeoutRef[0]?.let { handler.removeCallbacks(it) }
                runCatching { nsdManager.stopServiceDiscovery(discoveryListener) }
            }
        }

        nsdManager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, discoveryListener)

        val timeoutRunnable = Runnable {
            if (stopped.compareAndSet(false, true)) {
                runCatching { nsdManager.stopServiceDiscovery(discoveryListener) }
                if (cont.isActive) cont.resume(null)
            }
        }
        timeoutRef[0] = timeoutRunnable
        handler.postDelayed(timeoutRunnable, timeout)
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun resolveServiceModern(
        info: NsdServiceInfo,
        discoveryListener: NsdManager.DiscoveryListener,
        stopped: AtomicBoolean,
        timeoutRef: Array<Runnable?>,
        cont: CancellableContinuation<Int?>,
    ) {
        val executor = Executor { handler.post(it) }
        val callback = object : NsdManager.ServiceInfoCallback {
            override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {
                Log.w(TAG, "ServiceInfoCallback registration failed: error=$errorCode")
            }

            override fun onServiceUpdated(resolved: NsdServiceInfo) {
                if (stopped.get()) {
                    runCatching { nsdManager.unregisterServiceInfoCallback(this) }
                    return
                }
                if (isLocalAddress(resolved) && isPortInUse(resolved.port)) {
                    if (!stopped.compareAndSet(false, true)) return
                    runCatching { nsdManager.unregisterServiceInfoCallback(this) }
                    timeoutRef[0]?.let { handler.removeCallbacks(it) }
                    runCatching { nsdManager.stopServiceDiscovery(discoveryListener) }
                    if (cont.isActive) cont.resume(resolved.port)
                }
            }

            override fun onServiceLost() {
                runCatching { nsdManager.unregisterServiceInfoCallback(this) }
            }

            override fun onServiceInfoCallbackUnregistered() {}
        }
        nsdManager.registerServiceInfoCallback(info, executor, callback)
    }

    private fun isLocalAddress(service: NsdServiceInfo): Boolean {
        val addresses: List<InetAddress> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            service.hostAddresses
        } else {
            @Suppress("DEPRECATION")
            listOfNotNull(service.host)
        }
        val localAddresses = NetworkInterface.getNetworkInterfaces()?.asSequence()
            ?.flatMap { it.inetAddresses.asSequence() }
            ?.mapNotNull { it.hostAddress }
            ?.toSet() ?: emptySet()
        return addresses.mapNotNull { it.hostAddress }.any { it in localAddresses }
    }

    private fun isPortInUse(port: Int): Boolean = try {
        ServerSocket().use {
            it.bind(InetSocketAddress("127.0.0.1", port), 1)
            false
        }
    } catch (e: IOException) {
        true
    }
}
