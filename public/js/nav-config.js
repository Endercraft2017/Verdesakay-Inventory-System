/* ============================================================================
   Navigation config — the SINGLE SOURCE OF TRUTH for the ECOUNT-style chrome.

   Shape: NAV is an array of PRIMARY sections (top horizontal menu). Each primary
   has SUBTABS (the secondary tab row), and each subtab has TREE leaves (the left
   tree sidebar). A leaf points to a real registered route, optionally with a
   `filter` object passed to the view as its 2nd argument.

     primary { id, label, icon, adminOnly?, requiredPermission?, requiredModule?, subtabs[] }
       subtab  { id, label, requiredPermission?, requiredModule?, tree[] }
         leaf    { label, icon, route, filter? }

   `requiredModule` hides the primary/subtab when the tenant's SaaS plan / entitlements
   don't include that feature module (see src/modules.ts; App.hasModule in app.js).
   Self-hosted / single-tenant has every module, so nothing is hidden there.

   To add navigation, edit THIS file — do not hand-wire buttons in the shell.
   Every `route` must be one of ROUTE_NAMES (validated by tests/frontend-nav.test.ts).
   ============================================================================ */

const ROUTE_NAMES = ['dashboard', 'analytics', 'accounting', 'accounting-petty-cash', 'accounting-ledger', 'accounting-receivables', 'inventory', 'inventory-movements', 'suppliers', 'customers', 'locations', 'finished-products', 'finished-goods', 'production-overview', 'job-orders', 'production-qc', 'production-receiving', 'repairs', 'production-batches', 'production-schedule', 'production-teams', 'production-record', 'forms', 'orders', 'releasing', 'purchasing', 'templates', 'messages', 'admin', 'activity', 'account', 'form-builder', 'form-records', 'hr', 'hr-employees', 'hr-timekeeping', 'hr-kiosk', 'hr-daily-report', 'hr-contact-verification', 'confidential-reports', 'announcements', 'sop'];

