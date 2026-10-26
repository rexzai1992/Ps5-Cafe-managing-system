# TV Test Plan: PS5 Cafe companion app on real TVs

For the owner, on the first physical test day. Two TVs: a **Prism** and a **Hisense** (models and
operating systems not known yet). Follow the steps in order and write every result in the tables.

> **Nothing here has been tried on a real TV yet.** The app was built and unit-tested on a Mac only.
> Today's results are the first real evidence. Copy them into
> [`docs/HARDWARE_LIMITATIONS.md`](HARDWARE_LIMITATIONS.md) per brand, exact model, OS version and firmware.
>
> **The app is not a lock.** It shows the TV's screen page and a "time left" box. Anyone with the
> TV remote can still press HOME or INPUT. Today you are finding out what these TVs actually do.

## 0. Before you start

You need:

- The Mac with `adb` installed (`/opt/homebrew/bin/adb`; check with `adb version` in Terminal).
- The app file: `android/tv-companion/dist/ps5-cafe-tv.apk` in this project folder.
- The PS5 Cafe server running so TVs can reach it. Follow "QR booking on real TVs and phones" in
  the main `README.md`. Then on the Mac open the dashboard and go to
  **Device Settings → TV screens and QR booking**. Each TV has a **screen link** and an
  **ADB setup command** with a Copy button.
- The Mac and both TVs on the same **staff** network (not the customer Wi-Fi).
- A PS5 plugged into each TV. Write down which HDMI port number it is in.
- A phone with a stopwatch and camera (photos of what the TV shows are good evidence).

In Terminal, go to the project folder first:

```bash
cd ~/Ps5-cafe
```

Commands below assume you are in that folder. Replace `TV_IP`, `PORT` and `URL` with real values.
If more than one TV is connected to `adb`, put `-s TV_IP:PORT` after `adb` in every command, for
example `adb -s 192.168.100.70:5555 shell ...`.

## 1. Identify each TV

On the TV open **Settings → About**. On Android TV this is usually **Settings → Device Preferences
→ About**; on Google TV **Settings → System → About**; on Hisense VIDAA **Settings → Support →
System Information** (or **About**).

Write down:

| | Prism | Hisense |
|---|---|---|
| Brand | | |
| Exact model number (also on the sticker on the back) | | |
| Operating system: Android TV / Google TV / VIDAA / other | | |
| OS version (for example "Android TV OS 11") | | |
| Firmware or build number | | |
| Region (if shown) | | |
| Network: Wi-Fi or Ethernet cable | | |
| TV IP address (Settings → Network) | | |
| HDMI port the PS5 is plugged into | | |

How to tell the operating system:

- **Android TV / Google TV:** the About page says "Android TV OS" or shows an Android version, and
  the **Google Play Store** app exists. The APK can be installed. Continue with step 2.
- **VIDAA (common on Hisense):** the About or System Information page says **VIDAA**, there is no
  Google Play Store, and the app store is called VIDAA Store or App Store. **VIDAA cannot install
  APK files. Skip steps 2 to 7 for this TV** and do the browser test below instead.
- **Anything else** (Tizen, webOS, Roku, ...): same as VIDAA, browser test only.

### Browser test (VIDAA or other non-Android TV only)

1. Look for a web browser app on the TV (often called "Browser" or "Internet").
2. Open it and type the TV's **screen link** from the dashboard exactly.
3. Record below. There is no timer box, no Diagnostics and no ADB on these TVs.

| Browser test | Result |
|---|---|
| Is there a browser app? Name? | |
| Does the screen page load? (If it says "could not start", write down the whole message: it names the browser version.) | |
| Can it be full screen (no address bar)? | |
| Do ad videos play by themselves? | |
| Is the QR code visible and does a phone scan work? | |
| Still showing after 30 minutes with nobody touching the remote? | |
| After switching to the PS5 input and back, is the page still there or reloaded? | |

## 2. Turn on network debugging (Android TV / Google TV only)

