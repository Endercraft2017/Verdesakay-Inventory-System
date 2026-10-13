# Otom

Otom is an office management web app by **AFKcube (AFK^3)**. Company names shown in
the workspace header belong to the current tenant.

A local office management system for inventory, forms/files, staff accounts, and
internal messaging. It runs as a small web server on one office PC; other PCs on the
same network open it in a browser — no installation needed on the other machines.

## Features

- **Inventory** — add/edit items, categories, departments, locations, reorder levels;
  stock in/out with a full movement history; search, filter, and low-stock alerts.
- **Forms & Files** — upload documents (up to 25 MB), download them, and share either
  with all staff or with a specific department only.
- **Accounts & roles** — admins create accounts, assign roles (admin / employee) and
  departments, reset passwords, and enable/disable users.
- **Messaging** — staff send messages to each other with an inbox, sent box, and unread
  badge.
- **Security** — passwords are hashed (bcrypt), sessions expire after 12 hours, and
  every API call is permission-checked by role.

## Tech stack

- Backend: Node.js + Express + **TypeScript** (run with `tsx`, no build step)
- Database: SQLite (Node's built-in `node:sqlite`) — stored in `data.db`
- Frontend: plain HTML, CSS, and JavaScript (no build step)
- Validation: `zod` · Security: `helmet` + login rate-limiting · Tests: `vitest` + `supertest`

## Developer docs

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the codebase map: every file, the data
  model, and the full API catalog. **Read this before adding code; keep it updated.**
- **[docs/DECISIONS.md](docs/DECISIONS.md)** — why the stack is what it is.
- **[docs/DEPLOY-RAILWAY.md](docs/DEPLOY-RAILWAY.md)** — hosting on Railway (volume, variables, domain).

## Working on the code

| Command | What it does |
|---|---|
| `npm start` | Run the server (`tsx server.ts`, port 3000). |
| `npm run dev` | Run with auto-reload on file changes. |
| `npm run typecheck` | Strict TypeScript check. |
| `npm test` | Run the full automated test suite (headless, no server needed). |
| `npm run check` | Typecheck **and** test — run this before every commit. |

## Running it

1. Make sure **Node.js 22+** is installed (`node --version`).
2. In this folder, install dependencies once:
   ```
   npm install
   ```
3. Start the server — either run `start.cmd` (double-click) or:
   ```
   npm start
   ```
4. The window prints the addresses, e.g.:
   ```
   Local:   http://localhost:3000
   Network: http://192.168.x.x:3000   (for other office PCs)
   ```
5. Open the **Local** address on this PC, or the **Network** address from any other PC
   on the same Wi-Fi/LAN.

### First login

A default administrator is created on first run:

- **Username:** `admin`
- **Password:** `admin123`

> Sign in and change this immediately under **My Account → Change password**.
> You can set a different initial password by starting with `ADMIN_PASSWORD` set, e.g.
> `set ADMIN_PASSWORD=YourStrongPass && npm start`.

## Letting other office PCs connect

Other PCs reach this server over the LAN using the **Network** URL. If they can't
connect, allow Node through the Windows Firewall on the host PC (one time):

```
netsh advfirewall firewall add rule name="Otom" dir=in action=allow protocol=TCP localport=3000
```

## Data & backups

- All data lives in **`data.db`** (one file) and uploaded files live in **`uploads/`**.
- To back up, copy those two while the server is stopped.
- Both are git-ignored so real office data is never committed.

## Project layout

```
server.ts              Server entry point (init DB, listen)
src/
  app.ts               Express app factory (middleware, routes, errors)
  db.ts                DB connection, schema, seed, typed query helpers
  auth.ts              Session tokens + role middleware
  types.ts             Shared domain types
  validation.ts        zod request schemas
  routes/              REST API (auth, users, inventory, forms, messages)
public/
  index.html           App shell + login
  css/styles.css
  js/                  api.js, ui.js, app.js + views/*
tests/                 Vitest unit + integration tests
docs/                  ARCHITECTURE.md (codebase map), DECISIONS.md
uploads/               Uploaded form files (created at runtime)
data.db                SQLite database (created at runtime)
```
