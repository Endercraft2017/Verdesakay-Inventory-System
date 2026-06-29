/**
 * Central domain types shared across the backend.
 * These mirror the database schema in src/db.ts and the JSON shapes the API returns.
 */

export type Role = 'admin' | 'employee';

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

export type OrderType = 'sale' | 'job';

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
  type: 'sale' | 'job' | 'generic';
  body: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyProfile {
  name: string;
  address: string;
  phone: string;
  email: string;
  logo_url: string;
}

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