1. **Turn on Developer options.** Open the About page from step 1, select **Build** (on Google TV
   "Android TV OS build"), and press OK on it **7 times** until it says you are a developer.
2. Go back and open **Developer options** (Settings → Device Preferences → Developer options, or
   Settings → System → Developer options).
3. Which option you see depends on the Android version:

   **A. "Wireless debugging" (newer TVs, Android 11 and later; Google documents it for TVs from Android 13):**

   1. Turn **Wireless debugging** on. If asked "Allow wireless debugging on this network?", choose
      **Allow**, but **do not tick "Always allow on this network"**.
   2. Open Wireless debugging → **Pair device with pairing code**. The TV shows a 6-digit code and an
      address like `192.168.100.70:37123`.
   3. On the Mac: `adb pair TV_IP:PAIRING_PORT` and type the 6-digit code. It should say "Successfully paired".
   4. The main Wireless debugging page shows another address with a **different port**. On the Mac:
      `adb connect TV_IP:PORT` using that one.
   5. If it says Wireless debugging needs Wi-Fi and the TV uses a cable, write that down. Connect the
      TV to the staff Wi-Fi for the test if possible.

   **B. "Network debugging" or "ADB debugging" with no pairing code (older TVs, Android 9/10 and some others):**

   1. Turn on **USB debugging** and, if present, **Network debugging** / **ADB over network**.
   2. On the Mac: `adb connect TV_IP:5555`

   **C. Neither option exists:** stop here for this TV and write "no network ADB" in the results.

4. The TV may show **"Allow USB debugging?"** with a long code (an RSA key fingerprint). Choose
   **OK/Allow**. Ticking "Always allow from this computer" is fine for today; it is revoked in step 9.
5. Check: `adb devices` must show `TV_IP:PORT    device`. If it says `unauthorized`, look at the TV
   for the prompt and accept it. If it says `offline`, run `adb disconnect` and connect again.

| Network debugging | Prism | Hisense |
|---|---|---|
| Which option existed (A, B or C)? | | |
| Pairing steps that worked | | |
| Did an "Allow USB debugging?" prompt appear? | | |
| Port used | | |

## 3. Record the TV's identity with ADB

These commands only read information:

```bash
adb shell getprop ro.product.manufacturer
adb shell getprop ro.product.brand
adb shell getprop ro.product.model
adb shell getprop ro.product.device
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.sdk
adb shell getprop ro.build.display.id
adb shell getprop ro.build.fingerprint
adb shell getprop ro.build.version.security_patch
adb shell getprop ro.board.platform
```

Save full copies for the engineers (change `prism` to `hisense` for the other TV):

```bash
adb shell getprop > prism-getprop.txt
adb shell pm list features > prism-features.txt
adb shell dumpsys webviewupdate > prism-webview.txt
adb shell dumpsys tv_input > prism-tv_input.txt
```

## 4. Install and configure the app

1. Install:

   ```bash
   adb install -r android/tv-companion/dist/ps5-cafe-tv.apk
   ```

   It must print `Success`. If it prints `INSTALL_FAILED_...`, copy the whole message into the results.
2. Configure it. On the dashboard (**Device Settings → TV screens and QR booking**) copy this TV's
   **ADB setup command** and paste it into Terminal. Or type it yourself in this form (keep both
   kinds of quotes exactly as shown):

   ```bash
   adb shell "am start -n com.ps5cafe.tvcompanion/.MainActivity --es url 'URL'"
   ```

   where `URL` is the TV's screen link, like `http://192.168.100.65:8080/#/screen/ps5-03?k=...` (live mode, started
   with `npm run start:live`; copy it from Device Settings, the key is different for every TV).
   The TV should show the screen page, with a short message "Screen configuration saved".

   **If the screen says "The PS5 Cafe page could not start (…)" or stays black** with no "Cannot reach
   the server" message, the TV's built-in web engine (Android System WebView) may be too old for the
   page. Photograph or copy the whole message (it ends with the browser version), then run
   `adb logcat -d -s PS5CafeWeb` (page errors) and note the WebView version from
   `prism-webview.txt` or Diagnostics. Updating "Android System WebView" from the Play Store may fix it.
