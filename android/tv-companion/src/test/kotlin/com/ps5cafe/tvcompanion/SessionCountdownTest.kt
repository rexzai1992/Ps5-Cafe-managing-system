package com.ps5cafe.tvcompanion

import org.json.JSONException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionCountdownTest {

    private fun sample(status: String, remainingMs: Long, serverTime: Long = 1_700_000_000_000L, midpoint: Long = 50_000L) =
        StatusSample(ScreenStatus(status, if (status == "ACTIVE" || status == "PAUSED") "PLAYING" else "IDLE", serverTime, remainingMs), midpoint)

    @Test
    fun parsesTheScreenEndpointBody() {
        val body = """
            {"station":{"id":"ps5-03","name":"PS5-03","number":3},"serverTime":1761400000000,
             "mode":"PLAYING","sessionStatus":"ACTIVE","remainingMs":6130000,"reservation":null,"qr":null}
        """.trimIndent()
        val s = ScreenStatusParser.parse(body)
        assertEquals("ACTIVE", s.sessionStatus)
        assertEquals("PLAYING", s.mode)
        assertEquals(1_761_400_000_000L, s.serverTime)
        assertEquals(6_130_000L, s.remainingMs)
    }

    @Test(expected = JSONException::class)
    fun rejectsBodiesWithoutTheFields() {
        ScreenStatusParser.parse("""{"error":"forbidden"}""")
    }

    @Test(expected = JSONException::class)
    fun rejectsNonJson() {
        ScreenStatusParser.parse("<html>proxy error</html>")
    }

    @Test
    fun formatsAsHoursMinutesSecondsRoundedUp() {
        assertEquals("1:42:10", SessionCountdown.format(6_130_000L))
        assertEquals("0:09:59", SessionCountdown.format(599_000L))
        assertEquals("0:00:01", SessionCountdown.format(1L))
        assertEquals("0:00:00", SessionCountdown.format(0L))
        assertEquals("0:00:00", SessionCountdown.format(-5_000L))
        assertEquals("12:00:00", SessionCountdown.format(43_200_000L))
    }

    @Test
    fun activeCountsDownLocallyFromTheServerSample() {
        val s = sample("ACTIVE", remainingMs = 600_000L, midpoint = 50_000L)
        val atSample = SessionCountdown.compute(s, lastSuccessElapsed = 50_000L, nowElapsed = 50_000L)
        assertTrue(atSample.visible)
        assertEquals(600_000L, atSample.remainingMs)
        val later = SessionCountdown.compute(s, lastSuccessElapsed = 50_000L, nowElapsed = 54_000L)
        assertEquals(596_000L, later.remainingMs)
        assertEquals("0:09:56", later.text)
        assertFalse(later.paused)
    }

    @Test
    fun pausedHoldsTheServerValue() {
        val s = sample("PAUSED", remainingMs = 1_800_000L)
        val v = SessionCountdown.compute(s, lastSuccessElapsed = 50_000L, nowElapsed = 70_000L)
        assertTrue(v.visible)
        assertTrue(v.paused)
        assertEquals(1_800_000L, v.remainingMs)
    }

    @Test
    fun hiddenForOtherSessionStates() {
        for (status in listOf("NONE", "ENDED", "SOMETHING_NEW")) {
            assertFalse(status, SessionCountdown.compute(sample(status, 0L), 50_000L, 50_000L).visible)
        }
        assertFalse(SessionCountdown.compute(null, 0L, 50_000L).visible)
    }

    @Test
    fun saysTimesUpInRedOnceTheSessionRunsOut() {
        val view = SessionCountdown.compute(sample("EXPIRED", 0L), 50_000L, 50_000L)
        assertTrue(view.visible)
        assertTrue(view.expired)
        assertEquals(CountdownLevel.CRITICAL, view.level)
        // Still only while the server vouches for it.
        assertFalse(SessionCountdown.compute(sample("EXPIRED", 0L), 50_000L, 50_000L + SessionCountdown.STALE_AFTER_MS + 1).visible)
    }

    @Test
    fun findsHdmiInputsByLabelThenByOrder() {
        val hisense = listOf("x/.HdmiInputService/HW4" to "HW4", "x/.HdmiInputService/HW2" to "HW2", "x/.HdmiInputService/HW3" to "HW3", "x/.HdmiInputService/HW5" to "HW5")
        assertEquals("x/.HdmiInputService/HW2", Ps5Input.pickHdmi(hisense, 1))
        assertEquals("x/.HdmiInputService/HW5", Ps5Input.pickHdmi(hisense, 4))
        assertEquals(null, Ps5Input.pickHdmi(hisense, 5))
        val labelled = listOf("a" to "HDMI 2", "b" to "HDMI 1")
        assertEquals("b", Ps5Input.pickHdmi(labelled, 1))
        assertEquals(null, Ps5Input.pickHdmi(labelled, 0))
    }

    @Test
    fun showsThePs5WhenASessionBecomesActive() {
        for (previous in listOf(null, "NONE", "ENDED", "EXPIRED", "PAUSED")) {
            assertTrue("$previous -> ACTIVE", SessionCountdown.ps5ShouldShow(previous, "ACTIVE"))
        }
        for ((previous, current) in listOf("ACTIVE" to "ACTIVE", "ACTIVE" to "PAUSED", "ACTIVE" to "EXPIRED", "NONE" to "NONE", null to "EXPIRED")) {
            assertFalse("$previous -> $current", SessionCountdown.ps5ShouldShow(previous, current))
        }
    }

    @Test
    fun bringsTheScreenBackOnlyWhenASessionExpiresOrEnds() {
        assertEquals("session expired", SessionCountdown.screenShouldReturn("ACTIVE", "EXPIRED"))
        assertEquals("session expired", SessionCountdown.screenShouldReturn("PAUSED", "EXPIRED"))
        assertEquals("session ended", SessionCountdown.screenShouldReturn("ACTIVE", "ENDED"))
        assertEquals("session ended", SessionCountdown.screenShouldReturn("EXPIRED", "ENDED"))
        assertEquals("session ended", SessionCountdown.screenShouldReturn("EXPIRED", "NONE"))
        // No change, a session starting, or the first poll after the service starts: leave the TV alone.
        for ((previous, current) in listOf("ACTIVE" to "ACTIVE", "EXPIRED" to "EXPIRED", "NONE" to "ACTIVE", "ENDED" to "NONE",
            "EXPIRED" to "ACTIVE", null to "EXPIRED", null to "NONE")) {
            assertEquals("$previous -> $current", null, SessionCountdown.screenShouldReturn(previous, current))
        }
    }

    @Test
    fun neverShowsAStaleTime() {
        val s = sample("ACTIVE", remainingMs = 3_600_000L)
        assertTrue(SessionCountdown.compute(s, lastSuccessElapsed = 50_000L, nowElapsed = 80_000L).visible)
        assertFalse(SessionCountdown.compute(s, lastSuccessElapsed = 50_000L, nowElapsed = 80_001L).visible)
    }

    @Test
    fun clampsAtZeroWhenTheDeadlinePassesBeforeTheNextPoll() {
        val s = sample("ACTIVE", remainingMs = 2_000L)
        val v = SessionCountdown.compute(s, lastSuccessElapsed = 50_000L, nowElapsed = 55_000L)
        assertTrue(v.visible)
        assertEquals(0L, v.remainingMs)
        assertEquals("0:00:00", v.text)
        assertEquals(CountdownLevel.CRITICAL, v.level)
    }

    @Test
    fun colourLevelsAtTenMinutesAndOneMinute() {
        assertEquals(CountdownLevel.NORMAL, SessionCountdown.levelFor(600_001L))
        assertEquals(CountdownLevel.WARNING, SessionCountdown.levelFor(600_000L))
        assertEquals(CountdownLevel.WARNING, SessionCountdown.levelFor(60_001L))
        assertEquals(CountdownLevel.CRITICAL, SessionCountdown.levelFor(60_000L))
        assertEquals(CountdownLevel.CRITICAL, SessionCountdown.levelFor(0L))
    }

    @Test
    fun statusUrlFollowsTheContract() {
        val cfg = ScreenConfig("http://192.168.100.65:5173", "ps5-03", "Ab3dEf")
        assertEquals("http://192.168.100.65:5173/api/screen/ps5-03?k=Ab3dEf&overlay=1", cfg.statusUrl)
    }
}
