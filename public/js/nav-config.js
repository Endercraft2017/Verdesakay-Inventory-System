/* ============================================================================
   Navigation config — the SINGLE SOURCE OF TRUTH for the ECOUNT-style chrome.

   Shape: NAV is an array of PRIMARY sections (top horizontal menu). Each primary
   has SUBTABS (the secondary tab row), and each subtab has TREE leaves (the left
   tree sidebar). A leaf points to a real registered route, optionally with a
   `filter` object passed to the view as its 2nd argument.

     primary { id, label, icon, adminOnly?, subtabs[] }
       subtab  { id, label, tree[] }
         leaf    { label, icon, route, filter? }

   To add navigation, edit THIS file — do not hand-wire buttons in the shell.
   Every `route` must be one of ROUTE_NAMES (validated by tests/frontend-nav.test.ts).
   ============================================================================ */

const ROUTE_NAMES = ['dashboard', 'analytics', 'accounting', 'accounting-petty-cash', 'inventory', 'inventory-movements', 'suppliers', 'locations', 'finished-products', 'job-orders', 'forms', 'orders', 'purchasing', 'templates', 'messages', 'admin', 'activity', 'account', 'form-builder', 'form-records', 'hr', 'hr-employees', 'hr-timekeeping', 'hr-kiosk', 'announcements'];

const NAV = [
  {
    id: 'home', label: 'Home', icon: 'dashboard',
    subtabs: [
      {
        id: 'overview', label: 'Overview',
        tree: [
          { label: 'Dashboard', icon: 'dashboard', route: 'dashboard' },
          { label: 'Reports', icon: 'sheet', route: 'analytics' },
          { label: 'Announcements', icon: 'messages', route: 'announcements' },
        ],
      },
    ],
  },
  {
    id: 'inventory', label: 'Inventory', icon: 'inventory',
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
        id: 'finished', label: 'Finished Products',
        tree: [
          { label: 'Finished Products', icon: 'sparkles', route: 'finished-products' },
        ],
      },
      {
        id: 'suppliers', label: 'Suppliers',
        tree: [
          { label: 'Suppliers', icon: 'building', route: 'suppliers' },
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
        id: 'purchasing', label: 'Purchasing', requiredPermission: 'orders.view',
        tree: [
          { label: 'Goods Receipts', icon: 'inbox', route: 'purchasing', filter: { tab: 'receipts' } },
          { label: 'Vendor Bills', icon: 'sheet', route: 'purchasing', filter: { tab: 'bills' } },
        ],
      },
      {
        id: 'production', label: 'Production',
        tree: [
          { label: 'Job Orders (Production)', icon: 'adjust', route: 'job-orders' },
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
    id: 'hr', label: 'HR', icon: 'users', requiredPermission: 'hr.view',
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
        ],
      },
      {
        id: 'timekeeping', label: 'Time Keeping',
        tree: [
          { label: 'Time Keeping', icon: 'calendar', route: 'hr-timekeeping' },
          { label: 'Time-in Kiosk', icon: 'calendar', route: 'hr-kiosk' },
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
    id: 'accounting', label: 'Accounting', icon: 'sheet',
    subtabs: [
      {
        id: 'tax', label: 'Tax & Compliance', requiredPermission: 'accounting.view',
        tree: [
          { label: 'Tax & Compliance', icon: 'sheet', route: 'accounting' },
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
        id: 'mailbox', label: 'Mailbox',
        tree: [
          { label: 'Inbox', icon: 'inbox', route: 'messages', filter: { box: 'inbox' } },
          { label: 'Sent', icon: 'send', route: 'messages', filter: { box: 'sent' } },
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