3. Allow the time box to appear over other apps (Android TV usually hides this setting):

   ```bash
   adb shell appops set com.ps5cafe.tvcompanion SYSTEM_ALERT_WINDOW allow
   adb shell appops get com.ps5cafe.tvcompanion SYSTEM_ALERT_WINDOW
   ```

   The second command should print `SYSTEM_ALERT_WINDOW: allow`. (`adb shell pm grant` does **not**
   work for this permission.)
4. Start a log window. Open a **second** Terminal window and run:

   ```bash
   adb logcat -c
   adb logcat -s PS5CafeDiag
   ```

   Leave it open. Everything the app does appears there. To save it later:
   `adb logcat -d -s PS5CafeDiag > prism-log.txt`. If nothing ever appears, this TV may block app
   logs; then take photos of the Diagnostics screen instead.

| Install and screen page | Prism | Hisense |
|---|---|---|
| `adb install` result | | |
| App icon/banner visible in the TV's app list? | | |
| Screen page shows after the configure command? (black screen: see the WebView note above) | | |
| Ad videos play by themselves? | | |
| Page fills the whole screen (nothing cut off at the edges)? | | |
| Short BACK press ignored? | | |
| Holding BACK about 3 s opens the setup screen? | | |
| HOME leaves the app? (expected: yes; it is not a lock) | | |
| Stop the server: "Cannot reach the PS5 Cafe server — retrying in N s" appears? | | |
| Start the server again: page comes back by itself? Time taken | | |
| Still on screen after 30 min without touching the remote (no screensaver / eco power-off)? | | |

## 5. Diagnostics and input switching

1. Open Diagnostics:

   ```bash
   adb shell am start -n com.ps5cafe.tvcompanion/.MainActivity --ez diagnostics true
   ```

   (Or hold BACK for 3 s on the screen page and choose **Diagnostics**.)
2. Press **Write report to logcat (PS5CafeDiag)**. The full report appears in the log window. Save it:
   `adb logcat -d -s PS5CafeDiag > prism-diag.txt`. Also photograph the Diagnostics screen.
3. Under "TV inputs that accept a passthrough switch request" each HDMI input has a
   **Try switch to this input** button. For each one:
   1. Start the phone stopwatch and press the button.
   2. Watch the TV. Did it change to that HDMI input? Which physical port was it? How many seconds?
   3. Return to the app: press HOME and open **PS5 Cafe Screen**, or run the Diagnostics command from 1.
   4. Diagnostics shows "Last switch attempt" with what Android answered. "Android accepted the
      request" does **not** mean the TV switched; only your eyes can tell.

Optional extra input checks over ADB. These do change the TV input; that is the point of today's test:

```bash
adb shell input keyevent 243    # HDMI 1 (244 = HDMI 2, 245 = HDMI 3, 246 = HDMI 4)
adb shell am start -a android.intent.action.VIEW -d "PASSTHROUGH_URI"
```

Copy `PASSTHROUGH_URI` exactly from the "passthrough URI" line in the Diagnostics report.

| Diagnostics | Prism | Hisense |
|---|---|---|
| Inputs listed (count, labels) | | |
| HDMI input with the PS5: label and id | | |
| "Try switch" to the PS5 input: did the TV switch? seconds | | |
| "Try switch" to another HDMI input: did the TV switch? | | |
| `input keyevent 243-246`: which port did each select? | | |
| Any error text (ActivityNotFound, SecurityException, empty list) | | |
| WebView version (from the report) | | |
| CSS viewport (from the report, Display line) | | |

## 6. Timer box over the PS5 picture (key test)

