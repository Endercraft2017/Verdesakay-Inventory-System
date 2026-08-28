/**
 * Central domain types shared across the backend.
 * These mirror the database schema in src/db.ts and the JSON shapes the API returns.
 */

export type Role =
  | 'admin' | 'admin_staff' | 'accounting' | 'warehouse'
  | 'releasing' | 'csr' | 'hr' | 'marketing';

export type Permission =
  | 'inventory.view' | 'inventory.create' | 'inventory.edit' | 'inventory.delete'
  | 'inventory.adjust' | 'inventory.configure' | 'inventory.mobile'
  | 'orders.view' | 'orders.create' | 'orders.edit' | 'orders.delete'
  | 'forms.view' | 'forms.upload' | 'forms.delete'
  | 'forms.manage.hr' | 'forms.manage.inventory' | 'forms.manage.admin' | 'forms.manage.accounting'
  | 'messages.view' | 'messages.send'
  | 'templates.view' | 'templates.edit' | 'templates.company'
  | 'users.manage'
  | 'hr.view' | 'hr.manage'
  | 'audit.view';

/** Which section a Form Builder form belongs to — drives per-section access control
    (see `forms.manage.*` permissions) and where it's organized in the nav/Data Forms.
    `null` (not part of this union) means "General" — an unowned, admin-only bucket. */
export type FormScope = 'hr' | 'inventory' | 'admin' | 'accounting';

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

export interface Supplier {
  id: number;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** Joined in by GET /api/suppliers (count of items pointing at this supplier). */
  item_count?: number;
}

export interface LocationRow {
  id: number;
  name: string;
  type: string;
  address: string | null;
  notes: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
  /** Joined in by GET /api/locations. */
  total_units?: number;
  item_count?: number;
}

export interface InventoryStockRow {
  id: number;
  item_id: number;
  location_id: number;
  quantity: number;
}

export interface InventoryItem {
  id: number;
  name: string;
  sku: string | null;
  category: string | null;
  department_id: number | null;
  supplier_id: number | null;
  quantity: number;
  unit: string | null;
  min_quantity: number;
  location: string | null;
  notes: string | null;
  /** Raw JSON string in the DB row; parsed to an object in API responses. */
  attributes: string | Record<string, unknown> | null;
  /** Stored filename under UPLOAD_DIR; served by GET /api/inventory/:id/image. */
  image_path: string | null;
  /** 1 ⇒ this item is a built product with a BOM (bom_components). */
  is_finished_product: number;
  created_at: string;
  updated_at: string;
  department_name?: string | null;
  supplier_name?: string | null;
  low_stock?: number;
}

export interface BomComponent {
  id: number;
  product_item_id: number;
  component_item_id: number;
  quantity: number;
  notes: string | null;
  sort: number;
  /** Joined for API responses. */
  component_name?: string;
  component_sku?: string | null;
  component_unit?: string | null;
  /** Current on-hand grand total of the component. */
  component_on_hand?: number;
}

export type JobOrderStatus = 'draft' | 'released' | 'in_progress' | 'paused' | 'completed' | 'cancelled';

export interface JobOrder {
  id: number;
  number: string;
  order_id: number | null;
  product_item_id: number | null;
  product_name: string;
  qty_ordered: number;
  qty_done: number;
  qty_scrapped: number;
  status: JobOrderStatus;
  source_location_id: number | null;
  output_location_id: number | null;
  qc_stages: number;
  notes: string | null;
  created_by: number | null;
  released_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  created_by_name?: string | null;
  order_number?: string | null;
  source_location_name?: string | null;
  output_location_name?: string | null;
  components?: JobOrderComponent[];
}

export interface JobOrderComponent {
  id: number;
  job_order_id: number;
  component_item_id: number | null;
  component_name: string;
  qty_per_unit: number;
  qty_planned: number;
  qty_consumed: number;
  /** Joined: the component's current grand total on hand. */
  component_on_hand?: number;
}

export type JobOrderUnitStatus = 'pending' | 'in_stock' | 'failed' | 'scrapped';

export interface JobOrderUnit {
  id: number;
  job_order_id: number;
  product_item_id: number | null;
  identifier: string | null;
  status: JobOrderUnitStatus;
  /** Number of inspection stages this unit has passed so far. */
  stage: number;
  location_id: number | null;
  remarks: string | null;
  created_at: string;
  updated_at: string;
}

export interface QcRecord {
  id: number;
  job_order_id: number;
  unit_id: number | null;
  /** 1 = QA, 2 = QC. */
  stage: number;
  result: 'pass' | 'fail';
  remarks: string | null;
  inspector_id: number | null;
  created_at: string;
  inspector_name?: string | null;
  unit_identifier?: string | null;
}

