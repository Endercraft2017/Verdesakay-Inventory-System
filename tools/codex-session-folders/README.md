# Codex Session Folders — browser extension, v0.1.0

A small Manifest V3 extension adding a folder panel above Codex web's session list. It supports `/local/<id>` and ordinary `/c/<id>` links on `https://chatgpt.com`. Coding continues wherever Codex already runs; the extension does not run a coding agent, model, server, or desktop helper.

## Install

1. Download `codex-session-folders.zip` and extract it. Keep the extracted folder on your computer.
2. Open your browser's Extensions page: Chrome `chrome://extensions`, Edge `edge://extensions`, Opera `opera://extensions`, or Brave `brave://extensions`.
3. Enable **Developer mode**, choose **Load unpacked**, and select the extracted `extension` folder containing `manifest.json`.
4. Reload the Codex page. A **Session folders** panel should appear above the existing sidebar links.

Chromium was tested. Chrome, Edge, Opera, and Brave installation paths are provided for their Chromium extension interfaces; those branded browsers were not separately tested. Firefox and Safari packaging is not provided. This is an unpacked preview, not a store-published extension.

## Use

- Press **+** to create a folder.
- Use the menu next to a saved session to choose its folder or **Unfiled**.
- Click a folder heading to collapse or expand it. Search temporarily reveals matching results.
- Use the pencil to rename a folder, or **×** to remove it. Removing a folder returns its links to Unfiled; it never deletes or archives Codex conversations.
- Click a session title to open its original URL.
- **Export** saves a JSON backup. **Import** replaces this browser's folder organization after confirmation. Back up before switching browsers or uninstalling.

The original Recents list remains visible and unchanged. The extension adds its own links rather than moving native rows or intercepting native menus. It learns session links as they appear in the sidebar; scroll the original Recents list to discover older sessions. It never fetches hidden history or uses private conversation APIs. If a saved link's original chat was deleted, that saved link may become stale.

## Storage and permissions

The only extension permission is `storage`. The content script runs on `https://chatgpt.com/*`. It reads sidebar session titles and URLs and stores them with folders, assignments, and collapsed state in `chrome.storage.local`. It does not read message bodies, credentials, or cookies, and it makes no network requests. The browser itself naturally loads ChatGPT and the links you open.

Folder data is local to this browser profile, not your OpenAI account. It is not account-partitioned: if you switch OpenAI accounts within one browser profile, the saved link list remains. Use separate browser profiles when appropriate. Browser tabs observe saved changes, but simultaneous edits follow last-write-wins behavior; this is not a collaborative database.

## Verification and compatibility limits

Playwright loads the real unpacked extension in headless Chromium with temporary profiles and actual Chrome extension storage. A routed synthetic page at `https://chatgpt.com/local/...` supplies representative sidebar markup. Tests cover folder creation, assignment, rename, duplicate validation, collapse/reload, session navigation, search, folder deletion, native controls, delayed/remounted sidebars, virtualized rows, native title changes, backup import/export, unsafe URL filtering, inert labels, and updates between tabs. See `TEST-REPORT.md`.

**Your authenticated Codex sidebar has not been tested.** Its selectors may differ from the fixture, and future UI updates can require adjustments. A successful fixture test is not proof of compatibility with a live account. If the panel does not appear, disable the extension and report the browser/version and a screenshot; do not paste credentials or session tokens.

## Develop / rerun

Requires Node.js 20 or later:

```sh
npm ci
npx playwright install chromium
npm test
```

No install or build command is needed to load the supplied `extension` folder. Removing or disabling the extension removes its UI without changing Codex conversations. Uninstalling can remove local folder data, so export first.
