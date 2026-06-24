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

const ROUTE_NAMES = ['dashboard', 'inventory', 'forms', 'messages', 'admin', 'account'];

const NAV = [
  {
    id: 'home', label: 'Home', icon: 'dashboard',
    subtabs: [
      {
        id: 'overview', label: 'Overview',
        tree: [
          { label: 'Dashboard', icon: 'dashboard', route: 'dashboard' },
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
          { label: 'All Items', icon: 'adjust', route: 'inventory' },
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
    id: 'admin', label: 'Admin', icon: 'users', adminOnly: true,
    subtabs: [
      {
        id: 'accounts', label: 'Accounts',
        tree: [
          { label: 'User Accounts', icon: 'users', route: 'admin' },
          { label: 'Departments', icon: 'building', route: 'admin', filter: { tab: 'departments' } },
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
