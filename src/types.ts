/**
 * Central domain types shared across the backend.
 * These mirror the database schema in src/db.ts and the JSON shapes the API returns.
 */

export type Role =
  | 'admin' | 'admin_staff' | 'accounting' | 'warehouse'
  | 'releasing' | 'csr' | 'hr' | 'marketing';

export type Permission =
  | 'inventory.view' | 'inventory.create' | 'inventory.edit' | 'inventory.delete'
  | 'inventory.adjust' | 'inventory.configure'
  | 'orders.view' | 'orders.create' | 'orders.edit' | 'orders.delete'
  | 'forms.view' | 'forms.upload' | 'forms.delete' | 'forms.manage'
  | 'messages.view' | 'messages.send'
  | 'templates.view' | 'templates.edit' | 'templates.company'
  | 'users.manage';

export interface Department {
  id: number;
  name: string;
  created_at: string;
}

export interface UserRow {
  id: number;
  username: string;
  full_name: string;
  password_hash: string;
  role: Role;
  department_id: number | null;
  active: number; // 0 | 1
  created_at: string;
}

/** The authenticated user attached to requests (no password hash). */
export interface AuthUser {
  id: number;
  username: string;
  full_name: string;
  role: Role;
  department_id: number | null;
  active: number;
  department_name: string | null;
  permissions: Permission[];
}

export interface SessionRow {
  token: string;
  user_id: number;
  created_at: string;
  expires_at: string;
}

export interface InventoryItem {
  id: number;
  name: string;
  sku: string | null;
  category: string | null;
  department_id: number | null;
  quantity: number;
  unit: string | null;
  min_quantity: number;
  location: string | null;
  notes: string | null;
  /** Raw JSON string in the DB row; parsed to an object in API responses. */
  attributes: string | Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  department_name?: string | null;
  low_stock?: number;
}

export interface InventoryTransaction {
  id: number;
  item_id: number;
  user_id: number | null;
  change: number;
  balance_after: number;
  reason: string | null;
  created_at: string;
  user_name?: string | null;
}

export interface FormRow {
  id: number;
  title: string;
  description: string | null;
  category: string | null;
  stored_name: string;
  original_name: string;
  mime_type: string | null;
  size_bytes: number;
  department_id: number | null;
  uploaded_by: number | null;
  created_at: string;
}

export interface MessageRow {
  id: number;
  sender_id: number;
  recipient_id: number;
  subject: string | null;
  body: string;
  read_at: string | null;
  created_at: string;
}

export interface Note {
  id: number;
  user_id: number;
  title: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: number;
  user_id: number;
  title: string;
  due_date: string | null;
  done: number; // 0 | 1
  created_at: string;
}

export interface Bookmark {
  id: number;
  user_id: number;
  label: string;
  route: string;
  params: string | null;
  created_at: string;
}

export type OrderType = 'sale' | 'job' | 'purchase';

export interface Order {
  id: number;
  type: OrderType;
  number: string;
  customer_name: string | null;
  customer_contact: string | null;
  order_date: string | null;
  status: string;
  notes: string | null;
  currency: string;
  subtotal: number;
  tax_percent: number;
  tax_amount: number;
  total: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  created_by_name?: string | null;
  items?: OrderItem[];
}

export interface OrderItem {
  id: number;
  order_id: number;
  item_id: number | null;
  name: string;
  sku: string | null;
  description: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
  line_total: number;
  sort: number;
}

export interface DocTemplate {
  id: number;
  name: string;
  type: 'sale' | 'job' | 'purchase' | 'generic';
  body: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

/** One field definition stored in form_definitions.fields (JSON array). */
export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'textarea' | 'checkbox';
  required: boolean;
  options: string[];  // only for type = 'select'
  default: string;
}

/** A custom form type created by an admin. */
export interface FormDefinition {
  id: number;
  name: string;
  slug: string;
  number_prefix: string;
  icon: string;
  fields: string | FieldDef[];  // raw JSON string in DB; parsed array in API responses
  created_by: number | null;
  created_at: string;
  updated_at: string | null;
  record_count?: number;
}

/** A submitted record for a custom form. */
export interface FormRecord {
  id: number;
  form_def_id: number;
  number: string;
  data: string | Record<string, unknown>;  // raw JSON string in DB; parsed in API responses
  status: string;
  created_by: number | null;
  created_at: string;
  updated_at: string | null;
  created_by_name?: string | null;
  form_name?: string;
}

/** A global variable injectable into any template as {{global.key}}. */
export interface GlobalVariable {
  key: string;
  label: string;
  value: string;
  updated_by: number | null;
  updated_at: string;
}

export interface CompanyProfile {
  name: string;
  address: string;
  phone: string;
  email: string;
  logo_url: string;
}

/** A document-template variable (registry row). */
export interface DocVariable {
  id: number;
  scope: 'global' | 'template';
  template_id: number | null;
  category: string;
  key: string;
  label: string;
  source_type: 'constant' | 'field' | 'formula';
  value: string | null;
  field_path: string | null;
  formula: string | null;
  data_type: 'text' | 'number' | 'currency' | 'date';
  sort: number;
  created_at: string;
  updated_at: string;
}

/** One bindable field in the data-source catalog. */
export interface CatalogEntry { path: string; label: string; }
export interface CatalogGroup { group: string; items: CatalogEntry[]; }

/** Augment Express so handlers can read req.user / req.token with types. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      token?: string;
    }
  }
}
