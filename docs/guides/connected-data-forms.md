# Build a connected form and sales draft

Custom staff forms can collect manual values, select existing records, fill connected
values and calculate amounts. They are configured in Documents → Data Forms → Form
Builder. Existing employee self-service requests retain their supported field types;
connected staff forms are currently entered through desktop Data Forms, including its
responsive narrow-screen layout.

## Stage 1: choose data instead of retyping it

Add a field, then select a connected type: Product, Customer, Employee, Sales order,
Supplier, Location, Accounting account or Tax code. These selectors search real records
and save the record ID and allowed values together. Company and Signed-in user fields
fill a chosen property automatically.

To fill a separate field, add Text or Number → Connect value → select the connected
field → choose a property. For example, connect Unit to Product → unit, and Price to
Product → sale_price. Number fields offer numeric properties only. Choose whether the
filled value can be edited. Sale price is separate from purchase/production cost.

Each source enforces its existing read permission and module entitlement. Accounting
sources require accounting.view; employee details require hr.view. The catalog is an
explicit set of supported fields, not unrestricted access to every database column.
New sources belong in the shared source registry with their permission and safe fields.

Search returns up to 50 results; narrow the search for more specific matches. An empty
list and a failed request are distinct states. Retry loading preserves entered values.
Missing sale prices remain blank and must be reviewed; an explicitly entered zero is valid.
Existing selections retain their saved values when master data changes or is removed.
Selecting a different record creates a new snapshot. Replacing an item row also creates a
new snapshot; reopening an old record does not silently refresh its prices or units.

## Stage 2: product rows and calculations

Choose Product line items to add up to 50 rows. Each row includes a connected product,
quantity, unit, editable unit price, discount percentage and calculated line total.
Configure items can lock the unit price to its saved catalog price. Quantities must be
positive, prices nonnegative, and discounts between zero and 100 percent.

Choose Calculated number → Configure calculation. Supported operations are sum,
multiply, subtract and percent. Select existing numeric fields or item totals; item
columns support sum. Subtraction and percentage follow the displayed field order.
Cycles and unknown/non-numeric dependencies are rejected. Amounts round to two decimals;
the server recomputes all calculated values before saving. Missing ordinary fields and invalid
product rows appear together in a summary with links to each field and inline error messages.
Correcting a value or removing a row updates its errors without discarding the rest of the form.

A typical invoice has:

- Customer: connected customer, required.
- Items: product line items, required.
- Subtotal: sum of Items → Line totals (after discounts).
- Tax percentage: numeric input, or filled from a connected tax code's rate.
- Tax amount: percent of Subtotal and Tax percentage, in that order.
- Final total: sum of Subtotal and Tax amount.

Print templates expose connected properties such as `{{customer.name}}` and product
properties. A field whose key matches system context (for example company or number)
uses `{{fields.company}}` or `{{fields.number}}` to keep its saved value separate.
Product rows use a repeating section, for example:

```html
{{#items}}
<p>{{name}} — {{quantity}} {{unit}} × {{unit_price}}, discount {{discount_percent}}%: {{line_total}}</p>
{{/items}}
```

The automatically generated layout already contains an item table. The variable bank also
offers Repeating table to insert a complete table; copying that entry copies its template markup. Custom properties
appear in the template editor's linked-form variable category. Checkbox values print as Yes
or No while remaining boolean values for calculations and conditions. New generated layouts
use Issued by / Received by signatures. Existing saved designs keep their content; edit their
signature wording through Print templates when needed.

## Stage 3: create the sales draft

In Automation choose Create a draft sales order on submission. Select the customer field,
product item table, and optionally the tax percentage and calculated final total fields.
Mapping the final total checks that the form and sales order agree. The action requires
orders.create and orders.view as well as the form's own access and enabled Inventory module.

Save as Draft to continue editing. Submit directly when creating the record, or select a
saved draft → Change status → Submitted. Submission and sales-order creation are atomic:
validation or permission failure leaves no partial order. Each submitted record links to
one open sales order. A repeated submission does not create another order. A lost create
response can be retried with the original save key; the editor retains and retries that
request rather than sending changed quantities under an uncertain outcome.

Submitted source records are retained and their values/status are locked. Open the record
and choose Review sales order to review or correct the order. Approval, fulfillment,
accounting entries and stock movements continue through existing sales workflows.
Discounted rows become net-priced sales lines, with the original list price and discount
recorded in the line description. Repeated stock products must be combined into one row
before submission, matching the existing release rules. Archived/deleted customers and
deleted inventory products cannot be submitted.

A custom form named Invoice does not itself issue a posted accounting invoice. The saved
form is its original submission; later corrections to the sales order do not rewrite it.

## Verification and acceptance

Run `npm run test:forms:connected:ux` for real-app Playwright tasks and axe scans in both
themes at 1440, 1024, 768 and 390 CSS pixels. Reports and screenshots are isolated under
`work/connected-forms-ux`. Existing forms and editor gates remain `test:forms:ux` and
`test:editor:ux`.

Have a sales/HR reviewer create their own form and verify product selection, a missing
price, an edited price, zero price, fractional quantity, discount, tax, draft reopen,
printing, submission and order review. Check keyboard-only use and actual browser zoom.
Automated checks supplement that acceptance review.
