# Customer service: Messenger to customer history

Messenger remains the conversation channel. The app records the customer, a short
summary, and the next action; it does not synchronize or send Messenger messages.

## Daily workflow

1. Open **Sales → Customers**. Search the customer's name, phone or Facebook
   display name. If necessary, turn on **Show archived**. Before creating a customer,
   check the suggested matches; choose one or explicitly confirm a separate person.
   Shared names/phone numbers never merge people automatically.
2. Open the customer. Choose **New inquiry**. Save a summary, owner, next action,
   and due time. Phone, email and address are optional at first contact.
3. Open the saved inquiry. Choose **Create sale from inquiry**. The normal sale form
   opens with the customer selected. Save once; retrying that inquiry sale returns
   the same order. Stock approval/release/confirmation still use the existing rules.
   Alternatively, select an existing sale belonging to this customer on the case.
   Use **Find sale** with its order number for sales outside the recent list.
4. Record a complaint as a separate case under the same customer. Link its sale if
   known; a complaint without a sale is also allowed. Save before uploading images.
5. Record interaction notes, update the next action or select another CSR to hand
   over your case. Save the handover note. The receiving CSR sees it in **Customer
   work → My cases**. Supervisors can view/reassign all cases with **Team cases**.
6. Resolve or cancel with a reason. Closed cases leave the open queue and remain in
   customer history. Reopening requires a fresh next action and due time.

**Waiting is still open work:** it needs a dated next action. Dates are entered and
shown in the browser's local time zone and stored as UTC. Check the office browser's
time zone. **Overdue** and **Due through today** work without push subscriptions.
Personal tasks remain private and are not copied from cases.

If a save fails, the dialog retains its inputs. If someone else changed a case or
customer profile, copy any unsaved note, close and reopen, review the newer version,
and reapply your change. Retrying an unchanged case/sale creation is safe; changing
a previously successful request returns a conflict rather than silently duplicating it.

Archive a customer who has history. Linked customers and linked sales cannot be
permanently deleted. Changing a customer's contact details does not rewrite old
sale-order snapshots. Inquiry sale links cannot be removed or replaced; cancel a
mistaken order through the existing sales workflow and ask a supervisor to review.

Supporting attachments currently accept JPG, PNG, GIF and WebP images up to 8 MB.
They are authenticated; copying the image URL does not make it publicly accessible.

## Short CSR acceptance script (use synthetic data in staging)

- CSR A creates an inquiry for a synthetic customer. Confirm a formatted phone
  search finds the same profile, and a same-name different person can remain separate.
- Try saving an open case without a due time: it must fail without losing the note.
- Create a sale from the inquiry; confirm the selected customer and contact values.
  Retry the unchanged save: confirm one order and one sale-link history event.
- Record a complaint linked to that sale. Hand it to CSR B with a note and next action.
  Sign in as B: confirm the complaint appears in My cases and the full history is visible.
- Open the same case in two sessions; save one, then save the stale one. Confirm a
  conflict rather than an overwrite. Review and reapply the unsaved note.
- B resolves the complaint with a reason. Confirm it leaves open work, stays in the
  customer's history, and the sale's status is unchanged.
- Archive the customer. Confirm open work/history remain accessible. A supervisor
  can recover work owned by an inactive CSR through the team queue.
- With a user lacking case access, confirm cases, events and case image URLs fail.
  A user who can view sales but cannot view cases sees only sales in customer history.

The implementation was tested with synthetic data. A CSR still needs to validate
terminology and the above script against anonymized operational examples before rollout.
