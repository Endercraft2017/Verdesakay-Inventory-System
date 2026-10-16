/* Authored control instructions. Each entry names an action and its result. */
window.GuideInstructions = [
  [
    "#ap-search",
    "Find a request",
    "Type an employee name or request name to narrow the inbox. Clear the search to show all items in the selected tab."
  ],
  [
    "#ap-list",
    "Review a request",
    "Press Review on a pending request. Read its reason and dates before choosing a decision. Recent decisions shows who decided and their note."
  ],
  [
    "#ap-authorities",
    "Assign department approvers",
    "Open Department approvers, choose the department and select additional active accounts from that department. Department heads retain authority; HR can step in when needed."
  ],
  [
    "#ap-note",
    "Explain your decision",
    "Write a decision note. If rejecting, include the reason so the employee knows what needs to change."
  ],
  [
    "#ap-decision",
    "Choose Approve or Reject",
    "Select your decision after reviewing the request. Save decision records it; a department approval does not require a second HR approval."
  ],
  [
    "#myhr-new",
    "File a request or correction",
    "Press New request to choose a request type and complete its dates and reason. In Attendance corrections, use Report a missed punch to submit a work date, corrected time and reason."
  ],
  [
    "#myhr-content",
    "Check your request status",
    "Use View on a submitted item to read its details and decision. Pending means an authorized approver has not decided it yet."
  ],
  [
    "#myhr-date",
    "Choose the affected work date",
    "Select the date on which the punch was missed or incorrect. Submit separate corrections for different work dates."
  ],
  [
    "#myhr-in",
    "Enter the correct arrival time",
    "Enter the actual time you started work. Leave this blank if only the departure time needs correcting."
  ],
  [
    "#myhr-out",
    "Enter the correct departure time",
    "Enter the actual time you finished work. At least one corrected time is required."
  ],
  [
    "#myhr-reason",
    "Explain the missed or incorrect punch",
    "Describe what happened and why the entered time is correct. Department approvers or HR review this explanation."
  ],
  [
    "#ap-dept",
    "Choose the department",
    "Select the department whose additional approvers you want to manage. Only active accounts in that department can be delegated."
  ],
  [
    "#ap-delegates",
    "Choose additional approvers",
    "Select the accounts authorized to decide requests for this department, then save your selection. Department heads and HR retain their authority."
  ],
  [
    "#dr-date",
    "Review a work date",
    "Choose the date to inspect attendance for that day. Today returns to the current date."
  ],
  [
    "#dr-search",
    "Find an employee in the daily report",
    "Type an employee name to narrow the daily attendance list."
  ],
  [
    "#dr-status",
    "Filter attendance results",
    "Choose the attendance status to investigate, such as Late or Absent. Check leave, rest days and holidays before treating a missing punch as absence."
  ],
  [
    "#dr-refresh",
    "Reload attendance",
    "Press Refresh to retrieve current punches and attendance results for the selected date."
  ],
  [
    "#kiosk-no",
    "Clock in or out",
    "Enter your employee number and use the time-clock action shown on this kiosk. Check the confirmation before leaving."
  ],
  [
    "#kg-approve",
    "Approve this kiosk computer",
    "Give this computer a recognizable kiosk name, then approve it if you are authorized. This registers the computer for kiosk use."
  ],
  [
    "#as-q",
    "Find issued assets",
    "Search for an employee or asset to find its issuance record."
  ],
  [
    "#as-status",
    "Filter asset status",
    "Choose the issuance status you want to review. Use the matching record to inspect outstanding or returned assets."
  ],
  [
    "#cv-verify",
    "Record contact verification",
    "Check the contact information shown with the employee before pressing Mark verified."
  ],
  [
    "#tk-new",
    "Create a cutoff",
    "Press New Cutoff, enter its label and inclusive start and end dates, then save. Open the cutoff to add employees and review attendance."
  ],
  [
    "#tk-table",
    "Open the cutoff to process",
    "Open the cutoff row matching the payroll dates you are processing. Check its date range before adding employees or generating payroll."
  ],
  [
    "#tk-tools-toggle",
    "Open calendar and setup tools",
    "Expand Calendar & tools to find Holidays, No Work / Suspension, Punch Log, Payroll Worksheets and Policy Settings. Choose the tool for the task you need."
  ],
  [
    "#tk-policy",
    "Set attendance and payroll rules",
    "Open Policy Settings and review pay frequency, shift and rest-day defaults, grace time, overtime and statutory settings. Save Rules applies your changes."
  ],
  [
    "#tk-holidays",
    "Maintain the holiday calendar",
    "Open Holidays to add or review holiday dates and types. Confirm the date and holiday classification because these affect payroll."
  ],
  [
    "#tk-noWork",
    "Record a company no-work day",
    "Open No Work / Suspension for company-wide declarations such as suspensions. Use Holidays for public holidays instead."
  ],
  [
    "#tk-roster-search",
    "Find an employee in this cutoff",
    "Type an employee name to narrow this cutoff’s roster. Open their row to review daily attendance."
  ],
  [
    "#tk-roster-show",
    "Find missing attendance",
    "Choose Incomplete days or Nothing logged to find records needing review. Check schedules and leave before entering missing times."
  ],
  [
    "#tk-roster-group",
    "Group the roster",
    "Choose Department, Status or None to arrange the roster. Grouping changes its presentation, not attendance or pay."
  ],
  [
    "#tk-roster-sort",
    "Choose the sort column",
    "Select the field used to order employees, such as Name or Days Logged. Use the adjacent direction button to reverse that order."
  ],
  [
    "#tk-roster-sort-dir",
    "Reverse the current sort",
    "Press this button to switch ascending and descending order for the selected sort column."
  ],
  [
    "#tk-add-emp",
    "Add employees to the cutoff",
    "Press Add Employee and select the employees included in this payroll period. Review their shifts and daily attendance after adding them."
  ],
  [
    "#tk-warnings",
    "Read payroll review notes",
    "Open Review notes to inspect missing punches and pending requests that may affect this cutoff. These notes do not block payslip generation."
  ],
  [
    "#tk-more-toggle",
    "Open cutoff tools",
    "Expand Cutoff tools to edit the cutoff, import earlier punches or post its generated payroll to the ledger. Only actions allowed by your permissions are shown."
  ],
  [
    "#tk-import-punches",
    "Backfill earlier punches",
    "Use Import Punches for employees who punched before they were added to this roster. Existing roster members’ punches already fill time in and out live."
  ],
  [
    "#tk-generate",
    "Generate payslips for this cutoff",
    "Review attendance and linked approved forms first, then press Generate Payslips. Read the review notes and confirm only when the cutoff is ready."
  ],
  [
    "#tk-post-gl",
    "Post this payroll to the ledger",
    "Review the cutoff’s generated payslips, then use Post to GL to record this payroll in the general ledger. Review the confirmation before posting."
  ],
  [
    "#fb-new-form",
    "Create a form definition",
    "Press New Form, name it and add the fields people must complete. Creating a form defines its structure; it does not submit an employee request."
  ],
  [
    "#fb-quick-add",
    "Start with a common HR form",
    "Open Quick Add to select a common HR form. Review its fields and settings before using it for requests."
  ],
  [
    "#fb-new-var",
    "Define a reusable variable",
    "Press New Variable and enter its key and value. Use the key when inserting that variable into a template."
  ],
  [
    "#fr-new",
    "Create a record for this form",
    "Press New Record, complete the form’s fields and review the dates and reason before saving. Check the saved status before assuming the record is approved."
  ],
  [
    "#fr-search",
    "Find a form record",
    "Type a name or record detail into the search box to narrow the records shown. Clear it to show the unfiltered list again."
  ],
  [
    "#fr-status",
    "Filter record status",
    "Select the status you need to review, such as pending or approved. This selection only filters the list."
  ],
  [
    "#fr-more-toggle",
    "Open import and cleanup actions",
    "Expand Import & cleanup to see CSV import and any available cleanup actions. Review their scope before changing records."
  ],
  [
    "#forms-search",
    "Find an uploaded file",
    "Search by title or filename to find a document uploaded to this library."
  ],
  [
    "#forms-cat",
    "Filter the file category",
    "Choose a category to narrow the uploaded files. Clear the category to see all accessible files."
  ],
  [
    "#forms-upload",
    "Upload a document",
    "Press Upload, choose a file and enter its title and category. Check department visibility before saving so the intended staff can access it."
  ],
  [
    "#tpl-new",
    "Create a print template",
    "Press Create template, choose its form and enter a name. Edit its content, insert the needed fields and preview before saving."
  ],
  [
    "#tpl-vars",
    "Review template variables",
    "Open Variables to find reusable values and their keys. Insert the matching variable in a template instead of duplicating a changing value."
  ],
  [
    "#tpl-company",
    "Set company details for templates",
    "Open Company profile and review the business details used in printed documents. Save only after checking their spelling and values."
  ],
  [
    "#notes-search",
    "Find a note or checklist",
    "Search for words in the note or its checklist items. Open a matching note to edit it or review its linked task."
  ],
  [
    "#note-new",
    "Create a note or checklist",
    "Press New note / checklist. Enter a title, add text or checklist items, and optionally schedule a due time before saving."
  ],
  [
    "#em-to",
    "Address the email",
    "Enter the recipient’s email address. Check it carefully before sending."
  ],
  [
    "#em-subj",
    "Write a clear subject",
    "Enter a subject that tells the recipient what the message is about."
  ],
  [
    "#em-body",
    "Write the message",
    "Enter the message and check that it includes the details the recipient needs."
  ],
  [
    "#em-send",
    "Send the email",
    "Review the recipient, subject and message, then press Send. Check the delivery result; closing the panel does not send it."
  ],
  [
    "#em-log",
    "Review sent mail",
    "Open Sent log to inspect prior send results and troubleshoot failed delivery."
  ],
  [
    "#em-config",
    "Configure outbound mail",
    "Open Settings to configure the outbound mailbox if you are an administrator. Verify the configuration before sending mail."
  ],
  [
    "#task-title",
    "Create a task",
    "Enter a short action-oriented title, such as Review September payroll. Choose a due date and press the plus button to add it."
  ],
  [
    "#task-date",
    "Choose the due date",
    "Select the date the task should be done. Use Schedule / edit on the saved task to add a specific time or reminder."
  ],
  [
    "#task-list",
    "Complete or schedule a task",
    "Check a task when it is done. Use Schedule / edit to adjust its due time or reminder, and Open linked note to inspect a linked checklist."
  ],
  [
    "#task-edit-title",
    "Name the task",
    "Enter a title that describes the work to do. For a linked note, edit the note to change its title."
  ],
  [
    "#task-edit-due",
    "Set the deadline",
    "Choose the local date and time the task is due. Review it before saving the schedule."
  ],
  [
    "#task-edit-remind",
    "Set an optional reminder",
    "Choose when you want a notification, then press Save schedule. Enable push notifications on your device for reminders outside the app."
  ],
  [
    "#bm-add",
    "Bookmark this screen",
    "Press Bookmark current page to save the current screen for quick access. You can also right-click a menu item to bookmark it."
  ],
  [
    "#bm-list",
    "Open a saved bookmark",
    "Choose a bookmark to return to its screen. Remove entries you no longer need from the bookmark list."
  ],
  [
    "#bug-title",
    "Summarize the problem",
    "Write a short title naming the affected screen and what went wrong."
  ],
  [
    "#bug-steps",
    "Explain how to reproduce it",
    "List the screens and buttons you used, in order. Include the step where the problem occurred."
  ],
  [
    "#bug-desc",
    "Describe expected and actual results",
    "Explain what you expected, what happened instead, and any error message shown."
  ],
  [
    "#bug-shots-input",
    "Attach evidence",
    "Choose screenshots that show the problem. Review them before submitting the report."
  ],
  [
    "#bug-submit",
    "Submit the report",
    "Check the title, reproduction steps and screenshots, then press Submit report. Check the confirmation that it was recorded."
  ],
  [
    "#chat-input",
    "Write a message",
    "Select the intended conversation and type your message. Check the recipients before sending."
  ],
  [
    "#chat-send-btn",
    "Send to this conversation",
    "Review your message and attachments, then press Send to post them in the selected conversation."
  ],
  [
    "#chat-attach-btn",
    "Attach a file",
    "Choose the file you want to share and check it before sending the message."
  ],
  [
    "#chat-new",
    "Start a conversation",
    "Press New and select the recipients before composing your first message."
  ],
  [
    "#an-new",
    "Publish an announcement",
    "Press New announcement, enter its message and review its audience before publishing."
  ],
  [
    "#cr-status",
    "Filter confidential reports",
    "Choose a status to find reports needing review. Open a report to read its messages and case history."
  ],
  [
    "#cr-case-status",
    "Update the case status",
    "Choose the status that reflects the case’s progress, then press Update status to record it."
  ],
  [
    "#cr-reply",
    "Write a case reply",
    "Write a response with the information or clarification needed to handle this report."
  ],
  [
    "#cr-send",
    "Send the case reply",
    "Review the reply and press Send reply to add it to this case’s conversation."
  ],
  [
    "#pf-name",
    "Update your display name",
    "Enter the name colleagues should see on your account, then press Save profile."
  ],
  [
    "#cur-pw",
    "Confirm your current password",
    "Enter your current password before setting a new password."
  ],
  [
    "#new-pw",
    "Choose a new password",
    "Enter the new password, repeat it in the confirmation field and press Update password."
  ],
  [
    "#mfa-on",
    "Enable two-step sign-in",
    "Press Turn on and follow the setup instructions. Save recovery codes somewhere accessible before relying on two-step sign-in."
  ],
  [
    "#user-search",
    "Find an account",
    "Search by name or username to find the account you need to manage."
  ],
  [
    "#add-user",
    "Create a login account",
    "Press New account, enter its username and name, then choose its role and department. Review access before saving."
  ],
  [
    "#add-role",
    "Create an access role",
    "Press New role, name it and choose the permissions it needs. Review the permissions before assigning the role to staff."
  ],
  [
    "#manage-depts",
    "Maintain departments",
    "Open Departments to add or review department names. Check where a department is used before removing it."
  ],
  [
    "#sign-in-security",
    "Review sign-in security",
    "Open Sign-in security to review account protection settings before changing them."
  ],
  [
    "#al-q",
    "Find an activity entry",
    "Search the activity log for the record or action you want to investigate."
  ],
  [
    "#al-from",
    "Set the activity date range",
    "Choose the earliest date to include, then set the ending date to narrow the log."
  ],
  [
    "#inv-search",
    "Find an inventory item",
    "Search by the item’s name, SKU or specification to narrow the item list."
  ],
  [
    "#inv-location",
    "Review stock at a location",
    "Choose the storage location whose stock you want to inspect."
  ],
  [
    "#inv-low",
    "Find items needing replenishment",
    "Enable Low stock to show items at or below their reorder level. Review these items before drafting purchase orders."
  ],
  [
    "#inv-add",
    "Create an item",
    "Press New item, enter a unique SKU, name and unit, then review reorder level and cost before saving."
  ],
  [
    "#inv-import",
    "Import item details",
    "Press Import and download the sample CSV. Existing items are matched by SKU; importing their details does not replace their stock quantity."
  ],
  [
    "#inv-labels",
    "Print item barcodes",
    "Open Labels, select the items, size and copies, then open the print sheet. Labels use the barcode or SKU if no barcode is set."
  ],
  [
    "#inv-reorder",
    "Draft replenishment orders",
    "Press Reorder PO for items needing stock. Review the generated open purchase orders and supplier assignments before proceeding."
  ],
  [
    "#mv-q",
    "Find a stock movement",
    "Search the movement log to investigate changes to an item’s stock."
  ],
  [
    "#mv-dir",
    "Filter movement direction",
    "Select the direction of stock movement you need to inspect."
  ],
  [
    "#mv-loc",
    "Filter movement location",
    "Choose a location to inspect movements affecting its stock."
  ],
  [
    "#loc-add",
    "Add a stock location",
    "Press New location and enter its name and location settings. Review its type and capacity before saving."
  ],
  [
    "#sup-add",
    "Add a supplier",
    "Press New supplier and enter the vendor’s details so items and purchase orders can be linked to it."
  ],
  [
    "#cus-add",
    "Add a customer",
    "Press New customer and enter the customer details used when creating sale orders."
  ],
  [
    "#ord-new",
    "Create an order",
    "Press New, select the customer or supplier for the order type shown, and add items, quantities, prices and the relevant location. Review before saving."
  ],
  [
    "#ord-backorder",
    "Review sale-order shortfalls",
    "Open Backorders to find approved sale orders still short of stock. Open an order to review its missing quantities."
  ],
  [
    "#ord-add-inv",
    "Add an inventory line",
    "Choose an inventory item and enter its quantity and price. Check the unit and source location before saving the order."
  ],
  [
    "#rl-scan",
    "Reserve the unit for release",
    "Scan the printed unit QR for the accepted order. Check the scan result; scanning reserves the unit but does not issue the release slip."
  ],
  [
    "#rl-slip",
    "Issue the release slip",
    "Check the collected goods, recipient token and required package evidence. Confirm the slip only when the goods are leaving; this records stock-out."
  ],
  [
    "#ra-issue",
    "Issue a release authorization",
    "Review the approved recipient, validity and partial-release option before issuing. Give the token to the recipient; issuing a new one revokes the current authorization."
  ],
  [
    "#pur-recv",
    "Record a purchase receipt",
    "Enter the quantities that actually arrived and their destination location. Posting the receipt adds that stock; repeat for later deliveries."
  ],
  [
    "#pur-newbill",
    "Record the supplier invoice",
    "Enter the supplier invoice against the purchase order. Review quantities and prices against receipts before approving the bill."
  ],
  [
    "#pur-tol",
    "Set match tolerance",
    "Review the allowed difference between billed and purchase-order prices before changing the match tolerance."
  ],
  [
    "#bd-approve",
    "Approve the vendor bill",
    "Review the three-way match against the purchase order and receipts. Resolve short receipts or price differences before approval, or review an explicitly authorized override."
  ],
  [
    "#jo-status",
    "Filter job orders",
    "Choose a status to find jobs at the stage you need to review."
  ],
  [
    "#jo-new",
    "Create a production job",
    "Press New job order, choose the product and quantity, then set inspection stages, source/output locations and planned schedule. Save it as a draft."
  ],
  [
    "#jo-acc-counted",
    "Confirm the parts kit",
    "Count the handed-over parts against the Components list before ticking this box. Report a problem if the kit is short or damaged."
  ],
  [
    "#jo-accept",
    "Accept the job order",
    "Confirm the counted kit and optional handover note, then press Accept job order. Production output can be recorded after acceptance."
  ],
  [
    "#jo-progress",
    "Record production output",
    "Enter finished and scrapped quantities and the batch label, then press Apply. Output still needs inspection if configured and Products In receipt before becoming stock."
  ],
  [
    "#fp-add",
    "Define a finished product",
    "Press New finished product, select its item and define the bill of materials needed to build one unit."
  ],
  [
    "#bom-add",
    "Add a component",
    "Choose the component item and quantity needed for one finished unit. Review the unit and quantity before saving the bill of materials."
  ],
  [
    "#fp-qc",
    "Configure inspection checklists",
    "Open QC/QA Checklists to create reusable inspection checks. Attach the appropriate checklist to the product."
  ],
  [
    "#fp-label",
    "Design production labels",
    "Open Label design, review the unit and batch layouts, and preview labels before using them for production."
  ],
  [
    "#qc-checklists",
    "Manage inspection checklists",
    "Open Manage Checklists to add or edit checks. Required checks must be completed before the inspection can pass."
  ],
  [
    "#qi-pass",
    "Pass the inspection",
    "Complete required checks and review remarks before pressing Pass. A final pass queues output for Products In; it does not receive stock."
  ],
  [
    "#qi-fail",
    "Fail the inspection",
    "Select a disposition, describe the fault and attach evidence for the failed unit before pressing Fail. Repair sends it to rework."
  ],
  [
    "#qf-q",
    "Find an inspection finding",
    "Search for a job order or product to locate its inspection history. Open a finding for the checklist, remarks and disposition."
  ],
  [
    "#qf-result",
    "Filter inspection results",
    "Choose the result you want to inspect, then narrow the dates if needed."
  ],
  [
    "#pi-all",
    "Select output to receive",
    "Select the units actually received, or enter the received batch quantity, and choose the storage destination before posting."
  ],
  [
    "#pb-record",
    "Inspect batch traceability",
    "Open Full record to review the batch’s production details, inspections, repairs and stock movements."
  ],
  [
    "#pb-print",
    "Print batch QR labels",
    "Open the QR print view and check the batch identifier and number of labels before printing."
  ],
  [
    "#pr-print",
    "Print the production record",
    "Review the displayed build history, inspections and movements, then print the record if you need a copy."
  ],
  [
    "#ps-team",
    "Filter the production schedule",
    "Choose a team to inspect its planned workload. Use Today or the date arrows to move through the schedule."
  ],
  [
    "#ps-wc",
    "Filter the work centre",
    "Select the work centre whose scheduled jobs you want to review. Capacity information is advisory."
  ],
  [
    "#pt-new",
    "Create a production team",
    "Press New team, enter its name and add the members responsible for its jobs."
  ],
  [
    "#po-reports",
    "Open the production report",
    "Press Full report to inspect production figures beyond the overview. Review the selected scope before exporting or printing."
  ],
  [
    "#fg-q",
    "Find received finished goods",
    "Search finished goods to locate output that has been received into stock and is available to sell or move."
  ],
  [
    "#rp-status",
    "Filter repair requests",
    "Choose a repair-request status to find requests awaiting action. Open a request to review its part, quantity and fault before deciding."
  ],
  [
    "#su-go",
    "Set up ledger books",
    "Review the fiscal year and currency, then press Set up books to create the chart of accounts and first fiscal year."
  ],
  [
    "#je-new",
    "Create a journal entry",
    "Press New entry, choose the posting date and accounts, and enter matching total debits and credits. Save a draft before posting."
  ],
  [
    "#je-post",
    "Post the journal entry",
    "Check the date, accounts and balanced totals before pressing Post. A posted entry must be reversed rather than edited."
  ],
  [
    "#je-void",
    "Reverse a posted journal",
    "Review the posted entry and reversal details before confirming. Reversal posts an offsetting entry and retains the original history."
  ],
  [
    "#coa-new",
    "Add a ledger account",
    "Press New account and enter its code, name and account type. Group accounts are headings; use a posting account for journal lines."
  ],
  [
    "#per-new",
    "Create a ledger period",
    "Enter the fiscal period dates. Check the range before saving; closing a period prevents posting within those dates."
  ],
  [
    "#pr-save",
    "Save posting rules",
    "Review each transaction’s mapped ledger accounts, then press Save posting rules."
  ],
  [
    "#rp-new-pay",
    "Record a payment",
    "Select the customer or supplier and the invoices or bills covered, then enter the actual payment date and amount before saving."
  ],
  [
    "#cn-new",
    "Record a credit or debit note",
    "Choose the party and the affected transaction, then enter the adjustment and reason. Review the amounts before saving."
  ],
  [
    "#pc-fund",
    "Choose the cash fund",
    "Select the petty-cash fund you are reviewing. Check the custodian and current balance before recording cash movements."
  ],
  [
    "#pc-newfund",
    "Manage petty-cash funds",
    "Open Funds to create or review a cash box, its custodian and opening float."
  ],
  [
    "#pc-in",
    "Record cash added to the fund",
    "Press Cash in and enter the amount, date and explanation of the replenishment. Review before saving."
  ],
  [
    "#pc-out",
    "Record a petty-cash expense",
    "Press Cash out and enter the amount, date and expense details. Review supporting information before saving."
  ],
  [
    "#rep-refresh",
    "Refresh management reports",
    "Press Refresh after source records change. Review the available report sections; visibility depends on your access."
  ],
  [
    "#sync-now",
    "Synchronize this computer",
    "Press Sync now to exchange pending changes with the site host. Read the sync status and resolve any reported conflict before repeating."
  ],
  [
    "#site-resync",
    "Re-sync this computer",
    "Use Re-sync this PC when its local copy needs to be refreshed. Read the action’s confirmation and check the host is available first."
  ],
  [
    "#support-refresh",
    "Refresh support information",
    "Press Refresh to retrieve the latest support information and report status."
  ]
];
