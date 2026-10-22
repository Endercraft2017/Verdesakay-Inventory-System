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
