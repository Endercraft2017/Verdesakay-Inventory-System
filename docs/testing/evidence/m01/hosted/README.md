# Current hosted M01 comparison

- Target: `https://otom.afkcube.com/sandbox/m`.
- Account: `sandbox`, Administrator, no linked employee. Credentials supplied in chat;
  no password or bearer tokens are included here.
- Test date: 2026-10-24 Asia/Manila. Final session run began 06:05 local time.
- Browser: Playwright Chromium 151.0.7922.173, Android UA, touch/mobile emulation,
  390×844. Real-device results remain pending.
- Source checkout: `restructure/module-architecture` at `5b5830e`. Four relevant
  deployed assets were fingerprinted before and after the final session run:
  mobile app, API client, Profile and Home. They were stable and matched the checkout.
  This establishes those client assets, not the entire server's deployed Git SHA.
- Initial inspection saw an older app.js asset; a second session run was performed
  after the deployed asset changed. `results.json` is the stable final run.

Eight session checks passed (M01-01 through M01-07 and M01-08a). Show/Hide password
also passed separately using dummy text (`login-controls.json`). Fresh sign-in
already loads `/auth/me`; approvals work without refreshing, so the old local
patch is superseded. `Employee record needed` is expected for this account.

`fresh-signin.png`, `borrowed-phone.png`, `wrong-password.png`, `offline.png` and
`login.png` record visible states; password fields were masked. Results retain
HTTP method/path/status, console messages and public account role only. No hosted
trace or request headers/bodies were saved. Old-token rejection (401) and the
caller's session history (`end_reason: logout`) independently confirmed logout.
All three sessions created by the final run were ended or already ended in cleanup.

Not tested: cross-account isolation (second account unavailable), linked-employee
identity on this host, MFA challenge (not enabled for this test), recovery email,
and physical phone OS/tab restoration. Recovery, username/password changes and
MFA setup belong to the later account-security round, not this credential/session pass.

Expected console errors: deliberate wrong-password, offline and ended-session probes.
A browser warning reports an unrecognized Bluetooth Permissions-Policy feature.
No uncaught JavaScript errors or horizontal overflow were observed.

`current-sync-guard.txt` separately confirms the older suite failure F-002 is
resolved on the fetched checkout. The full suite was not rerun for this documentation-only update.