The box should appear in the top-right corner while a session is running and the TV shows the PS5.
Some TVs draw the HDMI picture on a separate hardware layer, or hide app overlays in game mode, so
the box may not be visible at all. That is exactly what this step finds out.

1. **Permission:** Diagnostics shows "Display over other apps is GRANTED". If it says NOT granted,
   repeat step 4.3.
2. **Quick test:** in Diagnostics press **Test overlay (10 s)**, then within 10 seconds switch the TV
   to the PS5 input (remote INPUT button, or a **Try switch** button). For more time:

   ```bash
   adb shell am start -n com.ps5cafe.tvcompanion/.MainActivity --ei overlay_test 120
   ```

   then switch to the PS5 input. The box shows a fake `0:09:59` counting down in amber.
3. **Real session:** on the dashboard, start a session on this TV's station. Switch the TV to the PS5.
   Check the box shows "Time left" and counts down. Then on the dashboard: **pause** (box should say
   "Paused" within about 5 s), **resume**, use **Set remaining…** to set 9 minutes (box turns amber),
   then under 1 minute (box turns red), then **end** the session (box disappears within about 5 s).
4. **Game mode / ALLM:** repeat the real-session check with the TV's game mode (also called Game
   Mode, ALLM, Auto Low Latency Mode, Instant Game Response) **on**, then **off**.
5. **Lag:** play something responsive for a few minutes with the box showing and without it
   (end the session or stop the service with `adb shell am force-stop com.ps5cafe.tvcompanion`).
   Does the game feel slower, stutter, or does the TV's game-mode indicator turn off?
6. **Switching inputs:** with the box showing, switch HDMI to another input and back, press HOME, open
   another app. Does the box stay?
7. **Server lost:** with the box showing, stop the server or unplug the Mac's network. The box must
   disappear within about 30 s and must never show an old time.
