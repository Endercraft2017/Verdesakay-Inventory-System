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
