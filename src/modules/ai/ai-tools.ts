/**
 * AI Agent tool definitions and executor.
 *
 * Each tool maps to a Permission from permissions.ts.
 * Personal tools (notes, tasks) require no special permission — any authenticated user.
 * Tools are filtered to those the calling user actually holds before being sent to the LLM.
 */
import { moduleEnabled } from '../../shared/modules';
import { db, queryOne, queryAll, run, getSetting, setSetting } from '../../shared/db';
import { endUserSessions } from '../../shared/auth';
import { getRole } from '../../shared/roles';
import { canOnOrder, visibleOrderTypes } from '../inventory/order-access';
import { applyStockChange, stockAt, getDefaultLocationId } from '../inventory/inventory-stock';
import { parseBody, createUserSchema, updateUserSchema, createItemSchema, updateItemSchema } from '../../shared/validation';
import { visibilityClause } from '../../core/forms.routes';
import { analyticsToolsForUser, isAnalyticsTool, executeAnalyticsTool } from './ai-analytics';
import { reportingToolsForUser, isReportingTool, executeReportingTool } from './ai-reporting';
import { ragToolsForUser, isRagTool, executeRagTool } from './ai-rag';
import { mailToolsForUser, isMailTool, executeMailTool } from './ai-mail';
import { hrFormToolsForUser, isHrFormTool, executeHrFormTool } from './ai-hr-forms';
import type { AuthUser, Permission } from '../../shared/types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CerebrasTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

type ToolName =
  | 'get_departments'
  | 'search_inventory' | 'get_inventory_item' | 'get_inventory_stats'
  | 'create_inventory_item' | 'update_inventory_item' | 'adjust_stock' | 'delete_inventory_item'
  | 'search_orders' | 'get_order' | 'create_order' | 'update_order' | 'delete_order'
  | 'get_messages' | 'send_message' | 'get_unread_count' | 'mark_message_read'
  | 'get_forms'
  | 'list_users' | 'create_user' | 'update_user'
  | 'get_notes' | 'create_note' | 'update_note' | 'delete_note'
  | 'get_tasks' | 'create_task' | 'update_task' | 'delete_task';

