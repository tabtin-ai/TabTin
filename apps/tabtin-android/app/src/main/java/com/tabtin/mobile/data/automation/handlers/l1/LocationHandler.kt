package com.tabtin.mobile.data.automation.handlers.l1

import android.Manifest
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import androidx.annotation.RequiresApi
import com.tabtin.mobile.data.automation.ActionHandler
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.automation.PermissionChecker
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume

@Singleton
internal class LocationHandler @Inject constructor(
    @ApplicationContext private val context: Context,
    private val permissionChecker: PermissionChecker,
) : ActionHandler {
    override val actionName: String = "get_location"

    @Suppress("MissingPermission")
    override suspend fun execute(params: JsonObject): DeviceActionResult {
        val highAccuracy = params["high_accuracy"]?.jsonPrimitive?.booleanOrNull ?: false

        if (highAccuracy) {
            permissionChecker.checkOrError(Manifest.permission.ACCESS_FINE_LOCATION)?.let { return it }
        } else {
            val hasFine = permissionChecker.has(Manifest.permission.ACCESS_FINE_LOCATION)
            val hasCoarse = permissionChecker.has(Manifest.permission.ACCESS_COARSE_LOCATION)
            if (!hasFine && !hasCoarse) {
                return DeviceActionResult(
                    success = false,
                    error = "Location permission not granted. Grant either fine or coarse location permission.",
                    errorCode = "PERMISSION_NOT_GRANTED",
                )
            }
        }

        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

        val providers = if (highAccuracy) {
            listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        } else {
            listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
        }

        val enabledProviders = providers.filter {
            try { locationManager.isProviderEnabled(it) } catch (_: Exception) { false }
        }
        if (enabledProviders.isEmpty()) {
            return DeviceActionResult(
                success = false,
                error = "Location services are disabled. Please enable GPS or network location in Settings.",
                errorCode = "LOCATION_DISABLED",
            )
        }

        val usedFreshApi = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
        val location = if (usedFreshApi) {
            try {
                requestCurrentLocation(locationManager, enabledProviders)
            } catch (e: SecurityException) {
                return DeviceActionResult(
                    success = false,
                    error = "Location permission denied: ${e.message}",
                    errorCode = "PERMISSION_DENIED",
                )
            }
        } else {
            null
        } ?: enabledProviders.firstNotNullOfOrNull { locationManager.getLastKnownLocation(it) }

        if (location == null) {
            return DeviceActionResult(
                success = false,
                error = "Unable to determine location. Location services are enabled but no position available yet.",
                errorCode = "LOCATION_UNAVAILABLE",
            )
        }

        val ageMs = System.currentTimeMillis() - location.time
        return DeviceActionResult(
            success = true,
            data = buildJsonObject {
                put("latitude", location.latitude)
                put("longitude", location.longitude)
                put("accuracy_meters", location.accuracy.toDouble())
                put("provider", location.provider ?: "unknown")
                put("time", location.time)
                put("age_ms", ageMs)
                if (!usedFreshApi && ageMs > 300_000L) {
                    put("stale", true)
                }
            },
        )
    }

    @RequiresApi(Build.VERSION_CODES.R)
    @Suppress("MissingPermission")
    private suspend fun requestCurrentLocation(
        locationManager: LocationManager,
        providers: List<String>,
    ): Location? {
        for (provider in providers) {
            try {
                val loc = withTimeoutOrNull(8_000L) {
                    suspendCancellableCoroutine { cont ->
                        val signal = CancellationSignal()
                        cont.invokeOnCancellation { signal.cancel() }
                        locationManager.getCurrentLocation(
                            provider, signal, context.mainExecutor,
                        ) { location -> cont.resume(location) }
                    }
                }
                if (loc != null) return loc
            } catch (e: SecurityException) {
                throw e
            } catch (_: Exception) {
                // Provider unavailable, try next
            }
        }
        return null
    }
}
