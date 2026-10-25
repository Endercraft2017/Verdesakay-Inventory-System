# Standing user preference: deeper work, same scope

For each substantive task request in this repository, apply the following user instruction before carrying out the task:

> I want a deeper version of this task, not a bigger one. Before rewriting it:
> (1) say what a top professional in this field would do here that I'm not asking for;
> (2) name the rawest material they would start from instead of what has already been digested for me;
> (3) name the specific methods and tools they would use;
> (4) say what, other than you or me, would show the result is right.
> Then rewrite my prompt to ask for exactly that.

Keep the four points and rewritten prompt concise and specific to the actual task. Ground tool and source choices in what is available; distinguish proposed verification from completed verification.

Depth means better evidence, reasoning, execution, and validation within the original objective. Preserve the user's scope, constraints, and requested deliverable. Do not add unrelated features, extra deliverables, or speculative work.

After presenting the four points and rewritten prompt, proceed with the authorized task without requiring the user to resubmit the prompt or approve routine choices. If the user asks only for a prompt rewrite, deliver the rewrite without executing it. Direct answers to simple questions and status updates do not require this ceremony. Follow any explicit instruction in the current request that changes or skips this workflow.


## Repository skills

The requested GitHub skill collections are checked into `.agents/skills/`. Use the relevant skill's `SKILL.md` and supporting references when helpful to the task; do not load or apply all collections indiscriminately. If the runtime has not discovered these skills, read the relevant files directly from the repository. Preserve the existing `editor-ux` skill.

Source commits, licenses, known compatibility limits, and optional dependencies are documented in `.agents/skill-sources/README.md` and `manifest.json`. Graphify requires a separate CLI installation. These repository files do not install dependencies or change account-wide settings.

## Standing user requirement: use skills and tools for UI/UX decisions

For every substantive UI/UX audit, proposal, mock, implementation or review in this project, actively use relevant installed skills and available tools during investigation, design decisions and verification. This applies to all subsequent chunks, not only Chunk 28. Installing skills, listing tools or citing their names does not fulfill this requirement.

- Read the applicable `SKILL.md` files and required supporting references before applying them. Select only relevant skills: Taste Skill's app-screen guidance for composition and hierarchy, UI UX Pro Max's focused searches for applicable UX guidance, and Design Motion Principles when evaluating or adding motion. Use other relevant skills as needed; do not indiscriminately load every skill or run every tool.
- Ground decisions in original components, existing design tokens, realistic content and actual application behavior. Use tools to inspect these sources and evaluate meaningful layout or interaction alternatives before choosing a design. Preserve the user's original design, navigation, permissions and stock rules unless the user explicitly changes them.
- Use appropriate browser rendering, screenshots, measurements and interaction/accessibility checks to verify visual and behavioral work. Check the states and device sizes relevant to the change, including reduced motion when motion is involved. An automated style score or accessibility scan alone is not proof of usability.
- In each substantive UI/UX report, briefly state which skills and tools actually informed the decisions, the findings they produced, what was verified and any remaining limitations. Distinguish completed checks from proposed checks and user research.
- If a tool or skill is unavailable, report the specific limitation and use an available equivalent where possible. Do not claim it ran. Additional plugins are optional when existing capabilities suffice; never claim a suggested plugin is installed or connected without verification.

This standing workflow supplements each chunk's specific brief without expanding its screen count or adding unrelated features. Simple questions, status replies and prompt-only rewrites do not require rendering or implementation checks.

## Mobile design decisions are shared

Apply approved mobile design decisions through the shared shell, tokens and
components in `public/mobile/mobile-v2.css`, `lib/screen-ux.js`, `lib/role-ui.js`
and shared navigation. New and existing mobile routes must use those patterns;
do not leave page-specific copies of dropdowns, button radius/press effects,
status rails, ordinary refresh controls or Back behavior. Follow the current
contract in `docs/design/mobile-work.md`, including its superseding revisions.
Preserve workflow-specific confirmations, draft protection, real error Retry and
explicit stock checks. Native multi-selects keep their selection behavior. Verify
shared changes across representative HR, inventory and production screens in
both themes and reduced motion; describe browser coverage honestly instead of
claiming every page or physical device was tested.

## UI/UX review: disposable scratch preview (user preference)

