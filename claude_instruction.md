# Module architecture and reuse workflow

Apply this workflow to every coding project, including new projects, existing
projects, and later sessions. Keep it active when adding features, fixing bugs,
or changing how parts of a system connect.

## Purpose

Organize applications into reusable business capabilities. A module owns a
clear responsibility and may include data models, business rules, services,
APIs, UI, configuration, migrations, and tests. Examples include timekeeping,
payroll, inventory, accounting, and document retrieval.

Do not create a business module for every file, screen, or helper function.

## Starting a new project

1. Identify the main capabilities the project needs.
2. Create `docs/modules/catalog.md` to list the modules, their responsibilities,
   status, and connections.
3. Create `docs/modules/pipelines.md` to list the main end-to-end workflows the
   project will support, even as rough, planned stage sequences.
4. Add a project-level `CLAUDE.md` that identifies the catalog and pipeline map
   locations, project stack, build and test commands, and any project-specific
   rules.
5. Record planned modules and pipeline stages as `planned`. Do not describe
   them as implemented.
6. Assign new code to a module and a pipeline stage before implementing it.

Keep the initial catalog and pipeline map brief. Expand records as the code
becomes real.

## Working on an existing project

If the project has no module catalog, inspect its code and create an inventory
of actual capabilities and their file paths. Mark incomplete capabilities as
`partial`. Document uncertain boundaries as proposals. Do not move, rewrite,
or extract code solely to create the initial inventory.

Before each code change, read the relevant module records and inspect the
actual implementation. Treat the code and tests as evidence when a catalog
entry is outdated.

## Deciding where a feature belongs

- Extend an existing module when the feature fits its responsibility.
- Create a new module when the feature has a distinct business responsibility,
  owns meaningful rules or data, and needs a defined interface with the system.
- Create an integration adapter or coordinating workflow when the main task is
  translating data or coordinating actions between existing modules.
- Keep general utilities in an appropriate shared utility area. Do not label
  them as business modules merely because they are reusable.

Before implementing a new module, record its responsibility, owned data,
public interface, dependencies, connections, and expected tests.

Do not force a feature into an unrelated module to avoid creating a new one.
Do not split a coherent capability into unnecessary modules.

## Connecting modules

Each module owns its data and business rules. Connect modules through
documented public interfaces; avoid reaching into another module's private
tables or internal functions.

Choose a connection based on the workflow:

- Use a direct call or API when an immediate answer or result is required.
- Use an event when another module should react to a completed action.
- Use an adapter when formats, terminology, rules, or versions need translation.
- Use a coordinating workflow when several modules must complete one process.

For each connection, document:

- The source and destination modules
- The interface, event, or adapter used
- The data exchanged and its format
- Which module validates the data and owns the resulting action
- Failure, retry, and duplicate-handling behavior where relevant

Avoid circular dependencies. If two modules require each other's internals,
reconsider their boundaries or introduce a coordinating workflow.

## Mapping feature pipelines

A connection describes how two modules talk. A pipeline describes the real
business process that runs through several of them in order, end to end.
Maintain `docs/modules/pipelines.md` alongside the module catalog to make that
sequence visible, so a new feature request can be placed by asking "which
pipeline, which stage" instead of guessing.

Each entry in the pipeline map is a process a user or another system actually
triggers (for example: sales order intake, purchase-to-pay, production run),
not an internal function call chain. For each pipeline, document:

- Trigger: what starts it (user action, event, schedule).
- Ordered stages: the module responsible at each stage and what it does there.
- Data carried between stages, and where it is stored or transformed.
- Branch points: conditions that change the path (approval, rejection,
  shortage, cancellation, and similar).
- Terminal states: how the pipeline ends, including failure and cancellation
  paths, not only the success path.

When placing a new feature:

1. Identify which existing pipeline it affects, or whether it starts a new one.
2. Find its place in the stage sequence: a new stage, a branch on an existing
   stage, or a change within a stage's current module.
3. Insert the behavior into the correct stage of the existing pipeline instead
   of adding a parallel path that skips stages already responsible for
   validation, stock, approval, or recording.
4. If the feature does not fit any existing pipeline and is not a one-off
   utility, define its pipeline before implementing it.

Keep pipeline entries at the business-process level; do not turn every
internal function call into a stage. Order any related UI (screens, tabs,
menus) to match the pipeline's real stage sequence rather than an arbitrary or
alphabetical order.

## Reusing code across projects

Before writing a capability from scratch, check the project's existing modules
and any shared code bank configured for the project. Reuse an implementation
only after checking its language, framework and version, dependencies,
configuration, interface, assumptions, permissions, and tests.

A matching name is not proof that a module fits. Adapt and test the module in
the target project. Do not automatically copy project code into the shared code
bank. Propose extraction when it has a clear boundary and a plausible use in
another project.

If no shared code bank is configured, continue with the project workflow.
Do not invent a path or claim that a shared module exists.

## After every code change

1. Run the relevant tests or report why they could not run.
2. Update the catalog and affected module records when responsibilities,
   implementation status, file paths, public interfaces, dependencies, or
   connections have changed.
3. Update `docs/modules/pipelines.md` when a stage, branch, or terminal state
   was added, moved, or changed, or when the change created a new pipeline.
4. Use these status labels accurately:
   - `planned`: defined but not implemented
   - `partial`: implemented in part or known to be incomplete
   - `working`: works in this project with relevant tests
   - `reusable`: has verified tests and setup instructions for another project
5. In the final summary, name the modules created or changed, describe new
   connections and pipeline stages, and mention any catalog updates or
   proposed extractions.

For a change that does not affect module responsibilities, connections, or
pipeline stages, do not create a meaningless catalog or pipeline edit. State
that both were checked and why no update was needed.