# Repository skills

131 vendored skill folders from the requested collections live in `.agents/skills/`, alongside the existing `editor-ux` skill. Both Vercel and Addy Osmani Agent Skills are included. These files travel with this branch; there is no per-chat installer for sessions whose Codex runtime supports repository skill discovery.

`manifest.json` records upstream repositories, pinned commits, installed paths, and the one skill-name change needed to avoid a duplicate name. Collection-prefixed directory names avoid file collisions. The Superpowers TDD skill is named `obra-test-driven-development` to distinguish it from the Addy Osmani skill. Licenses are preserved in `licenses/` and within individual skills where supplied upstream. Upstream in-progress Matt Pocock skills are omitted.

## Usage

Pull `restructure/module-architecture` and start a new Codex session rooted in this repository. In ongoing sessions, ask Codex to read `AGENTS.md` and the relevant `.agents/skills/<collection>--<skill>/SKILL.md` directly. Merely pulling files does not guarantee an already-running session refreshes its skill catalog. These are repository-scoped files, not an account-wide or environment-template installation.

Choose only skills relevant to the request. Their instructions remain subject to the current user request and runtime capabilities. Collections have overlapping workflows, and not every upstream workflow has been adapted or runtime-tested with Codex. Some refer to Claude-specific tools, hooks, plugin commands, or `.claude` paths; resolve supporting files relative to the installed skill folder where appropriate. Do not claim an unavailable tool ran.

## Dependencies and optional setup

This commit vendors instructions and supporting assets only. It does not run upstream code, configure hooks, install dependencies, register MCP servers, or add credentials. Follow each skill's dependency guidance only when required by the task.

Graphify needs a separate CLI installation (`uv tool install graphifyy`, per upstream). Its Codex skill and reference files are included, but the CLI is not installed by this commit. Some document, browser, and UI skills also require external tools or packages. No upstream workflow execution is implied by file validation.

## Updates

This is a pinned snapshot with no automatic updates. Update from the upstream repositories recorded in the manifest, preserve licenses and local name changes, and review the diff. To remove the bundle, remove only the collection-prefixed folders listed in the manifest and this metadata directory; retain unrelated skills such as `editor-ux`.
