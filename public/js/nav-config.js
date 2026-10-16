/* ============================================================================
   Navigation config — the SINGLE SOURCE OF TRUTH for the ECOUNT-style chrome.

   Shape: NAV is an array of PRIMARY sections (top horizontal menu). Each primary
   has SUBTABS (the secondary tab row), and each subtab has TREE leaves (the left
   tree sidebar). A leaf points to a real registered route, optionally with a
   `filter` object passed to the view as its 2nd argument.

     primary { id, label, icon, adminOnly?, requiredPermission?, requiredModule?, subtabs[] }
       subtab  { id, label, requiredPermission?, requiredModule?, tree[] }
         leaf    { label, icon, route, filter? }

   `requiredPermission` hides it from accounts without that permission; `requiredAnyPermission`
   accepts one of several desk permissions (match the permission the
   screen's own GET endpoint checks — UI hiding never replaces the server check); a primary whose
   subtabs are all hidden is hidden too. The Access editor lists these as the screens each
   permission opens (public/js/lib/access-editor.js).
   `requiredModule` hides the primary/subtab when the tenant's SaaS plan / entitlements
   don't include that feature module (see src/modules.ts; App.hasModule in app.js).
   Self-hosted / single-tenant has every module, so nothing is hidden there.

   To add navigation, edit THIS file — do not hand-wire buttons in the shell.
   Every `route` must be one of ROUTE_NAMES (validated by tests/frontend-nav.test.ts).
   ============================================================================ */

const ROUTE_NAMES = ['dashboard', 'analytics', 'accounting', 'accounting-petty-cash', 'accounting-ledger', 'accounting-receivables', 'inventory', 'inventory-movements', 'suppliers', 'customers', 'locations', 'finished-products', 'finished-goods', 'production-overview', 'job-orders', 'production-qc', 'production-receiving', 'repairs', 'production-batches', 'production-schedule', 'production-teams', 'production-record', 'forms', 'orders', 'releasing', 'purchasing', 'templates', 'messages', 'admin', 'activity', 'account', 'form-builder', 'form-records', 'hr', 'hr-employees', 'hr-timekeeping', 'hr-kiosk', 'hr-daily-report', 'hr-contact-verification', 'hr-assets', 'hr-approvals', 'hr-requests', 'confidential-reports', 'identified-reports', 'announcements', 'sop', 'sync', 'stock-discrepancies', 'support', 'billing'];

