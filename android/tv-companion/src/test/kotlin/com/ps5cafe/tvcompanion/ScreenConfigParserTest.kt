package com.ps5cafe.tvcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ScreenConfigParserTest {

    private fun valid(result: ConfigResult): ScreenConfig = when (result) {
        is ConfigResult.Valid -> result.config
        is ConfigResult.Invalid -> {
            fail("expected valid, got: ${result.reason}")
            throw AssertionError()
        }
    }

    private fun assertInvalid(result: ConfigResult) {
        assertTrue("expected invalid, got $result", result is ConfigResult.Invalid)
    }

    @Test
    fun parsesContractExampleUrl() {
        val cfg = valid(ScreenConfigParser.fromScreenUrl("http://192.168.100.65:5173/#/screen/ps5-03?k=Ab3dEf_-9"))
        assertEquals("http://192.168.100.65:5173", cfg.serverOrigin)
        assertEquals("ps5-03", cfg.stationId)
        assertEquals("Ab3dEf_-9", cfg.screenKey)
        assertEquals("http://192.168.100.65:5173/#/screen/ps5-03?k=Ab3dEf_-9", cfg.screenUrl)
    }

    @Test
    fun screenUrlRoundTrips() {
        val cfg = ScreenConfig("http://10.0.0.5:3000", "ps5-10", "key.with~unreserved-chars_1")
        assertEquals(cfg, valid(ScreenConfigParser.fromScreenUrl(cfg.screenUrl)))
    }

    @Test
    fun acceptsUrlWithoutSlashBeforeHashAndWithWhitespace() {
        val cfg = valid(ScreenConfigParser.fromScreenUrl("  http://192.168.1.2:5173#/screen/ps5-01?k=abcdef  "))
        assertEquals("http://192.168.1.2:5173", cfg.serverOrigin)
    }

    @Test
    fun ignoresOtherParamsAfterKey() {
        val cfg = valid(ScreenConfigParser.fromScreenUrl("http://h:5173/#/screen/ps5-01?x=1&k=abcdef&y=2"))
        assertEquals("abcdef", cfg.screenKey)
    }

    @Test
    fun normalizesSchemeHostAndDefaultPorts() {
        assertEquals("https://cafe.lan", valid(ScreenConfigParser.fromScreenUrl("HTTPS://Cafe.LAN:443/#/screen/ps5-01?k=abcdef")).serverOrigin)
        assertEquals("http://cafe.lan", valid(ScreenConfigParser.fromParts("http://cafe.lan:80/", "ps5-01", "abcdef")).serverOrigin)
    }

    @Test
    fun rejectsBadUrls() {
        listOf(
            "",
            "ps5-03",
            "192.168.100.65:5173/#/screen/ps5-03?k=abc",
            "ftp://192.168.100.65/#/screen/ps5-03?k=abc",
            "javascript:alert(1)",
            "file:///sdcard/x.html#/screen/ps5-03?k=abc",
            "http://user:pw@192.168.100.65:5173/#/screen/ps5-03?k=abc",
            "http://192.168.100.65:5173/app/#/screen/ps5-03?k=abc",
            "http://192.168.100.65:5173/?k=abc#/screen/ps5-03",
            "http://192.168.100.65:5173/",
            "http://192.168.100.65:5173/#/dashboard",
            "http://192.168.100.65:5173/#/screen/PS5-03?k=abc",
            "http://192.168.100.65:5173/#/screen/ps5_03?k=abc",
            "http://192.168.100.65:5173/#/screen/${"a".repeat(41)}?k=abc",
            "http://192.168.100.65:5173/#/screen/ps5-03",
            "http://192.168.100.65:5173/#/screen/ps5-03?k=",
            "http://192.168.100.65:5173/#/screen/ps5-03?k=a%20b",
            "http://192.168.100.65:99999/#/screen/ps5-03?k=abc",
            "http://bad host/#/screen/ps5-03?k=abc",
        ).forEach { assertInvalid(ScreenConfigParser.fromScreenUrl(it)) }
    }

    @Test
    fun validatesParts() {
        valid(ScreenConfigParser.fromParts("http://192.168.100.65:5173", "ps5-03", "Ab3dEf"))
        valid(ScreenConfigParser.fromParts("http://192.168.100.65:5173/", "a", "k"))
        valid(ScreenConfigParser.fromParts("http://h", "a".repeat(40), "k".repeat(512)))
        assertInvalid(ScreenConfigParser.fromParts(null, "ps5-03", "abc"))
        assertInvalid(ScreenConfigParser.fromParts("http://h", null, "abc"))
        assertInvalid(ScreenConfigParser.fromParts("http://h", "ps5-03", null))
        assertInvalid(ScreenConfigParser.fromParts("http://h", "", "abc"))
        assertInvalid(ScreenConfigParser.fromParts("http://h", "ps5 03", "abc"))
        assertInvalid(ScreenConfigParser.fromParts("http://h", "ps5-03", "k".repeat(513)))
        assertInvalid(ScreenConfigParser.fromParts("http://h", "ps5-03", "a/b"))
        assertInvalid(ScreenConfigParser.fromParts("http://h/path", "ps5-03", "abc"))
        assertInvalid(ScreenConfigParser.fromParts("http://h?x=1", "ps5-03", "abc"))
        assertInvalid(ScreenConfigParser.fromParts("http://h#x", "ps5-03", "abc"))
        assertInvalid(ScreenConfigParser.fromParts("content://h", "ps5-03", "abc"))
    }

    @Test
    fun sameOriginCheckOnlyAllowsTheConfiguredOrigin() {
        val origin = "http://192.168.100.65:5173"
        assertTrue(ScreenConfigParser.isSameOrigin(origin, "http://192.168.100.65:5173/"))
        assertTrue(ScreenConfigParser.isSameOrigin(origin, "http://192.168.100.65:5173/assets/app.js?v=1#x"))
        assertTrue(ScreenConfigParser.isSameOrigin(origin, "HTTP://192.168.100.65:5173/#/screen/ps5-01?k=a"))
        assertTrue(ScreenConfigParser.isSameOrigin("http://h", "http://h:80/x"))
        assertFalse(ScreenConfigParser.isSameOrigin(origin, "http://192.168.100.65:3000/"))
        assertFalse(ScreenConfigParser.isSameOrigin(origin, "https://192.168.100.65:5173/"))
        assertFalse(ScreenConfigParser.isSameOrigin(origin, "http://192.168.100.66:5173/"))
        assertFalse(ScreenConfigParser.isSameOrigin(origin, "http://192.168.100.65:5173@evil.example/"))
        assertFalse(ScreenConfigParser.isSameOrigin(origin, "javascript:alert(1)"))
        assertFalse(ScreenConfigParser.isSameOrigin(origin, "intent://scan/#Intent;scheme=zxing;end"))
        assertFalse(ScreenConfigParser.isSameOrigin(origin, "market://details?id=x"))
        assertFalse(ScreenConfigParser.isSameOrigin(origin, "file:///android_asset/x.html"))
        assertFalse(ScreenConfigParser.isSameOrigin(origin, "about:blank"))
        assertFalse(ScreenConfigParser.isSameOrigin(origin, "not a url"))
    }

    @Test
    fun redactedUrlNeverContainsTheKey() {
        val key = "SuperSecretScreenKey123"
        val cfg = ScreenConfig("http://h:5173", "ps5-01", key)
        assertFalse(cfg.redactedScreenUrl.contains(key))
        assertFalse(redactKey("abc123").contains("abc123"))
    }
}