For UI/UX investigation, design, implementation and review, generate an interactive
scratch preview from local app code and deliver it through the confirmed private
HTTPS Sites workflow below instead of MagicPath, unless the user requests otherwise.
Put the proposed change and its visual explanation in the preview early so the
user can see, try and iterate on it; do not substitute a long chat plan.

- Rebuild the preview from the current working-tree app code plus the changes
  being reviewed. Reuse the real markup, styles, components, handlers and motion;
  do not maintain a separately styled mockup that can drift from the app.
- Use the project command `npm run ui:scratch`. The generated scratch entry is
  `work/ui-scratch/index.html`. Keep the reusable builder and template outside
  that output directory. Update the fixture scenarios and in-preview notes for the
  screen currently under review; do not reuse stale task-specific explanations.
  Use `npm run ui:scratch:serve` for internal browser verification when needed.
  Deliver the private HTTPS link to the user; the generated file remains the source.
- If a checkout does not yet contain the scratch helper commands, create the
  equivalent local builder/runner first. This instruction does not install them;
  do not claim a preview or command is available without verifying it.
- Deliver a preview the user can actually reach. A localhost server inside a
  remote workspace is not reachable at localhost on the user’s computer. The
  private Sites link is the confirmed delivery method. Do not describe a
  workspace-only URL as a working user-facing preview. If hosting is unavailable,
  explain the limitation and use a verified alternative without changing the UI.
- Start each rebuild from a clean slate: wipe only the designated generated
  `work/ui-scratch/` directory, then recreate it. Guard the exact path and ownership;
  never delete source, user files, other work evidence, or other scratch folders.
  Generated scratch output is ignored by Git.
- Include a short in-preview change explanation and iteration notes. For
  substantive UI/UX work, put the four deeper-work points and rewritten brief
  from the standing preference in the scratch preview as well, unless the user
  explicitly asks to see them in chat.
- Preserve real animation timing, reduced-motion behavior, focus, disclosures,
  routes and interaction checks. Label simulated records, transport, persistence
  and unsupported actions accurately. Use disposable data and isolate all preview
  writes from real stock, employee records, sessions and external systems.
- Verify the preview in Playwright, including relevant interactions, motion and
  clean rebuild behavior. Keep explanations, screenshots and results inside the
  scratch preview/evidence, and distinguish it from live-backend or physical tests.
- During UI/UX updates, chat should be limited to detailed architecture explanations
  and necessary clarification/questions, plus the minimal preview link and status
  needed to deliver it. Put routine plans, design rationale and iteration reports
  in the scratch preview. Follow system/developer requirements for brief progress
  updates, while avoiding a long duplicated explanation in chat.

### Private HTTPS delivery (confirmed by the user)

- Reuse the existing scratch Site; do not create a new Site for each iteration.
  Project ID: `appgprj_6add8ad5d3cc81919a5e4ebe9b8d0ef4`.
  URL: `https://verdesakay-ui-scratch.wavylion256.chatgpt.site`.
  Its audience is owner-only. Preserve that audience and check current access
  before publishing; never make it public to resolve a viewing problem.
- Read the installed Sites skill and use its supported source, packaging and
  private publishing tools. The Site checkout is separate from the application
  repository, currently `/workspace/sites/verdesakay-ui-scratch`. If that checkout
  is missing, reopen this same Site through its source-repository workflow.
  Preserve its `.openai/hosting.json`, project identity and Git metadata.
- After rebuilding and verifying the scratch file, replace the Site's generated
  static content with that exact HTML and its required assets/licenses. Verify
  the package matches the tested scratch output. Publish the updated version to
  the same URL as part of UI/UX review; do not require another routine confirmation.
  Publishing the preview does not authorize deploying or pushing app changes.
- Keep hosting identity outside the wiped scratch output. Additional metadata may
  be recorded in `docs/design/ui-scratch-hosting.json`; the ID above also allows
  another session to recover the Site without that optional file.
- Keep disposable records and isolated preview transport/storage. Do not connect
  production APIs, embed live credentials or enable real business writes for review.
  Clearly label simulated behavior and any unsupported actions inside the preview.
- Confirm publication through the returned deployment result; poll only while
  pending. Return the literal successful HTTPS URL, with change explanations and
  verification results inside the preview. Report any publishing/access failure
  accurately; a local HTTP success or expected URL alone does not prove delivery.