/** Null = no special permission needed (any authenticated user). */
const TOOL_PERMISSION: Record<ToolName, Permission | null> = {
  get_departments: null,
  search_inventory: 'inventory.view',
  get_inventory_item: 'inventory.view',
  get_inventory_stats: 'inventory.view',
  create_inventory_item: 'inventory.create',
  update_inventory_item: 'inventory.edit',
  adjust_stock: 'inventory.adjust',
  delete_inventory_item: 'inventory.delete',
  search_orders: 'orders.view',
  get_order: 'orders.view',
  create_order: 'orders.create',
  update_order: 'orders.edit',
  delete_order: 'orders.delete',
  get_messages: 'messages.view',
  send_message: 'messages.send',
  get_unread_count: 'messages.view',
  mark_message_read: 'messages.view',
  get_forms: 'forms.view',
  list_users: 'users.manage',
  create_user: 'users.manage',
  update_user: 'users.manage',
  get_notes: null,
  create_note: null,
  update_note: null,
  delete_note: null,
  get_tasks: null,
  create_task: null,
  update_task: null,
  delete_task: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool specifications (sent to Cerebras)
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_SPECS: Record<ToolName, CerebrasTool> = {
  // ── Utility ──────────────────────────────────────────────────────────────
  get_departments: {
    type: 'function',
    function: {
      name: 'get_departments',
      description: 'List all departments (id + name). Useful when the user needs to pick a department for items, users, or filters.',
      parameters: { type: 'object', properties: {} },
    },
  },

  // ── Inventory ─────────────────────────────────────────────────────────────
  search_inventory: {
    type: 'function',
    function: {
      name: 'search_inventory',
      description: 'Search or list inventory items. Filter by keyword, department, category, or low-stock flag. Returns up to 50 items.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword to search in name, SKU, category, or location.' },
          department_id: { type: 'number', description: 'Filter by department ID.' },
          category: { type: 'string', description: 'Filter by exact category name.' },
          low_stock_only: { type: 'boolean', description: 'If true, return only items at or below minimum stock.' },
        },
      },
    },
  },

  get_inventory_item: {
    type: 'function',
    function: {
      name: 'get_inventory_item',
      description: 'Get full details and the last 20 stock movements for one inventory item.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Item ID.' },
        },
        required: ['id'],
      },
    },
  },

  get_inventory_stats: {
    type: 'function',
    function: {
      name: 'get_inventory_stats',
      description: 'Get dashboard statistics: total items, total quantity, low-stock count, and category breakdown.',
      parameters: { type: 'object', properties: {} },
    },
  },

  create_inventory_item: {
    type: 'function',
    function: {
      name: 'create_inventory_item',
      description: 'Create a new inventory item. The initial quantity is also recorded as the first stock transaction.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Item name (required).' },
          sku: { type: 'string', description: 'Product code / SKU.' },
          category: { type: 'string', description: 'Category label.' },
          department_id: { type: 'number', description: 'Owning department ID.' },
          quantity: { type: 'number', description: 'Initial quantity (default 0).' },
          unit: { type: 'string', description: 'Unit of measure — pcs, kg, box, etc.' },
          min_quantity: { type: 'number', description: 'Minimum stock before low-stock alert (default 0).' },
          location: { type: 'string', description: 'Storage location.' },
          notes: { type: 'string', description: 'Additional notes.' },
        },
        required: ['name'],
      },
    },
  },

  update_inventory_item: {
    type: 'function',
    function: {
      name: 'update_inventory_item',
      description: 'Update details of an existing inventory item. Does NOT change quantity — use adjust_stock for that.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Item ID.' },
          name: { type: 'string' },
          sku: { type: 'string' },
          category: { type: 'string' },
          department_id: { type: 'number' },
          unit: { type: 'string' },
          min_quantity: { type: 'number' },
          location: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['id'],
      },
    },
  },

  adjust_stock: {
    type: 'function',
    function: {
      name: 'adjust_stock',
      description: 'Adjust the stock quantity of an item. Positive = stock in, negative = stock out. Records a transaction in the audit trail.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Item ID.' },
          change: { type: 'number', description: 'Non-zero quantity change (e.g. 10 or -5).' },
          reason: { type: 'string', description: 'Reason for the adjustment.' },
        },
        required: ['id', 'change'],
      },
    },
  },

  delete_inventory_item: {
    type: 'function',
    function: {
      name: 'delete_inventory_item',
      description: 'Permanently delete an inventory item and all its transaction history. This cannot be undone.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Item ID.' },
        },
        required: ['id'],
      },
    },
  },

  // ── Orders ────────────────────────────────────────────────────────────────
  search_orders: {
    type: 'function',
    function: {
      name: 'search_orders',
      description: 'List job, sale, or purchase orders. Filter by type and optional search keyword. Returns up to 30 orders.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['sale', 'job', 'purchase'], description: 'Order type.' },
          query: { type: 'string', description: 'Keyword to search in order number or customer name.' },
        },
      },
    },
  },

  get_order: {
    type: 'function',
    function: {
      name: 'get_order',
      description: 'Get full details for a specific order, including all line items.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Order ID.' },
        },
        required: ['id'],
      },
    },
  },

  create_order: {
    type: 'function',
    function: {
      name: 'create_order',
      description: 'Create a new sale, job, or purchase order with line items. An order number (SO-##### / JO-##### / PR-#####) is auto-generated. Server computes subtotal, tax, and total.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['sale', 'job', 'purchase'], description: 'Order type.' },
          customer_name: { type: 'string' },
          customer_contact: { type: 'string' },
          order_date: { type: 'string', description: 'ISO date string, e.g. 2026-06-29.' },
          status: { type: 'string', description: 'Status label, e.g. open, processing, complete.' },
          currency: { type: 'string', description: 'Currency code, e.g. PHP, USD (default PHP).' },
          tax_percent: { type: 'number', description: 'Tax percentage (default 0).' },
          notes: { type: 'string' },
          items: {
            type: 'array',
            description: 'Line items (at least one required).',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                sku: { type: 'string' },
                description: { type: 'string' },
                quantity: { type: 'number' },
                unit: { type: 'string' },
                unit_price: { type: 'number' },
              },
              required: ['name', 'quantity', 'unit_price'],
            },
          },
        },
        required: ['type', 'items'],
      },
    },
  },

  update_order: {
    type: 'function',
    function: {
      name: 'update_order',
      description: 'Update an existing order. Replaces all line items with the new list. Server recomputes totals.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Order ID.' },
          customer_name: { type: 'string' },
          customer_contact: { type: 'string' },
          order_date: { type: 'string' },
          status: { type: 'string' },
          currency: { type: 'string' },
          tax_percent: { type: 'number' },
          notes: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                sku: { type: 'string' },
                description: { type: 'string' },
                quantity: { type: 'number' },
                unit: { type: 'string' },
                unit_price: { type: 'number' },
              },
              required: ['name', 'quantity', 'unit_price'],
            },
          },
        },
        required: ['id', 'items'],
      },
    },
  },

  delete_order: {
    type: 'function',
    function: {
      name: 'delete_order',
      description: 'Delete an order and all its line items. This cannot be undone.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Order ID.' },
        },
        required: ['id'],
      },
    },
  },

  // ── Messages ──────────────────────────────────────────────────────────────
  get_messages: {
    type: 'function',
    function: {
      name: 'get_messages',
      description: "Get the current user's inbox or sent messages (most recent 20).",
      parameters: {
        type: 'object',
        properties: {
          box: { type: 'string', enum: ['inbox', 'sent'], description: 'Which mailbox to read (default: inbox).' },
        },
      },
    },
  },

  send_message: {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send an internal message to another user. You cannot message yourself.',
      parameters: {
        type: 'object',
        properties: {
          recipient_id: { type: 'number', description: 'User ID of the recipient.' },
          subject: { type: 'string', description: 'Message subject (optional).' },
          body: { type: 'string', description: 'Message body (required).' },
        },
        required: ['recipient_id', 'body'],
      },
    },
  },

  get_unread_count: {
    type: 'function',
    function: {
      name: 'get_unread_count',
      description: "Get the number of unread messages in the current user's inbox.",
      parameters: { type: 'object', properties: {} },
    },
  },

  mark_message_read: {
    type: 'function',
    function: {
      name: 'mark_message_read',
      description: 'Mark a message as read.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Message ID.' },
        },
        required: ['id'],
      },
    },
  },

  // ── Forms ─────────────────────────────────────────────────────────────────
  get_forms: {
    type: 'function',
    function: {
      name: 'get_forms',
      description: "List documents/forms visible to the current user (own department + company-wide).",
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category.' },
        },
      },
    },
  },

  // ── Users ─────────────────────────────────────────────────────────────────
  list_users: {
    type: 'function',
    function: {
      name: 'list_users',
      description: 'List user accounts in the system. Returns id, username, full_name, role, department, active status.',
      parameters: {
        type: 'object',
        properties: {
          department_id: { type: 'number', description: 'Filter by department ID.' },
          active_only: { type: 'boolean', description: 'If true, only return active accounts.' },
        },
      },
    },
  },

  create_user: {
    type: 'function',
    function: {
      name: 'create_user',
      description: 'Create a new user account.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: '3-30 chars: letters, numbers, dot, underscore, hyphen.' },
          full_name: { type: 'string' },
          password: { type: 'string', description: 'Initial password (min 6 characters).' },
          role: {
            type: 'string',
            description: "Role key (a permission bundle the workspace defines under Admin → Roles), e.g. 'warehouse', 'hr', 'admin_staff'. Defaults to admin_staff.",
          },
          department_id: { type: 'number' },
        },
        required: ['username', 'full_name', 'password'],
      },
    },
  },

  update_user: {
    type: 'function',
    function: {
      name: 'update_user',
      description: 'Update a user account (name, role, department, or active status).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'User ID.' },
          full_name: { type: 'string' },
          role: { type: 'string', description: 'Role key — one the workspace defines under Admin → Roles.' },
          department_id: { type: 'number' },
          active: { type: 'boolean', description: 'Set false to deactivate the account.' },
        },
        required: ['id'],
      },
    },
  },

  // ── Personal tools (no permission needed — scoped to caller) ──────────────
  get_notes: {
    type: 'function',
    function: {
      name: 'get_notes',
      description: "List all personal notes for the current user.",
      parameters: { type: 'object', properties: {} },
    },
  },

  create_note: {
    type: 'function',
    function: {
      name: 'create_note',
      description: 'Create a personal note.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Note title (optional).' },
          body: { type: 'string', description: 'Note content (required).' },
        },
        required: ['body'],
      },
    },
  },

  update_note: {
    type: 'function',
    function: {
      name: 'update_note',
      description: 'Update a personal note.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['id'],
      },
    },
  },

  delete_note: {
    type: 'function',
    function: {
      name: 'delete_note',
      description: 'Delete a personal note.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
  },

  get_tasks: {
    type: 'function',
    function: {
      name: 'get_tasks',
      description: "List all personal tasks for the current user (pending first, then done).",
      parameters: { type: 'object', properties: {} },
    },
  },

  create_task: {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a personal task.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title (required).' },
          due_date: { type: 'string', description: 'Due date as ISO date string, e.g. 2026-07-01.' },
        },
        required: ['title'],
      },
    },
  },

  update_task: {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Update a personal task (title, due date, or done status).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          title: { type: 'string' },
          due_date: { type: 'string' },
          done: { type: 'boolean' },
        },
        required: ['id'],
      },
    },
  },

  delete_task: {
    type: 'function',
    function: {
      name: 'delete_task',
      description: 'Delete a personal task.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Preserve role permissions, while removing capabilities the tenant has disabled. */
function entitledUser(user: AuthUser): AuthUser {
  return { ...user, permissions: user.permissions.filter(p => {
    if (/^(inventory|orders|delivery)\./.test(p) || p === 'forms.manage.inventory') return moduleEnabled('inventory');
    if (/^(production|qc)\./.test(p)) return moduleEnabled('manufacturing');
    if (p.startsWith('purchasing.')) return moduleEnabled('purchasing');
    if (/^(hr|payroll)\./.test(p) || p === 'forms.manage.hr') return moduleEnabled('hr');
    if (p.startsWith('accounting.') || p === 'forms.manage.accounting') return moduleEnabled('accounting');
    if (p.startsWith('mail.')) return moduleEnabled('email');
    return true;
  }) };
}

/** Return the subset of tools the authenticated user is permitted to call. */
export function getToolsForUser(user: AuthUser): CerebrasTool[] {
  user = entitledUser(user);
  const core = (Object.keys(TOOL_SPECS) as ToolName[])
    .filter((name) => {
      const perm = TOOL_PERMISSION[name];
      return perm === null || user.permissions.includes(perm);
    })
    .map((name) => TOOL_SPECS[name]);
  return [
    ...core,
    ...analyticsToolsForUser(user),
    ...reportingToolsForUser(user),
    ...ragToolsForUser(user),
    ...mailToolsForUser(user),
    ...hrFormToolsForUser(user),
  ];
}

type LineItem = {
  name: string; sku?: string; description?: string;
  quantity: number; unit?: string; unit_price: number; item_id?: number;
};

/** Execute one tool call. Always returns a ToolResult — never throws. */
export async function executeTool(name: string, args: unknown, user: AuthUser): Promise<ToolResult> {
  user = entitledUser(user);
  const a = (args ?? {}) as Record<string, unknown>;

  // Permission guard (defence-in-depth — the LLM only receives allowed tools)
  const perm = TOOL_PERMISSION[name as ToolName];
  if (perm !== null && perm !== undefined && !user.permissions.includes(perm)) {
    return { success: false, error: 'Permission denied.' };
  }

  try {
    switch (name as ToolName) {

      // ── Utility ────────────────────────────────────────────────────────────
      case 'get_departments':
        return { success: true, data: queryAll('SELECT id, name FROM departments ORDER BY name') };

      // ── Inventory ──────────────────────────────────────────────────────────
      case 'search_inventory': {
        const where: string[] = [];
        const p: unknown[] = [];
        if (a.query) {
          where.push('(i.name LIKE ? OR i.sku LIKE ? OR i.category LIKE ? OR i.location LIKE ?)');
          const like = `%${a.query}%`;
          p.push(like, like, like, like);
        }
        if (a.department_id) { where.push('i.department_id = ?'); p.push(Number(a.department_id)); }
        if (a.category) { where.push('i.category = ?'); p.push(a.category); }
        if (a.low_stock_only) { where.push('i.quantity <= i.min_quantity'); }
        const sql =
          `SELECT i.id, i.name, i.sku, i.category, i.quantity, i.unit, i.min_quantity,
                  i.location, d.name AS department_name,
                  (i.quantity <= i.min_quantity) AS low_stock
           FROM inventory_items i
           LEFT JOIN departments d ON d.id = i.department_id` +
          (where.length ? ' WHERE ' + where.join(' AND ') : '') +
          ' ORDER BY i.name COLLATE NOCASE LIMIT 50';
        return { success: true, data: queryAll(sql, ...p) };
      }

      case 'get_inventory_item': {
        const item = queryOne<Record<string, unknown>>(
          `SELECT i.*, d.name AS department_name, (i.quantity <= i.min_quantity) AS low_stock
           FROM inventory_items i
           LEFT JOIN departments d ON d.id = i.department_id
           WHERE i.id = ?`,
          a.id,
        );
        if (!item) return { success: false, error: 'Item not found.' };
        try {
          if (typeof item.attributes === 'string' && item.attributes)
            item.attributes = JSON.parse(item.attributes as string);
        } catch { item.attributes = {}; }
        const history = queryAll(
          `SELECT t.id, t.change, t.balance_after, t.reason, t.created_at, u.full_name AS user_name
           FROM inventory_transactions t
           LEFT JOIN users u ON u.id = t.user_id
           WHERE t.item_id = ? ORDER BY t.created_at DESC LIMIT 20`,
          a.id,
        );
        return { success: true, data: { ...item, history } };
      }

      case 'get_inventory_stats': {
        const totals = queryOne<{ total_items: number; total_quantity: number; low_stock_count: number; category_count: number }>(
          `SELECT COUNT(*) AS total_items, COALESCE(SUM(quantity),0) AS total_quantity,
                  SUM(quantity <= min_quantity) AS low_stock_count,
                  COUNT(DISTINCT category) AS category_count
           FROM inventory_items`,
        );
        const cats = queryAll<{ category: string; count: number }>(
          `SELECT category, COUNT(*) AS count FROM inventory_items WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC LIMIT 10`,
        );
        return { success: true, data: { ...totals, top_categories: cats } };
      }

      case 'create_inventory_item': {
        const input = parseBody(createItemSchema, a);
        if (input.sku) {
          const dupe = queryOne('SELECT id FROM inventory_items WHERE sku = ?', input.sku);
          if (dupe) return { success: false, error: 'An item with that SKU already exists.' };
        }
        let newId: number | bigint;
        db.exec('BEGIN');
        try {
          const r = run(
            `INSERT INTO inventory_items (name, sku, category, department_id, supplier_id, quantity, unit, min_quantity, location, notes, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, datetime('now'))`,
            input.name, input.sku ?? null, input.category ?? null, input.department_id ?? null,
            input.supplier_id ?? null, input.unit ?? 'pcs', input.min_quantity, input.location ?? null, input.notes ?? null,
          );
          newId = r.lastInsertRowid;
          if (input.quantity !== 0) {
            applyStockChange({
              itemId: Number(newId),
              locationId: input.location_id ?? getDefaultLocationId(),
              change: input.quantity,
              reason: 'Initial stock',
              userId: user.id,
            });
          }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        return { success: true, data: queryOne('SELECT * FROM inventory_items WHERE id = ?', newId) };
      }

      case 'update_inventory_item': {
        if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', a.id))
          return { success: false, error: 'Item not found.' };
        const input = parseBody(updateItemSchema, a);
        if (input.sku !== undefined && input.sku !== null) {
          const dupe = queryOne('SELECT id FROM inventory_items WHERE sku = ? AND id != ?', input.sku, a.id);
          if (dupe) return { success: false, error: 'Another item already uses that SKU.' };
        }
        const cols: string[] = ["updated_at = datetime('now')"];
        const vals: unknown[] = [];
        const map: Record<string, unknown> = {
          name: input.name, sku: input.sku, category: input.category, department_id: input.department_id,
          unit: input.unit, min_quantity: input.min_quantity, location: input.location, notes: input.notes,
        };
        for (const [k, v] of Object.entries(map)) {
          if (v !== undefined) { cols.push(`${k} = ?`); vals.push(v ?? null); }
        }
        run(`UPDATE inventory_items SET ${cols.join(', ')} WHERE id = ?`, ...vals, a.id);
        return { success: true, data: queryOne('SELECT * FROM inventory_items WHERE id = ?', a.id) };
      }

      case 'adjust_stock': {
        const change = Number(a.change);
        if (change === 0) return { success: false, error: 'Change must be non-zero.' };
        const item = queryOne<{ quantity: number }>('SELECT quantity FROM inventory_items WHERE id = ?', a.id);
        if (!item) return { success: false, error: 'Item not found.' };
        const locId = a.location_id ? Number(a.location_id) : getDefaultLocationId();
        if (!queryOne('SELECT id FROM locations WHERE id = ?', locId)) {
          return { success: false, error: 'Location not found.' };
        }
        const atLoc = stockAt(Number(a.id), locId);
        if (atLoc + change < 0) {
          return { success: false, error: `Not enough stock at that location. Only ${atLoc} available.` };
        }
        db.exec('BEGIN');
        let result;
        try {
          result = applyStockChange({
            itemId: Number(a.id), locationId: locId, change,
            reason: typeof a.reason === 'string' ? a.reason : null, userId: user.id,
          });
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        return {
          success: true,
          data: { item_id: a.id, change, new_quantity: result.total, location_quantity: result.locationQty },
        };
      }

      case 'delete_inventory_item': {
        const item = queryOne<{ name: string }>('SELECT name FROM inventory_items WHERE id = ?', a.id);
        if (!item) return { success: false, error: 'Item not found.' };
        run('DELETE FROM inventory_items WHERE id = ?', a.id);
        return { success: true, data: { deleted: true, name: item.name } };
      }

      // ── Orders ─────────────────────────────────────────────────────────────
      case 'search_orders': {
        const where: string[] = [];
        const p: unknown[] = [];
        const types = visibleOrderTypes(user); // purchase orders need purchasing.view (order-access.ts)
        if (a.type && !types.includes(a.type as never)) return { success: false, error: 'Permission denied.' };
        if (a.type) { where.push('o.type = ?'); p.push(a.type); }
        else { where.push(`o.type IN (${types.map(() => '?').join(', ')})`); p.push(...types); }
        if (a.query) {
          where.push('(o.number LIKE ? OR o.customer_name LIKE ?)');
          const like = `%${a.query}%`;
          p.push(like, like);
        }
        const sql =
          `SELECT o.id, o.type, o.number, o.customer_name, o.order_date, o.status,
                  o.currency, o.total, o.created_at, u.full_name AS created_by_name
           FROM orders o LEFT JOIN users u ON u.id = o.created_by` +
          (where.length ? ' WHERE ' + where.join(' AND ') : '') +
          ' ORDER BY o.created_at DESC LIMIT 30';
        return { success: true, data: queryAll(sql, ...p) };
      }

      case 'get_order': {
        const order = queryOne(
          `SELECT o.*, u.full_name AS created_by_name FROM orders o
           LEFT JOIN users u ON u.id = o.created_by WHERE o.id = ?`,
          a.id,
        );
        if (!order) return { success: false, error: 'Order not found.' };
        if (!canOnOrder(user, (order as { type: string }).type, 'view')) return { success: false, error: 'Permission denied.' };
        const items = queryAll('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort', a.id);
        return { success: true, data: { ...order, items } };
      }

      case 'create_order': {
        const type = String(a.type ?? 'sale');
        if (type !== 'sale' && type !== 'job' && type !== 'purchase')
          return { success: false, error: "type must be 'sale', 'job', or 'purchase'." };
        if (!canOnOrder(user, type, 'create')) return { success: false, error: 'Permission denied.' };
        const seqKey = `order_seq_${type}`;
        const next = ((getSetting<number>(seqKey) ?? 0) + 1);
        setSetting(seqKey, next);
        const prefix = type === 'sale' ? 'SO' : type === 'job' ? 'JO' : 'PR';
        const orderNum = `${prefix}-${String(next).padStart(5, '0')}`;
        const lineItems = (a.items as LineItem[]) ?? [];
        const subtotal = lineItems.reduce((s, i) => s + i.quantity * i.unit_price, 0);
        const taxPct = Number(a.tax_percent ?? 0);
        const taxAmt = subtotal * (taxPct / 100);
        const total = subtotal + taxAmt;
        db.exec('BEGIN');
        try {
          const r = run(
            `INSERT INTO orders (type, number, customer_name, customer_contact, order_date, status, notes, currency, subtotal, tax_percent, tax_amount, total, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            type, orderNum, a.customer_name ?? null, a.customer_contact ?? null,
            a.order_date ?? null, a.status ?? 'open', a.notes ?? null, a.currency ?? 'PHP',
            subtotal, taxPct, taxAmt, total, user.id,
          );
          lineItems.forEach((item, idx) => {
            run(
              `INSERT INTO order_items (order_id, item_id, name, sku, description, quantity, unit, unit_price, line_total, sort)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              r.lastInsertRowid, item.item_id ?? null, item.name, item.sku ?? null,
              item.description ?? null, item.quantity, item.unit ?? null,
              item.unit_price, item.quantity * item.unit_price, idx,
            );
          });
          db.exec('COMMIT');
          return { success: true, data: { id: Number(r.lastInsertRowid), number: orderNum, total, type } };
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      }

      case 'update_order': {
        const existingOrder = queryOne<{ type: string }>('SELECT type FROM orders WHERE id = ?', a.id);
        if (!existingOrder) return { success: false, error: 'Order not found.' };
        if (!canOnOrder(user, existingOrder.type, 'edit')) return { success: false, error: 'Permission denied.' };
        const lineItems = (a.items as LineItem[]) ?? [];
        const subtotal = lineItems.reduce((s, i) => s + i.quantity * i.unit_price, 0);
        const taxPct = Number(a.tax_percent ?? 0);
        const taxAmt = subtotal * (taxPct / 100);
        const total = subtotal + taxAmt;
        db.exec('BEGIN');
        try {
          run(
            `UPDATE orders SET customer_name=?, customer_contact=?, order_date=?, status=?, notes=?,
             currency=?, subtotal=?, tax_percent=?, tax_amount=?, total=?, updated_at=datetime('now')
             WHERE id=?`,
            a.customer_name ?? null, a.customer_contact ?? null, a.order_date ?? null,
            a.status ?? 'open', a.notes ?? null, a.currency ?? 'PHP',
            subtotal, taxPct, taxAmt, total, a.id,
          );
          run('DELETE FROM order_items WHERE order_id = ?', a.id);
          lineItems.forEach((item, idx) => {
            run(
              `INSERT INTO order_items (order_id, item_id, name, sku, description, quantity, unit, unit_price, line_total, sort)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              a.id, item.item_id ?? null, item.name, item.sku ?? null,
              item.description ?? null, item.quantity, item.unit ?? null,
              item.unit_price, item.quantity * item.unit_price, idx,
            );
          });
          db.exec('COMMIT');
          return { success: true, data: { id: a.id, total } };
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      }

      case 'delete_order': {
        const order = queryOne<{ number: string; type: string }>('SELECT number, type FROM orders WHERE id = ?', a.id);
        if (!order) return { success: false, error: 'Order not found.' };
        if (!canOnOrder(user, order.type, 'delete')) return { success: false, error: 'Permission denied.' };
        run('DELETE FROM orders WHERE id = ?', a.id);
        return { success: true, data: { deleted: true, number: order.number } };
      }

      // ── Messages ───────────────────────────────────────────────────────────
      case 'get_messages': {
        const box = a.box === 'sent' ? 'sent' : 'inbox';
        // deleted_at IS NULL: skip sender-unsent messages, which are cleared to an empty
        // body (see DELETE /api/messages/:id) and would otherwise read as blank content.
        const sql = box === 'inbox'
          ? `SELECT m.id, m.subject, m.body, m.read_at, m.created_at,
                    u.id AS sender_id, u.full_name AS sender_name
             FROM messages m JOIN users u ON u.id = m.sender_id
             WHERE m.recipient_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 20`
          : `SELECT m.id, m.subject, m.body, m.created_at,
                    u.id AS recipient_id, u.full_name AS recipient_name
             FROM messages m JOIN users u ON u.id = m.recipient_id
             WHERE m.sender_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 20`;
        return { success: true, data: queryAll(sql, user.id) };
      }

      case 'send_message': {
        if (Number(a.recipient_id) === user.id)
          return { success: false, error: 'Cannot send a message to yourself.' };
        const recipient = queryOne<{ full_name: string }>(
          'SELECT full_name FROM users WHERE id = ? AND active = 1', a.recipient_id,
        );
        if (!recipient) return { success: false, error: 'Recipient not found or inactive.' };
        const r = run(
          'INSERT INTO messages (sender_id, recipient_id, subject, body) VALUES (?, ?, ?, ?)',
          user.id, a.recipient_id, a.subject ?? null, a.body,
        );
        return { success: true, data: { id: Number(r.lastInsertRowid), sent_to: recipient.full_name } };
      }

      case 'get_unread_count': {
        const row = queryOne<{ count: number }>(
          'SELECT COUNT(*) AS count FROM messages WHERE recipient_id = ? AND read_at IS NULL', user.id,
        );
        return { success: true, data: { unread: row?.count ?? 0 } };
      }

      case 'mark_message_read': {
        const msg = queryOne<{ recipient_id: number }>(
          'SELECT recipient_id FROM messages WHERE id = ?', a.id,
        );
        if (!msg) return { success: false, error: 'Message not found.' };
        if (msg.recipient_id !== user.id) return { success: false, error: 'Not your message.' };
        run("UPDATE messages SET read_at = datetime('now') WHERE id = ?", a.id);
        return { success: true, data: { marked_read: true } };
      }

      // ── Forms ──────────────────────────────────────────────────────────────
      case 'get_forms': {
        // Same visibility rule as GET /api/forms (users.manage sees every form, not just
        // shared + own-department) — this used to be hand-rolled here without that bypass.
        const vis = visibilityClause(user);
        const p: unknown[] = [...vis.params];
        let where = vis.sql; // '' or ' WHERE (...)'
        if (a.category) {
          where += where ? ' AND f.category = ?' : ' WHERE f.category = ?';
          p.push(a.category);
        }
        const sql =
          `SELECT f.id, f.title, f.description, f.category, f.original_name,
                  f.mime_type, f.size_bytes, f.created_at, d.name AS department_name
           FROM forms f LEFT JOIN departments d ON d.id = f.department_id
           ${where} ORDER BY f.title COLLATE NOCASE`;
        return { success: true, data: queryAll(sql, ...p) };
      }

      // ── Users ──────────────────────────────────────────────────────────────
      case 'list_users': {
        const where: string[] = [];
        const p: unknown[] = [];
        if (a.department_id) { where.push('u.department_id = ?'); p.push(Number(a.department_id)); }
        if (a.active_only) { where.push('u.active = 1'); }
        const sql =
          `SELECT u.id, u.username, u.full_name, u.role, u.active, u.created_at,
                  d.name AS department_name
           FROM users u LEFT JOIN departments d ON d.id = u.department_id` +
          (where.length ? ' WHERE ' + where.join(' AND ') : '') +
          ' ORDER BY u.full_name COLLATE NOCASE';
        return { success: true, data: queryAll(sql, ...p) };
      }

      case 'create_user': {
        const input = parseBody(createUserSchema, a);
        if (!getRole(input.role)) return { success: false, error: `Unknown role "${input.role}".` };
        const exists = queryOne('SELECT id FROM users WHERE username = ?', input.username);
        if (exists) return { success: false, error: 'Username already taken.' };
        const { hashSync } = await import('bcryptjs');
        const hash = hashSync(input.password, 10);
        const r = run(
          'INSERT INTO users (username, full_name, password_hash, role, department_id) VALUES (?, ?, ?, ?, ?)',
          input.username, input.full_name, hash, input.role, input.department_id,
        );
        return { success: true, data: { id: Number(r.lastInsertRowid), username: input.username } };
      }

      case 'update_user': {
        const existing = queryOne<{ role: string; active: number }>('SELECT role, active FROM users WHERE id = ?', a.id);
        if (!existing) return { success: false, error: 'User not found.' };
        const input = parseBody(updateUserSchema, a);
        if (input.role !== undefined && !getRole(input.role)) return { success: false, error: `Unknown role "${input.role}".` };
        const role = input.role ?? existing.role;
        const active = input.active !== undefined ? (input.active ? 1 : 0) : existing.active;

        // Never strip the last active administrator (mirrors PUT /users/:id in users.routes.ts).
        const demoting = existing.role === 'admin' && role !== 'admin';
        const disabling = existing.role === 'admin' && existing.active === 1 && active === 0;
        if (demoting || disabling) {
          const otherAdmins = queryOne<{ c: number }>(
            "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
            a.id,
          )!.c;
          if (otherAdmins === 0) return { success: false, error: 'Cannot remove the last active administrator.' };
        }

        const cols: string[] = [];
        const vals: unknown[] = [];
        if (input.full_name !== undefined) { cols.push('full_name = ?'); vals.push(input.full_name); }
        if (input.role !== undefined) { cols.push('role = ?'); vals.push(input.role); }
        if (input.department_id !== undefined) { cols.push('department_id = ?'); vals.push(input.department_id ?? null); }
        if (input.active !== undefined) { cols.push('active = ?'); vals.push(active); }
        if (!cols.length) return { success: false, error: 'Nothing to update.' };
        run(`UPDATE users SET ${cols.join(', ')} WHERE id = ?`, ...vals, a.id);
        if (active === 0) endUserSessions(Number(a.id), 'deactivated');
        return { success: true, data: { updated: true } };
      }

      // ── Notes ──────────────────────────────────────────────────────────────
      case 'get_notes':
        return { success: true, data: queryAll('SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC', user.id) };

      case 'create_note': {
        const r = run('INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)', user.id, a.title ?? null, a.body);
        return { success: true, data: { id: Number(r.lastInsertRowid) } };
      }

      case 'update_note': {
        const note = queryOne<{ user_id: number }>('SELECT user_id FROM notes WHERE id = ?', a.id);
        if (!note) return { success: false, error: 'Note not found.' };
        if (note.user_id !== user.id) return { success: false, error: 'Not your note.' };
        const cols: string[] = ["updated_at = datetime('now')"];
        const vals: unknown[] = [];
        if (a.title !== undefined) { cols.push('title = ?'); vals.push(a.title ?? null); }
        if (a.body !== undefined) { cols.push('body = ?'); vals.push(a.body); }
        run(`UPDATE notes SET ${cols.join(', ')} WHERE id = ?`, ...vals, a.id);
        return { success: true, data: { updated: true } };
      }

      case 'delete_note': {
        const note = queryOne<{ user_id: number }>('SELECT user_id FROM notes WHERE id = ?', a.id);
        if (!note) return { success: false, error: 'Note not found.' };
        if (note.user_id !== user.id) return { success: false, error: 'Not your note.' };
        run('DELETE FROM notes WHERE id = ?', a.id);
        return { success: true, data: { deleted: true } };
      }

      // ── Tasks ──────────────────────────────────────────────────────────────
      case 'get_tasks':
        return { success: true, data: queryAll('SELECT * FROM tasks WHERE user_id = ? ORDER BY done, due_date NULLS LAST, created_at DESC', user.id) };

      case 'create_task': {
        const r = run('INSERT INTO tasks (user_id, title, due_date) VALUES (?, ?, ?)', user.id, a.title, a.due_date ?? null);
        return { success: true, data: { id: Number(r.lastInsertRowid) } };
      }

      case 'update_task': {
        const task = queryOne<{ user_id: number }>('SELECT user_id FROM tasks WHERE id = ?', a.id);
        if (!task) return { success: false, error: 'Task not found.' };
        if (task.user_id !== user.id) return { success: false, error: 'Not your task.' };
        const cols: string[] = [];
        const vals: unknown[] = [];
        if (a.title !== undefined) { cols.push('title = ?'); vals.push(a.title); }
        if (a.due_date !== undefined) { cols.push('due_date = ?'); vals.push(a.due_date ?? null); }
        if (a.done !== undefined) { cols.push('done = ?'); vals.push(a.done ? 1 : 0); }
        if (!cols.length) return { success: false, error: 'Nothing to update.' };
        run(`UPDATE tasks SET ${cols.join(', ')} WHERE id = ?`, ...vals, a.id);
        return { success: true, data: { updated: true } };
      }

      case 'delete_task': {
        const task = queryOne<{ user_id: number }>('SELECT user_id FROM tasks WHERE id = ?', a.id);
        if (!task) return { success: false, error: 'Task not found.' };
        if (task.user_id !== user.id) return { success: false, error: 'Not your task.' };
        run('DELETE FROM tasks WHERE id = ?', a.id);
        return { success: true, data: { deleted: true } };
      }

      default:
        if (isAnalyticsTool(name)) return executeAnalyticsTool(name, a, user);
        if (isReportingTool(name)) return await executeReportingTool(name, a, user);
        if (isRagTool(name)) return executeRagTool(name, a, user);
        if (isMailTool(name)) return await executeMailTool(name, a, user);
        if (isHrFormTool(name)) return executeHrFormTool(name, a, user);
        return { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
