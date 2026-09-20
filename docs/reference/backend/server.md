# `server.ts`

## Purpose
The process entry point. Initializes the database, schedules periodic session cleanup, builds the Express app, and starts listening on all network interfaces so other office PCs on the LAN can reach it. Run via `npm start` / `npm run dev` (both invoke `tsx server.ts`, no build step).

## Exports / Public API
This file exports nothing — it is a script, not a module. It runs top-to-bottom on import/execution:

```ts
init();                                          // src/shared/db.ts — create schema, migrate, seed
setInterval(cleanupSessions, 60 * 60 * 1000).unref(); // hourly expired-session sweep
const app = createApp();                         // src/app.ts
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => { /* log local + LAN URLs */ });
```

- **`init()`** (from `src/shared/db.ts`) — runs synchronously before anything else; creates tables if missing, runs `migrate()`, seeds default data. Must complete before `createApp()` mounts routes that assume the schema exists.
- **`cleanupSessions`** (from `src/shared/db.ts`) — deletes expired rows from `sessions`. Scheduled hourly via `setInterval(...).unref()` — `.unref()` means this timer alone won't keep the Node process alive (doesn't block a clean shutdown).
- **`createApp()`** (from `src/app.ts`) — builds the Express app (middleware + routes); does not itself start listening, which is why `server.ts` (not `app.ts`) is the thing that calls `.listen()`.
- **Listening**: binds to `0.0.0.0:PORT` (not `localhost`) specifically so other machines on the office LAN can connect, not just the host machine. `PORT` is read from the `PORT` env var, defaulting to `3000`.
- **Startup log**: on successful listen, iterates `os.networkInterfaces()` to collect non-internal IPv4 addresses and prints one `http://<ip>:<port>` line per LAN-facing interface, plus a `localhost` line, so whoever starts the server can read the URL to give coworkers off the console.

## Internal / non-exported helpers
None — the network-interface enumeration is inlined in the `.listen()` callback, not a separate function.

## Dependencies
- `node:os` — `networkInterfaces()` for the LAN-IP startup banner.
- `./src/db` — `init`, `cleanupSessions`.
- `./src/app` — `createApp`.

## Used by
Nothing imports `server.ts` — it is only ever executed directly (`tsx server.ts`, via `npm start`/`npm run dev`). Tests import `createApp` from `src/app.ts` directly and never touch `server.ts`, which is why the app factory and the listening logic are split into two files in the first place.

## Notes / gotchas
- Splitting `createApp()` (in `app.ts`) from the `.listen()` call (here) exists specifically so `tests/helpers.ts` can build an app instance and drive it with `supertest` without binding a real socket or triggering the LAN-IP banner.
- `init()` runs unconditionally on every process start, including in production against the real `data.db` — it is written to be idempotent (guarded `CREATE TABLE IF NOT EXISTS` + explicit `migrate()` checks), so restarting the server never re-seeds or duplicates data.
- If `ADMIN_PASSWORD` is not set in the environment, first-run seeding (inside `init()`) creates the default `admin`/`admin123` account and prints it to the console — worth knowing when reading server startup logs.
