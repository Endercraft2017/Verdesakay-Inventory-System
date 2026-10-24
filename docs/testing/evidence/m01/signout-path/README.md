# M01 step 6 path recheck

2026-10-24 Asia/Manila. The user reported a missing Profile sign-out path and supplied a
screenshot of the desktop right-side toolbar. Their exact URL/device/browser remain unknown.

Playwright Chromium, Android UA/touch, 390×844; same supplied sandbox account.
Tested `https://otom.afkcube.com/sandbox/m?view=mobile` after establishing a desktop preference.
It redirects to `/sandbox/m`, shows the mobile bottom dock and exposes Account & security
under Profile. The Sign out button starts below the initial security viewport, then becomes
visible after scrolling. Clicking it returns to sign-in and the old token receives 401.

`results.json` records element positions, sanitized method/path/status, stable Profile asset
fingerprints and successful session cleanup. `profile-menu.png` and `security-top.png` show
the route. The lower security screenshot remains in private work space because session lists
may contain device/network details. No password, token or raw hosted trace is included here.

The desktop shell was identified by read-only markup markers only. Its functions were not
tested; the user's side-panel sign-out result is user-reported. No app code changed.
