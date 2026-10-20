# Accounting tax-report employee privacy

20 October 2026. Scoped engineering fix; release approval remains on hold.

## Finding and resolution

High: `GET /api/accounting/bir-2316/:employeeId` previously selected `employees.*`.
An accounting-only user could read base rates, deduction overrides, leave balances,
photo references, civil status and HR configuration through a tax-filing response.
The route also exposed any future column added to that table. Reproduced with a
synthetic employee and the built-in accounting role, which cannot read `/api/hr/employees`.
No claim of exploitation or exposure of emergency contacts/bank details is made:
those were not demonstrated by this reproduction.

The query now explicitly selects only `id`, `employee_no`, `name`, `position`,
`tin_no`, `birth_date`, `sss_no`, `philhealth_no`, `pagibig_no`, and the joined
`department_name`. The derived `birth_date_mdy` remains available. The existing
certificate template references employee number, position, contribution IDs,
name, TIN and formatted birth date; those fields are preserved for compatibility.
This is the application's bounded template contract, not a claim that every one
of these identifiers is a legally mandatory BIR field. The historical template's
`employee.department` placeholder was already unresolved; this change does not
add an alias or fix that independent template issue.

The response envelope (`year`, `company`, `employee`, `figures`), tax computation,
404 behavior, tenant database selection and `accounting.view` gate are unchanged.
General `payroll.view` is not required for statutory filings. Existing API-wide
`Cache-Control: no-store` is verified. Neither authorization nor data minimization
is delegated to the browser. Custom templates that used unrelated HR fields must
remove those references; accounting access does not authorize a full HR export.
The shared template-variable mechanism is outside the scope of this route fix.

## Verification

- Regression reproduces the excessive projection before the fix (2 failures,
  3 passes); first sandbox attempt could not bind a test HTTP server and ran no cases.
- Exact response-key assertions with a synthetic accounting user, positive tax
  identity/template data, no-store, unauthenticated/non-accounting denial, missing
  employee and blank date/department behavior.
- A disposable test adds an unrelated employee column and verifies it cannot
  appear automatically. Production schema is unchanged.
- Existing HR tax-calculation regression preserves generated-payslip figures.
- Playwright uses isolated administrative fixture lookup, then an accounting-only
  browser session to fetch the report, render the seeded template and verify HR
  access is still refused. It does not claim printer/device or tax-filing acceptance.

See [validation results](../audits/validation-results.md) for completed run counts
and archived evidence. No dependency/schema migration or live customer data changes.

## Remaining work

This closes one demonstrated projection gap, not the whole privacy/export audit.
Review other statutory endpoints, custom template variables, payroll download/email,
per-role read/export policies, tenant isolation adversarial scenarios, local/offline
copies, retention/deletion/legal holds and sensitive action audit records separately.
Owner/counsel retention and lawful-basis approval and real agency/printer acceptance
remain required. Whole-control scorecard counts are unchanged.

Research: [OWASP API3:2023](https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/),
retrieved 20 October 2026, recommends explicitly selecting properties and keeping
responses to the minimum needed by the endpoint. This implements that principle
for this route; it is not certification of the application.
