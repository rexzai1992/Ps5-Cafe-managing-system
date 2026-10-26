package com.ps5cafe.tvcompanion

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

/**
 * Which screen page this TV shows.
 *
 * Contract (fixed by the web app): `<serverOrigin>/#/screen/<stationId>?k=<screenKey>`.
 * The `?k=` query lives inside the hash route, so the server never sees it in the request line.
 */
data class ScreenConfig(
    val serverOrigin: String,
    val stationId: String,
    val screenKey: String,
) {
    val screenUrl: String
        get() = "$serverOrigin/#/screen/$stationId?k=$screenKey"

    /** Same URL with the key shortened, for logs and on-screen text. */
    val redactedScreenUrl: String
        get() = "$serverOrigin/#/screen/$stationId?k=${redactKey(screenKey)}"

    /**
     * JSON status polled by the timer overlay. Station and key need no escaping (validated charsets).
     * `overlay=1` tells the server not to count these polls as the screen page being seen.
     */
    val statusUrl: String
        get() = "$serverOrigin/api/screen/$stationId?k=$screenKey&overlay=1"
}

sealed interface ConfigResult {
    data class Valid(val config: ScreenConfig) : ConfigResult
    data class Invalid(val reason: String) : ConfigResult
}

/** Never log or display a full screen key. */
fun redactKey(key: String): String =
    if (key.length <= 6) "***" else "${key.take(4)}...(${key.length} chars)"

/**
 * Pure-JVM validation (java.net.URI, no android.net.Uri) so it runs in plain unit tests.
 */
object ScreenConfigParser {
    val STATION_PATTERN = Regex("^[a-z0-9-]{1,40}$")

    /** Opaque URL-safe key: RFC 3986 unreserved characters only, so it never needs escaping. */
    val KEY_PATTERN = Regex("^[A-Za-z0-9._~-]{1,512}$")

    private val ROUTE = Regex("^/screen/([^/?#]*)(?:\\?(.*))?$")
    private val SCHEME_AUTHORITY = Regex("^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)")

    /** Build a config from the three separate values (setup screen or ADB `server`/`station`/`key`). */
    fun fromParts(server: String?, station: String?, key: String?): ConfigResult {
        val origin = when (val o = normalizeOrigin(server)) {
            is Origin.Ok -> o.origin
            is Origin.Bad -> return ConfigResult.Invalid(o.reason)
        }
        val stationId = station?.trim().orEmpty()
        if (!STATION_PATTERN.matches(stationId)) {
            return ConfigResult.Invalid(
                "station must match ^[a-z0-9-]{1,40}$ (for example ps5-03); got '${stationId.take(48)}'",
            )
        }
        val screenKey = key?.trim().orEmpty()
        if (screenKey.isEmpty()) return ConfigResult.Invalid("screen key is missing")
        if (!KEY_PATTERN.matches(screenKey)) {
            return ConfigResult.Invalid(
                "screen key may only contain A-Z a-z 0-9 . _ ~ - (1-512 characters)",
            )
        }
        return ConfigResult.Valid(ScreenConfig(origin, stationId, screenKey))
    }

    /** Parse a full screen URL such as `http://192.168.100.65:5173/#/screen/ps5-03?k=Ab3dEf`. */
    fun fromScreenUrl(raw: String?): ConfigResult {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return ConfigResult.Invalid("url is empty")
        val uri = try {
            URI(text)
        } catch (e: URISyntaxException) {
            return ConfigResult.Invalid("url is not a valid URL (${e.reason})")
        }
        val fragment = uri.rawFragment
            ?: return ConfigResult.Invalid("url has no #/screen/<station>?k=<key> part")
        // Everything before '#' must be a bare origin (an optional trailing '/' is fine).
        val origin = when (val o = normalizeOrigin(text.substringBefore('#'))) {
            is Origin.Ok -> o.origin
            is Origin.Bad -> return ConfigResult.Invalid("url: ${o.reason}")
        }
        val match = ROUTE.matchEntire(fragment)
            ?: return ConfigResult.Invalid("url fragment must look like #/screen/<station>?k=<key>")
        val station = match.groupValues[1]
        val key = match.groupValues[2]
            .split('&')
            .firstOrNull { it.startsWith("k=") }
            ?.removePrefix("k=")
            ?: return ConfigResult.Invalid("url has no k=<screen key> parameter after #/screen/<station>?")
        return fromParts(origin, station, key)
    }

    sealed interface Origin {
        data class Ok(val origin: String) : Origin
        data class Bad(val reason: String) : Origin
    }

    /**
     * Accepts `http(s)://host[:port]` with an optional trailing slash. Returns a canonical origin:
     * lowercase scheme and host, default port removed, no trailing slash.
     */
    fun normalizeOrigin(raw: String?): Origin {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return Origin.Bad("server origin is missing")
        val uri = try {
            URI(text)
        } catch (e: URISyntaxException) {
            return Origin.Bad("server origin is not a valid URL (${e.reason})")
        }
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        if (scheme != "http" && scheme != "https") {
            return Origin.Bad("server origin must start with http:// or https://")
        }
        if (uri.rawUserInfo != null) return Origin.Bad("server origin must not contain a user name or password")
        val host = uri.host?.lowercase(Locale.ROOT)
        if (host.isNullOrEmpty()) return Origin.Bad("server origin has a missing or invalid host name")
        val path = uri.rawPath.orEmpty()
        if (path != "" && path != "/") return Origin.Bad("server origin must not have a path (got '$path')")
        if (uri.rawQuery != null) return Origin.Bad("server origin must not have a ?query")
        if (uri.rawFragment != null) return Origin.Bad("server origin must not have a #fragment")
        val port = uri.port
        if (port != -1 && port !in 1..65535) return Origin.Bad("server origin port must be 1-65535")
        return Origin.Ok(buildOrigin(scheme, host, port))
    }

    /** Origin (scheme://host[:port]) of any URL, or null if it is not http(s). Never throws. */
    fun originOf(url: String): String? {
        val match = SCHEME_AUTHORITY.find(url.trim()) ?: return null
        val scheme = match.groupValues[1].lowercase(Locale.ROOT)
        if (scheme != "http" && scheme != "https") return null
        val uri = try {
            URI("$scheme://${match.groupValues[2]}")
        } catch (e: URISyntaxException) {
            return null
        }
        if (uri.rawUserInfo != null) return null
        val host = uri.host?.lowercase(Locale.ROOT)
        if (host.isNullOrEmpty()) return null
        return buildOrigin(scheme, host, uri.port)
    }

    fun isSameOrigin(configOrigin: String, url: String): Boolean = originOf(url) == configOrigin

    private fun buildOrigin(scheme: String, host: String, port: Int): String {
        val isDefault = (scheme == "http" && port == 80) || (scheme == "https" && port == 443)
        return if (port == -1 || isDefault) "$scheme://$host" else "$scheme://$host:$port"
    }
}