export interface InventoryTransaction {
  id: number;
  item_id: number;
  user_id: number | null;
  change: number;
  balance_after: number;
  reason: string | null;
  location_id: number | null;
  location_balance_after: number | null;
  created_at: string;
  user_name?: string | null;
  /** Joined in by GET /api/inventory/movements (the cross-item feed). */
  item_name?: string;
  item_sku?: string | null;
  location_name?: string | null;
}

export interface ActivityLogRow {
  id: number;
  created_at: string;
  user_id: number | null;
  /** Snapshot of the actor's name at the time — survives user deletion. */
  user_name: string | null;
  method: string;
  path: string;
  entity: string | null;
  entity_id: string | null;
  action: string | null;
  status_code: number | null;
  ip: string | null;
  summary: string | null;
  /** Redacted JSON snapshot of the request body (string in the row). */
  meta: string | null;
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
  period: string | null;
  body: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export type EmployeeStatus = 'probationary' | 'regular' | 'resigned' | 'terminated';

export interface Employee {
  id: number;
  employee_no: string | null;
  name: string;
  department_id: number | null;
  position: string | null;
  daily_rate: number; // always the effective daily rate, regardless of rate_type — payroll math reads only this
  rate_type: 'daily' | 'monthly';
  monthly_rate: number | null; // set when rate_type === 'monthly'; daily_rate is derived from this
  status: EmployeeStatus;
  start_date: string | null;
  sss_no: string | null;
  philhealth_no: string | null;
  pagibig_no: string | null;
  tin_no: string | null;
  photo: string | null; // data: URI
  created_at: string;
  department_name?: string | null;
  default_shift_id: number | null; // usual shift — a UI pre-fill only, never enforced
  user_id: number | null; // linked login account, 1:1 (enforced by a partial unique index)
  linked_username?: string | null;
  linked_full_name?: string | null;
}

/** Company-wide format for the RECOMMENDED employee number (settings key "employee_no_policy") —
    employee_no itself is a freely editable text field, this only shapes the suggestion offered
    when adding a new employee. 'sequential' recommends {prefix}-{running count + 1}; 'hire_date'
    recommends {prefix}{hire date}-{suffix count of employees already numbered for that date + 1},
    so multiple same-day hires get distinct suffixes. */
export interface EmployeeNumberPolicy {
  prefix: string;
  mode: 'sequential' | 'hire_date';
  pad: number; // zero-padding width of the incrementing part
  date_format: 'YYYYMMDD' | 'YYMMDD'; // only used in 'hire_date' mode
}

/** A named shift (e.g. "Morning 06:00-14:00") — attendance days reference one by id so a
    rotating employee just gets a different shift_id on different days. */
export interface Shift {
  id: number;
  name: string;
  start_time: string; // "HH:MM"
  end_time: string;   // "HH:MM"
  is_default: boolean;
}

/** Company-wide payroll computation rules (settings key "payroll_policy") — how lateness/OT are
    computed, as opposed to *when* a shift runs (that's per-Shift). Rounding is always "round up"
    (against the employee for lateness, in their favor for OT) — not itself configurable. */
export interface PayrollPolicy {
  grace_minutes: number;
  late_unit: 'minute' | 'hour';
  ot_unit: 'minute' | '30min' | 'hour';
  ot_rate_percent: number;
  night_diff_enabled: boolean;
  night_diff_percent: number;
  night_start: string; // "HH:MM"
  night_end: string;   // "HH:MM", wraps midnight if < night_start
  monthly_rate_divisor: number; // effective daily_rate = monthly_rate / this, e.g. 26
}

export interface EmployeeDocument {
  id: number;
  employee_id: number;
  title: string;
  stored_name: string;
  original_name: string;
  mime_type: string | null;
  size_bytes: number;
  uploaded_by: number | null;
  created_at: string;
  uploaded_by_name?: string | null;
}

export interface AttendancePeriod {
  id: number;
  label: string;
  start_date: string;
  end_date: string;
  created_by: number | null;
  created_at: string;
  employee_count?: number;
}

export interface AttendanceRecord {
  id: number;
  period_id: number;
  employee_id: number;
  work_date: string;
  time_in: string | null;
  time_out: string | null;
  notes: string | null;
  shift_id: number | null;
  form_record_id: number | null;
  updated_at: string;
}

/** One field definition stored in form_definitions.fields (JSON array). */
export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'textarea' | 'checkbox' | 'employee';
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
  template_id: number | null;   // linked doc_templates.id used to print this form's records
  scope: FormScope | null;      // which section owns this form; null = General (admin-only)
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
  period: string | null;
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
