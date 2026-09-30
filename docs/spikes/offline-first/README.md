# Offline-first phase-0 spikes (2026-09-30)

Throwaway proofs for `docs/OFFLINE-FIRST.md` §9. Not app code and not part of the test suite;
phase 1 re-implements the proven parts in TypeScript under `src/sync/` with real tests.

| Script | Proves | Run |
|---|---|---|
| `invert.mjs` | SQLite changeset inverter (node:sqlite has no invert API) | imported by `spike-rebase.mjs` |
| `spike-rebase.mjs` | capture → invert → apply confirmed effect → re-run = git-style rebase; converges with the cloud's replay; stale effects raise a conflict | `node spike-rebase.mjs` |
| `spike-clock-ids.mjs` | `datetime('now')` / `date('now')` override = command clock (incl. column DEFAULTs); plain AUTOINCREMENT jumps into another node's ID range | `node spike-clock-ids.mjs` |
| `spike-renumber.mjs` | renumber-after-insert ID allocation for every INSERT shape we use; changeset carries only final IDs | `node spike-renumber.mjs` |
| `spike-electron-sqlite.cjs` | Electron's Node has node:sqlite sessions, changesets, UDF override | `ELECTRON_RUN_AS_NODE=1 electron spike-electron-sqlite.cjs` |