const NAV = [
  {
    id: 'home', label: 'Home', icon: 'dashboard',
    subtabs: [
      {
        id: 'overview', label: 'Overview',
        tree: [
          { label: 'Dashboard', icon: 'dashboard', route: 'dashboard' },
          { label: 'Reports', icon: 'sheet', route: 'analytics' },
          { label: 'Guide Center', icon: 'help', route: 'sop' },
          { label: 'Announcements', icon: 'messages', route: 'announcements' },
        ],
      },
      { id: 'my-hr', label: 'My HR', requiredModule: 'hr', tree: [
        { label: 'My HR', icon: 'users', route: 'hr-requests' },
        { label: 'Approvals', icon: 'check', route: 'hr-approvals' },
      ] },
    ],
  },
  { id: 'support', label: 'Support', icon: 'help', requiredPermission: 'users.manage', subtabs: [{ id: 'support-tickets', label: 'Bug reports & issues', tree: [{ label: 'Contact OTOM', icon: 'help', route: 'support' }] }] },
  {
    id: 'inventory', label: 'Inventory', icon: 'inventory', requiredModule: 'inventory',
    subtabs: [
      {
        id: 'items', label: 'Items', requiredPermission: 'inventory.view',
        tree: [
          { label: 'All Items', icon: 'inventory', route: 'inventory' },
          { label: 'Low Stock', icon: 'alert', route: 'inventory', filter: { low: '1' } },
        ],
      },
      {
        id: 'movements', label: 'Stock Movements', requiredPermission: 'inventory.view',
        tree: [
          { label: 'All Movements', icon: 'adjust', route: 'inventory-movements' },
          // Offline stock-outs that went below recorded stock (docs/OFFLINE-FIRST.md D1).
          { label: 'Stock Review', icon: 'alert', route: 'stock-discrepancies' },
        ],
      },
      {
        id: 'suppliers', label: 'Suppliers', requiredPermission: 'inventory.view',
        tree: [
          { label: 'Suppliers', icon: 'building', route: 'suppliers' },
        ],
      },
      {
        id: 'customers', label: 'Customers', requiredPermission: 'orders.view',
        tree: [
          { label: 'Customers', icon: 'users', route: 'customers' },
        ],
      },
      {
        id: 'locations', label: 'Locations', requiredPermission: 'inventory.view',
        tree: [
          { label: 'Locations', icon: 'building', route: 'locations' },
        ],
      },
      {
        id: 'orders', label: 'Orders', requiredPermission: 'orders.view',
        tree: [
          { label: 'Sale Orders', icon: 'forms', route: 'orders', filter: { type: 'sale' } },
          { label: 'Job Orders', icon: 'printer', route: 'orders', filter: { type: 'job' } },
        ],
      },
      {
        /* Warehouse side of a sale order, in pipeline order: accept an approved SO -> pick /
           scan it out -> issue the release slip (stock leaves here) -> slip history. */
        id: 'releasing', label: 'Releasing', requiredPermission: 'orders.view',
        tree: [
          { label: 'Release Queue', icon: 'inbox', route: 'releasing', filter: { tab: 'queue' } },
          { label: 'Release Slips', icon: 'sheet', route: 'releasing', filter: { tab: 'slips' } },
        ],
      },
      {
        /* Purchase-to-pay in pipeline order: purchase order -> goods receipt -> vendor bill. */
        id: 'purchasing', label: 'Purchasing', requiredPermission: 'purchasing.view', requiredModule: 'purchasing',
        tree: [
          { label: 'Purchase Orders', icon: 'adjust', route: 'orders', filter: { type: 'purchase' } },
          { label: 'Goods Receipts', icon: 'inbox', route: 'purchasing', filter: { tab: 'receipts' } },
          { label: 'Vendor Bills', icon: 'sheet', route: 'purchasing', filter: { tab: 'bills' } },
        ],
      },
      {
        id: 'form-setup', label: 'Forms', requiredPermission: 'forms.manage.inventory',
        tree: [
          { label: 'Data Forms', icon: 'forms', route: 'form-records', filter: { scope: 'inventory' } },
          { label: 'Form Builder', icon: 'edit', route: 'form-builder', filter: { scope: 'inventory' } },
        ],
      },
    ],
  },
  {
    id: 'production', label: 'Production', icon: 'factory',
    requiredAnyPermission: ['production.view', 'production.record', 'production.pause', 'production.manage', 'production.approve'],
    requiredModule: 'manufacturing',
    /* Subtabs are ordered to match the real build pipeline, not alphabetically or by
       feature-add order: overview (home/summary) -> setup (prerequisite) -> schedule/start ->
       scheduling (supporting, monitoring-only) -> QC -> repair branch -> receive ("Products
       In", mirrors Purchasing's Goods Receipt) -> traceability log -> warehouse-ready stock.
       See docs/guides/production-sop.md. */
    subtabs: [
      {
        id: 'overview', label: 'Overview', requiredPermission: 'production.view',
        tree: [
          { label: 'Overview', icon: 'dashboard', route: 'production-overview' },
        ],
      },
      {
        id: 'products', label: 'Product Setup', requiredPermission: 'production.view',
        tree: [
          { label: 'Products & BOM', icon: 'sparkles', route: 'finished-products' },
        ],
      },
      {
        id: 'shop-floor', label: 'Job Orders',
        tree: [
          { label: 'Job Orders', icon: 'adjust', route: 'job-orders' },
        ],
      },
      {
        id: 'scheduling', label: 'Scheduling', requiredPermission: 'production.view',
        tree: [
          { label: 'Schedule', icon: 'calendar', route: 'production-schedule' },
          { label: 'Teams', icon: 'users', route: 'production-teams' },
        ],
      },
      {
        id: 'qc', label: 'QC / QA', requiredPermission: 'production.view',
        tree: [
          { label: 'Inspection Queue', icon: 'check', route: 'production-qc', filter: { tab: 'queue' } },
          { label: 'On Hold', icon: 'alert', route: 'production-qc', filter: { tab: 'holds' } },
          { label: 'Findings & Reports', icon: 'sheet', route: 'production-qc', filter: { tab: 'findings' } },
        ],
      },
      {
        id: 'repairs', label: 'Repairs & Parts Requests', requiredPermission: 'production.view',
        tree: [
          { label: 'Repairs & Parts Requests', icon: 'inbox', route: 'repairs' },
        ],
      },
      {
        id: 'products-in', label: 'Products In', requiredPermission: 'production.view',
        tree: [
          { label: 'Ready to Receive', icon: 'inbox', route: 'production-receiving', filter: { tab: 'queue' } },
          { label: 'Receipt History', icon: 'sheet', route: 'production-receiving', filter: { tab: 'history' } },
        ],
      },
      {
        id: 'batches', label: 'Batches / Lots', requiredPermission: 'production.view',
        tree: [
          { label: 'Batches / Lots', icon: 'archive', route: 'production-batches' },
        ],
      },
      {
        id: 'finished-goods', label: 'Finished Goods', requiredPermission: 'production.view',
        tree: [
          { label: 'Finished Goods', icon: 'sparkles', route: 'finished-goods' },
        ],
      },
    ],
  },
  {
    id: 'docs', label: 'Documents', icon: 'forms',
    subtabs: [
      {
        id: 'files', label: 'Files', requiredPermission: 'forms.view',
        tree: [
          { label: 'All Files', icon: 'folder', route: 'forms' },
        ],
      },
      {
        id: 'custom-forms', label: 'Data Forms',
        tree: [
          { label: 'All Forms', icon: 'folder', route: 'form-records' },
        ],
      },
      {
        id: 'templates', label: 'Templates', requiredPermission: 'templates.view',
        tree: [
          { label: 'Templates', icon: 'file', route: 'templates' },
        ],
      },
    ],
  },
  {
    id: 'hr', label: 'HR', icon: 'users', requiredPermission: 'hr.view', requiredModule: 'hr',
    subtabs: [
      {
        id: 'overview', label: 'Overview',
        tree: [
          { label: 'Human Resources', icon: 'users', route: 'hr' },
        ],
      },
      {
        id: 'employees', label: 'Employees',
        tree: [
          { label: 'Employees', icon: 'users', route: 'hr-employees' },
          { label: 'Contact Verification', icon: 'users', route: 'hr-contact-verification' },
          { label: 'Company Assets', icon: 'archive', route: 'hr-assets' },
        ],
      },
      {
        id: 'payroll', label: 'Payroll', requiredPermission: 'payroll.view',
        tree: [
          { label: 'Payroll', icon: 'sheet', route: 'form-records', filter: { slug: 'hr_payroll' } },
        ],
      },
      {
        id: 'timekeeping', label: 'Time Keeping',
        tree: [
          { label: 'Time Keeping', icon: 'calendar', route: 'hr-timekeeping' },
          { label: 'Time-in Kiosk', icon: 'calendar', route: 'hr-kiosk' },
          { label: 'Daily Report', icon: 'sheet', route: 'hr-daily-report' },
        ],
      },
      {
        // Anonymous-channel case handling (reports.confidential — HR + admin by default).
        id: 'anonymous-reports', label: 'Anonymous Reports', requiredPermission: 'reports.confidential',
        tree: [
          { label: 'Anonymous Reports', icon: 'alert', route: 'confidential-reports' },
        ],
      },
      {
        id: 'identified-reports', label: 'Identified Reports',
        tree: [{ label: 'Identified Reports', icon: 'alert', route: 'identified-reports' }],
      },
      {
        id: 'form-setup', label: 'HR Forms', requiredPermission: 'forms.manage.hr',
        tree: [
          { label: 'Data Forms', icon: 'forms', route: 'form-records', filter: { scope: 'hr' } },
          { label: 'Form Builder', icon: 'edit', route: 'form-builder', filter: { scope: 'hr' } },
        ],
      },
    ],
  },
  {
    id: 'accounting', label: 'Accounting', icon: 'sheet', requiredModule: 'accounting',
    subtabs: [
      {
        id: 'tax', label: 'Tax & Compliance', requiredPermission: 'accounting.view',
        tree: [
          { label: 'Tax & Compliance', icon: 'sheet', route: 'accounting' },
        ],
      },
      {
        id: 'ledger', label: 'General Ledger', requiredPermission: 'accounting.view',
        tree: [
          { label: 'Books', icon: 'sheet', route: 'accounting-ledger' },
        ],
      },
      {
        id: 'receivables', label: 'Receivables & Payables', requiredPermission: 'accounting.view',
        tree: [
          { label: 'AR / AP Aging', icon: 'sheet', route: 'accounting-receivables' },
          { label: 'Payments', icon: 'adjust', route: 'accounting-receivables', filter: { tab: 'payments' } },
          { label: 'Credit / Debit Notes', icon: 'sheet', route: 'accounting-receivables', filter: { tab: 'credit notes' } },
        ],
      },
      {
        id: 'cash', label: 'Cash', requiredPermission: 'accounting.view',
        tree: [
          { label: 'Petty Cash', icon: 'sheet', route: 'accounting-petty-cash' },
        ],
      },
      {
        id: 'form-setup', label: 'Forms', requiredPermission: 'forms.manage.accounting',
        tree: [
          { label: 'Data Forms', icon: 'forms', route: 'form-records', filter: { scope: 'accounting' } },
          { label: 'Form Builder', icon: 'edit', route: 'form-builder', filter: { scope: 'accounting' } },
        ],
      },
    ],
  },
  {
    id: 'admin', label: 'Admin', icon: 'users', requiredPermission: 'users.manage',
    subtabs: [
      {
        id: 'accounts', label: 'Accounts',
        tree: [
          { label: 'User Accounts', icon: 'users', route: 'admin' },
          { label: 'Roles', icon: 'key', route: 'admin', filter: { tab: 'roles' } },
          { label: 'Departments', icon: 'building', route: 'admin', filter: { tab: 'departments' } },
        ],
      },
      {
        id: 'activity', label: 'Activity', requiredPermission: 'audit.view',
        tree: [
          { label: 'Activity Log', icon: 'history', route: 'activity' },
        ],
      },
      {
        id: 'installed-pcs', label: 'Installed PCs',
        tree: [
          // Offline-capable PCs enrolled against this workspace (docs/OFFLINE-FIRST.md §13).
          { label: 'Installed PCs', icon: 'building', route: 'sync' },
        ],
      },
      {
        id: 'billing', label: 'Billing',
        tree: [
          // Our invoices to this workspace + paying by GCash or bank transfer (docs/SAAS-READINESS.md §12).
          { label: 'Invoices & payments', icon: 'file', route: 'billing' },
        ],
      },
      {
        id: 'form-setup', label: 'Forms', requiredPermission: 'forms.manage.admin',
        tree: [
          { label: 'Data Forms', icon: 'forms', route: 'form-records', filter: { scope: 'admin' } },
          { label: 'Form Builder', icon: 'edit', route: 'form-builder', filter: { scope: 'admin' } },
        ],
      },
    ],
  },
];

// Browser: expose as globals (loaded via <script> before app.js).
// Node (tests): export for require().
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NAV, ROUTE_NAMES };
}
