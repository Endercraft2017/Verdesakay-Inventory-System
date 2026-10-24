# Published Profile UI verification

Code release: `2d4c865fae5450f857e99657b3ea472f52d19b7a`, branch
`restructure/module-architecture`. Railway deployment
`c6f03f87-ff64-4748-939c-826229573415` reached SUCCESS.

Target: https://otom.afkcube.com/sandbox/m, same supplied sandbox account,
Playwright Chromium at 390×844, touch/mobile, dark theme.

Five checks passed: an existing signed-in v149-controlled browser upgraded to
v150 after publication/refresh and received the new footer; footer is 48px and
hit-testable above the dock; username input/action gap is 16px; normal footer
logout invalidates its old server token (401); borrowed footer logout clears
a local personal marker and invalidates its server token. No uncaught JS errors.
Before/after client hashes match the committed source; session cleanup complete.
No live usernames/passwords, employee records or business data were changed.

`results.json` omits credentials/tokens/headers. Screenshots show only the supplied
sandbox account UI. No raw hosted trace was recorded. `deployment.json` retains
minimal Railway terminal-state evidence without account/variable details.

Manual comparison remains pending at M01 step 6.