8. **Reboot:** with a session running, restart the TV (`adb reboot` or the TV's power menu). After it
   starts again, without opening the app: does the box come back? Does the screen page open by itself?
   Look in Diagnostics at "Last BOOT_COMPLETED received" and "Last boot launch reached the screen".
9. **Force-stop:** `adb shell am force-stop com.ps5cafe.tvcompanion`. The box disappears and stays
   gone until the app is opened again (expected). Open it again with the configure command.
10. **Time's up and back to the screen** (do this after step 3, before force-stop): start a **1-minute** session (dashboard:
   open the TV's panel → **Custom…** → 1 minute), switch the TV to the PS5 and wait. At 0:00 the box should
   turn red and say **Time's up**, and within about 5 s the app should bring its screen page to the front ("Time expired").
   On the dashboard the tile should go from "Expired screen sent" to **shown**. Then switch the TV back to the PS5 with the
   remote: after about 15 s the tile must say **NOT shown** (it is software only). Press **End**: the screen page should
   come to the front again with ads and the QR code. Log: `adb logcat -d -s PS5CafeDiag | grep "front"`.
11. **Switch to the PS5 automatically (opt-in):** plug the PS5 in, then
   `adb shell "am start -n com.ps5cafe.tvcompanion/.MainActivity --es ps5_input auto"`. Press **15m** on the dashboard: within
   about 10 s the TV should show the PS5 picture with the time box (log: `Showing the PS5 input …` and `picture available`).
   End → ads + QR come back. If the log says `connection failed` or `no HDMI source connected`, turn it off again with
   `--es ps5_input off` and record the result for this model.

| Timer box | Prism | Hisense |
|---|---|---|
| Permission granted with the appops command? | | |
| Test box visible on top of the PS5 picture? (photo) | | |
| Box cut off at the edge? | | |
| Real session: counts down correctly vs the dashboard? | | |
| Paused / amber / red / disappears on end? | | |
| Visible with game mode / ALLM **on**? | | |
| Visible with game mode / ALLM **off**? | | |
| Any visible lag or game-mode indicator change? | | |
| Stays after switching inputs / HOME / other app? | | |
| Disappears within 30 s when the server is unreachable? | | |
| After reboot: box back without opening the app? Screen page opened itself? | | |
| After force-stop: box gone until the app is opened? | | |
| At expiry: red "Time's up" box over the PS5? | | |
| At expiry: screen page came to the front by itself (Time expired)? Seconds? | | |
| Dashboard: expired screen "shown", then "NOT shown" ~15 s after switching back to the PS5? | | |
| After End: screen page came to the front with ads + QR? | | |

## 7. Recovery, bypass and security checks

| Check | How | Prism | Hisense |
|---|---|---|---|
| **CEC wake after expiry** | Let a session expire so the expired screen is up. Wake the PS5 from rest with its controller. Does the TV switch to the PS5 by itself? Try with the TV's HDMI-CEC setting on and off (names include "CEC", "HDMI Control", "Anynet+", "BRAVIA Sync", "SimpLink") and the PS5's HDMI Device Link on and off. | | |
| **Customer phone pairing** | From a phone on the **customer** Wi-Fi, open the Google TV app (or the brand's remote app, e.g. VIDAA / RemoteNOW for Hisense). Can it find the TV? Does a pairing code appear over the screen? Can it change input? Pass = TV not reachable from the customer network. | | |
| **Mains power cycle** | During an expired session unplug the TV at the wall for 30 s. On power-up: which input? Does the app/screen come back by itself? Time until the dashboard sees it. | | |
| **Standby** | Put the TV in standby with the remote and wake it. Is the screen page still there? Timer box? | | |
| **Server restart** | Restart the PS5 Cafe server. Does the screen page recover by itself? | | |
| **Firmware** | Is automatic firmware update on? Current firmware (step 1). | | |

## 8. Results summary (mirrors docs/HARDWARE_LIMITATIONS.md)

Fill in one column per TV. "Not tested" is a valid answer; guesses are not.

| Field | Prism | Hisense |
|---|---|---|
| Identity: manufacturer, exact model, region, OS and firmware | | |
| Pairing: ADB authorization steps and how to revoke them | | |
| Network: port/protocol, reconnect after the TV's IP changes | | |
| Commands: each HDMI input (passthrough intent and keyevent 243-246), app launch by ADB | | |
| Modes: idle screen page, gameplay (PS5 input + timer box), expiry screen | | |
| Verification: what the app could read back vs what you only saw with your eyes | | |
| Recovery: standby, reboot, server restart, TV offline, ADB authorization revoked | | |
| Performance: game feel with the box, app idle (photo of Diagnostics is enough) | | |
| Security: ADB turned off afterwards, TV not reachable from customer Wi-Fi | | |
| CEC wake after expiry | | |
| Customer phone pairing | | |
| Mains power cycle | | |
| Firmware change: version before/after, auto-update on/off | | |
| Timer box visible over HDMI (game mode on / off) | | |
| Launch after boot reached the screen | | |

Send the engineers: this filled-in file, the saved `*-getprop.txt`, `*-features.txt`,
`*-webview.txt`, `*-tv_input.txt`, `*-diag.txt`, `*-log.txt` files, and the photos.

## 9. Safety: when you are finished

1. On each TV: Developer options → turn **Wireless debugging** / **Network debugging** / **USB
   debugging** **off**. Also choose **Revoke USB debugging authorizations**. You may turn Developer
   options off completely.
2. On the Mac: `adb disconnect`
3. **Never** port-forward port 5555 (or any ADB port) on the router, and never put the TVs on the
   customer Wi-Fi. Exposed ADB ports are attacked by botnets.
4. The app keeps its configuration and its overlay permission. To remove the overlay permission:
   `adb shell appops set com.ps5cafe.tvcompanion SYSTEM_ALERT_WINDOW default`. To remove the app:
   `adb uninstall com.ps5cafe.tvcompanion` (or Settings → Apps on the TV).
5. Remember: a customer with the remote can still leave the app (HOME, INPUT) and the box is
   information only. Write down what you saw; do not describe it as a lock.
