# Using the AI Assistant

A chat panel that can answer questions about your data, build reports and Word documents,
and do small tasks for you — in plain language.

## What it's for

- **Ask about your data:** "How many items are below reorder level?", "Which employee was
  late the most last cutoff?", "What did we ship yesterday?"
- **Get a report or a Word document:** "Make a Word document of this month's low-stock
  items grouped by supplier."
- **Look things up:** "What's our leave policy?", "Any QC failures on job order JO-00042?"
- **Small actions:** create a note or task, send an internal message, send an email
  (if you have the Email permission).

## Before you start

- Open it from the **tools rail on the right** (the assistant / sparkle icon).
- It only ever sees and does what **your account** is allowed to. If you can't view HR,
  neither can the assistant when you ask.
- Your administrator must have connected an AI key for your company. If it says
  "AI is not configured", tell your admin.

## Steps

1. Open the assistant panel.
2. Type a question the way you'd ask a colleague. Be specific about the time range and
   what you want back ("…as a table", "…as a Word doc").
3. Press Enter. You'll see small chips showing what it looked up ("search inventory",
   "attendance report"), then the answer.
4. If it produced a file, a **download button** appears under the reply.
5. Ask follow-ups — it remembers the current conversation until you close the panel.

## Good prompts

- "List items at or below reorder level with their supplier and shortfall, as a table."
- "Attendance summary for the last cutoff: per employee, days present, absent, late, and
  late minutes."
- "Who filed the most overtime this month?"
- "Draft a Word memo summarising job order JO-00042: units done, scrapped, and QC
  failures with remarks."
- "Create a task for me to follow up with Acme Steel on Friday."

## Tips & gotchas

- **It can be wrong.** Treat numbers as a fast first look; check the underlying screen
  before you act on anything that matters (payroll, purchase commitments).
- **Give it a date range.** "This month", "last cutoff", "since Monday" — otherwise it
  guesses.
- **It won't do bulk changes.** It can create the odd note, task, or message; it won't
  mass-edit inventory or delete things.
- **Privacy:** it does not read staff-to-staff messages, and it can't show another user
  their private notes/tasks.
- Long or vague questions get vague answers. One clear ask per message works best.

## If something goes wrong

| What you see | Fix |
|---|---|
| "AI is not configured" | Admin needs to add the company's AI key in settings. |
| "I don't have access to that" | Your role doesn't include that data — ask an admin for the permission. |
| Answer looks stale | It reads live data, but a report file you generated earlier is a snapshot — regenerate it. |
| It keeps misunderstanding | Restate as one specific question with the time range and the format you want. |