const NAV = [
  {
    id: 'home', label: 'Home', icon: 'dashboard',
    subtabs: [
      {
        id: 'overview', label: 'Overview',
        tree: [
          { label: 'Dashboard', icon: 'dashboard', route: 'dashboard' },
          { label: 'Reports', icon: 'sheet', route: 'analytics' },
          { label: 'Help / SOP', icon: 'help', route: 'sop' },
          { label: 'Announcements', icon: 'messages', route: 'announcements' },
        ],
      },
    ],
  },
  {
    id: 'inventory', label: 'Inventory', icon: 'inventory', requiredModule: 'inventory',
    subtabs: [
      {
        id: 'items', label: 'Items',
        tree: [
          { label: 'All Items', icon: 'inventory', route: 'inventory' },
          { label: 'Low Stock', icon: 'alert', route: 'inventory', filter: { low: '1' } },
        ],
      },
      {
        id: 'movements', label: 'Stock Movements',
        tree: [
          { label: 'All Movements', icon: 'adjust', route: 'inventory-movements' },
        ],
      },
      {
        id: 'suppliers', label: 'Suppliers',
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
        id: 'locations', label: 'Locations',
        tree: [
          { label: 'Locations', icon: 'building', route: 'locations' },
        ],
      },
      {
        id: 'orders', label: 'Orders',
        tree: [
          { label: 'Sale Orders', icon: 'forms', route: 'orders', filter: { type: 'sale' } },
          { label: 'Job Orders', icon: 'printer', route: 'orders', filter: { type: 'job' } },
          { label: 'Purchase Orders', icon: 'adjust', route: 'orders', filter: { type: 'purchase' } },
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
        id: 'purchasing', label: 'Purchasing', requiredPermission: 'orders.view', requiredModule: 'purchasing',
        tree: [
          { label: 'Goods Receipts', icon: 'inbox', route: 'purchasing', filter: { tab: 'receipts' } },
          { label: 'Vendor Bills', icon: 'sheet', route: 'purchasing', filter: { tab: 'bills' } },
        ],
      },
      {
        id: 'form-setup', label: 'Form Builder', requiredPermission: 'forms.manage.inventory',
        tree: [
          { label: 'Form Builder', icon: 'edit', route: 'form-builder', filter: { scope: 'inventory' } },
        ],
      },
    ],
  },
  {
    id: 'production', label: 'Production', icon: 'factory', requiredModule: 'manufacturing',
    /* Subtabs are ordered to match the real build pipeline, not alphabetically or by
       feature-add order: overview (home/summary) -> setup (prerequisite) -> schedule/start ->
       scheduling (supporting, monitoring-only) -> QC -> repair branch -> receive ("Products
       In", mirrors Purchasing's Goods Receipt) -> traceability log -> warehouse-ready stock.
       See docs/guides/production-sop.md. */
    subtabs: [
      {
        id: 'overview', label: 'Overview',
        tree: [
          { label: 'Overview', icon: 'dashboard', route: 'production-overview' },
        ],
      },
      {
        id: 'products', label: 'Product Setup',
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
        id: 'scheduling', label: 'Scheduling',
        tree: [
          { label: 'Schedule', icon: 'calendar', route: 'production-schedule' },
          { label: 'Teams', icon: 'users', route: 'production-teams' },
        ],
      },
      {
        id: 'qc', label: 'QC / QA',
        tree: [
          { label: 'Inspection Queue', icon: 'check', route: 'production-qc', filter: { tab: 'queue' } },
          { label: 'Findings & Reports', icon: 'sheet', route: 'production-qc', filter: { tab: 'findings' } },
        ],
      },
      {
        id: 'repairs', label: 'Repairs & Parts Requests',
        tree: [
          { label: 'Repairs & Parts Requests', icon: 'inbox', route: 'repairs' },
        ],
      },
      {
        id: 'products-in', label: 'Products In',
        tree: [
          { label: 'Ready to Receive', icon: 'inbox', route: 'production-receiving', filter: { tab: 'queue' } },
          { label: 'Receipt History', icon: 'sheet', route: 'production-receiving', filter: { tab: 'history' } },
        ],
      },
      {
        id: 'batches', label: 'Batches / Lots',
        tree: [
          { label: 'Batches / Lots', icon: 'archive', route: 'production-batches' },
        ],
      },
      {
        id: 'finished-goods', label: 'Finished Goods',
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
        id: 'files', label: 'Files',
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
        id: 'templates', label: 'Templates',
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
        ],
      },
      {
        id: 'payroll', label: 'Payroll',
        tree: [
          { label: 'Payroll', icon: 'sheet', route: 'form-records', filter: { slug: 'hr_payroll' } },
        ],
      },
      {
        id: 'memos', label: 'Memos & Notices',
        tree: [
          { label: 'Memos & Notices', icon: 'alert', route: 'form-records', filter: { scope: 'hr' } },
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
        id: 'form-setup', label: 'Form Builder', requiredPermission: 'forms.manage.hr',
        tree: [
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
        id: 'form-setup', label: 'Form Builder', requiredPermission: 'forms.manage.accounting',
        tree: [
          { label: 'Form Builder', icon: 'edit', route: 'form-builder', filter: { scope: 'accounting' } },
        ],
      },
    ],
  },
  {
    id: 'messages', label: 'Messages', icon: 'messages',
    subtabs: [
      {
        id: 'chat', label: 'Messages',
        tree: [
          { label: 'Messages', icon: 'messages', route: 'messages' },
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
        id: 'form-setup', label: 'Form Builder', requiredPermission: 'forms.manage.admin',
        tree: [
          { label: 'Form Builder', icon: 'edit', route: 'form-builder', filter: { scope: 'admin' } },
        ],
      },
    ],
  },
  {
    id: 'account', label: 'My Account', icon: 'settings',
    subtabs: [
      {
        id: 'profile', label: 'Profile',
        tree: [
          { label: 'My Account', icon: 'settings', route: 'account' },
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
