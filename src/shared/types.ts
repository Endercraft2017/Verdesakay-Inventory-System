/**
 * Central domain types shared across the backend.
 * These mirror the database schema in src/db.ts and the JSON shapes the API returns.
 */

export type Role =
  | 'admin' | 'admin_staff' | 'accounting' | 'warehouse'
  | 'releasing' | 'csr' | 'hr' | 'marketing'
  // Narrow, single-task shop-floor roles — each holds only the one production
  // permission its person needs (see permissions.ts ROLE_DEFAULTS), on top of what
  // 'warehouse' already covers for general operations. Introduced so a parts-request
  // clerk, a line lead, a QC inspector, a QA inspector and a Products In clerk can each
  // get an account scoped to exactly their own task instead of sharing inventory.adjust.
  // QC and QA are deliberately separate roles/people, matching the pipeline's own
  // first-pass-QC-then-final-pass-QA distinction (docs/modules/pipelines.md).
  | 'parts_clerk' | 'production_lead' | 'qc_inspector' | 'qa_inspector' | 'receiving_clerk'
  // Same narrowing, orders module: a mobile-only account that just scans/enters goods out
  // against an approved sale order, without the broad inventory.adjust that also lets it
  // adjust arbitrary stock.
  | 'releasing_clerk';

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
  | 'accounting.view' | 'accounting.manage'
  | 'audit.view'
  | 'mail.send'
  | 'announce'
  | 'qc.configure'
  | 'delivery.run' | 'delivery.manage'
  // Narrow production-pipeline actions, each independently grantable alongside (or
  // instead of) the broad inventory.adjust — see job-orders.routes.ts / production.routes.ts
  // requireAnyPermission(['inventory.adjust', 'production.xxx']) call sites.
  | 'production.repairs'    // warehouse: accept/reject a rework parts request
  | 'production.record'     // line lead: record units/batches off the line
  | 'production.inspect_qc' // QC inspector: pass/fail a unit's first pass
  | 'production.inspect_qa' // QA inspector: pass/fail a unit's final pass
  | 'production.receive'    // Products In: receive passed output into stock
  // Same narrowing, orders module (orders.routes.ts requireAnyPermission(['inventory.adjust',
  // 'orders.release'])) — a releasing_clerk mobile account scoped to just scanning/entering
  // goods out against an approved sale order.
  | 'orders.release';

/** Which section a Form Builder form belongs to — drives per-section access control
    (see `forms.manage.*` permissions) and where it's organized in the nav/Data Forms.
    `null` (not part of this union) means "General" — an unowned, admin-only bucket. */
export type FormScope = 'hr' | 'inventory' | 'admin' | 'accounting';

export interface Department {
  id: number;
  name: string;
  head_user_id: number | null;
  created_at: string;
  /** Joined in by GET /api/users/departments. */
  head_name?: string | null;
}

/** A company-wide announcement (see src/routes/announcements.routes.ts). */
export interface Announcement {
  id: number;
  title: string;
  body: string;
  pinned: number; // 0 | 1
  expires_at: string | null;
  created_by: number | null;
  created_at: string;
  created_by_name?: string | null;
}

export type TimeCorrectionStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** An employee's request to fix a missed / wrong time punch. */
export interface TimeCorrection {
  id: number;
  employee_id: number;
  user_id: number | null;
  work_date: string;
  requested_in: string | null;
  requested_out: string | null;
  reason: string;
  status: TimeCorrectionStatus;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  employee_name?: string;
  department_id?: number | null;
}

export interface UserRow {
  id: number;
  username: string;
  full_name: string;
  email: string | null;
  password_hash: string;
  role: Role;
  department_id: number | null;
  active: number; // 0 | 1
  created_at: string;
  /** Sparse JSON diff against the role's default permissions — see resolvePermissions(). */
  permission_overrides: string;
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
  tin: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** Joined in by GET /api/suppliers (count of items pointing at this supplier). */
  item_count?: number;
}

export interface Customer {
  id: number;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  tin: string | null;
  payment_terms_days: number;
  notes: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  /** Joined in by GET /api/customers. */
  order_count?: number;
  open_balance?: number;
  /** GET /api/customers/:id attaches recent sale orders. */
  orders?: { id: number; number: string; order_date: string | null; status: string; total: number }[];
}

export interface Payment {
  id: number;
  number: string;
  direction: 'in' | 'out';
  party_type: 'customer' | 'supplier';
  party_id: number | null;
  party_name: string | null;
  payment_date: string;
  amount: number;
  method: string | null;
  reference: string | null;
  deposit_account_id: number | null;
  memo: string | null;
  status: 'posted' | 'void';
  created_by: number | null;
  created_at: string;
  allocations?: PaymentAllocation[];
  created_by_name?: string | null;
  deposit_account_name?: string | null;
}

export interface PaymentAllocation {
  id: number;
  payment_id: number;
  doc_type: 'sale_order' | 'vendor_bill';
  doc_id: number;
  amount: number;
  /** GET /api/accounting/payments/:id resolves the target document number. */
  doc_number?: string | null;
}

export interface TaxCode {
  id: number;
  code: string;
  name: string;
  kind: 'output_vat' | 'input_vat' | 'exempt' | 'zero_rated' | 'ewt';
  rate: number;
  account_id: number | null;
  atc: string | null;
  active: number;
  created_at: string;
  account_name?: string | null;
}

export interface CreditNote {
  id: number;
  number: string;
  kind: 'customer' | 'supplier';
  tax_code_id?: number | null;
  party_id: number | null;
  party_name: string | null;
  note_date: string;
  source_doc_type: 'sale_order' | 'vendor_bill' | null;
  source_doc_id: number | null;
  reason: string | null;
  subtotal: number;
  tax_amount: number;
  total: number;
  status: 'issued' | 'void';
  created_by: number | null;
  created_at: string;
  created_by_name?: string | null;
  source_doc_number?: string | null;
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
  /** Standard unit cost — values raw materials into WIP and finished goods out of it
   *  when a job order posts to the GL (ACCOUNTING-SYSTEM-PLAN Phase 3b). 0 until set. */
  unit_cost: number;
  location: string | null;
  notes: string | null;
  /** Raw JSON string in the DB row; parsed to an object in API responses. */
  attributes: string | Record<string, unknown> | null;
  /** Stored filename under UPLOAD_DIR; served by GET /api/inventory/:id/image. */
  image_path: string | null;
  /** 1 ⇒ this item is a built product with a BOM (bom_components). */
  is_finished_product: number;
  /** Finished products only: which QA/QC checklist applies at each stage (else that
   *  stage's default). */
  qc_checklist_qa_id: number | null;
  qc_checklist_qc_id: number | null;
  /** Plain-text grouping key shared by variants of the same base product (e.g. "Office
   *  Chair" for Red/Blue/Green rows, each its own full item with its own stock/SKU/BOM).
   *  The variant's own descriptor lives in the existing attributes.spec field, not here. */
  product_group: string | null;
  created_at: string;
  updated_at: string;
  department_name?: string | null;
  supplier_name?: string | null;
  low_stock?: number;
  qc_checklist_qa_name?: string | null;
  qc_checklist_qc_name?: string | null;
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
  released_by: number | null;
  /** Production lead's sign-off that the released parts kit arrived (POST /:id/accept). */
  accepted_by: number | null;
  accepted_at: string | null;
  accept_notes: string | null;
  /** Production team assigned to run this job order (nullable). */
  team_id: number | null;
  /** Scheduling — planned start / due date (YYYY-MM-DD), priority (higher = sooner),
   *  and a free-text work centre / line. */
  planned_start: string | null;
  due_date: string | null;
  priority: number;
  work_center: string | null;
  created_by_name?: string | null;
  released_by_name?: string | null;
  accepted_by_name?: string | null;
  team_name?: string | null;
  order_number?: string | null;
  source_location_name?: string | null;
  output_location_name?: string | null;
  components?: JobOrderComponent[];
  /** Resolved at load time: this MO's product's checklist for each stage (its own, else
   *  that stage's default, else null). */
  qc_checklist_qa?: { id: number; name: string; items: QcChecklistItem[] } | null;
  qc_checklist_qc?: { id: number; name: string; items: QcChecklistItem[] } | null;
}

/** One configurable QA/QC checklist line. */
export interface QcChecklistItem {
  label: string;
  required: boolean;
}

/** A named, reusable QC/QA checklist, belonging to one stage as a whole (stage: 1 = QC /
    first pass, 2 = QA / final pass). Finished products point at one per stage via
    `inventory_items.qc_checklist_qc_id` / `qc_checklist_qa_id`; the `is_default` row for
    that stage covers products with none. */
export interface QcChecklist {
  id: number;
  name: string;
  /** JSON string in the row; parsed to QcChecklistItem[] in API responses. */
  items: string | QcChecklistItem[];
  stage: 1 | 2;
  is_default: number; // 0 | 1
  created_by: number | null;
  created_at: string;
  updated_at: string;
  /** Joined into list responses. */
  item_count?: number;
}

/** What the inspector actually ticked for one check, snapshotted onto the qc_record. */
export interface QcChecklistResult {
  label: string;
  ok: boolean;
  note?: string | null;
}

/** A field delivery / drop with its proof of delivery. See src/routes/deliveries.routes.ts. */
export type DeliveryStatus = 'pending' | 'out_for_delivery' | 'delivered' | 'failed' | 'cancelled';
export interface Delivery {
  id: number;
  number: string;
  order_id: number | null;
  customer_name: string | null;
  address: string | null;
  contact_phone: string | null;
  scheduled_date: string | null;
  assigned_to: number | null;
  status: DeliveryStatus;
  notes: string | null;
  pod_recipient: string | null;
  pod_signature_attachment_id: number | null;
  pod_lat: number | null;
  pod_lng: number | null;
  pod_note: string | null;
  delivered_at: string | null;
  delivered_by: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  order_number?: string | null;
  assigned_to_name?: string | null;
  delivered_by_name?: string | null;
  item_count?: number;
  photo_count?: number;
}

/** A photo hung off another record (QC unit inspection, damage report, …).
    See src/routes/attachments.routes.ts. */
export interface Attachment {
  id: number;
  kind: 'qc_unit' | 'damage' | 'problem' | 'delivery' | 'signature';
  ref_id: number;
  image_path: string;
  caption: string | null;
  uploaded_by: number | null;
  created_at: string;
  uploaded_by_name?: string | null;
  /** Synthesised in list responses. */
  url?: string;
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

export type JobOrderUnitStatus =
  | 'pending'
  /** Passed its final QC stage but not yet posted to stock — see production_receipts /
   *  POST /job-orders/:id/products-in. Not sellable/reservable until it becomes 'in_stock'. */
  | 'passed'
  | 'in_stock' | 'failed' | 'scrapped' | 'sold' | 'rework'
  /** Earmarked for a sale order by a warehouse release; still physical on-hand stock
   *  until the order reaches a confirmed status and `maybeFulfillSale` draws it down. */
  | 'reserved';

/** What the inspector decided for a failed unit. `repair` sends it to rework; the
 *  others are terminal (the unit is counted as scrapped). */
export type UnitDisposition = 'scrap' | 'dispose' | 'recycle' | 'repair';

export interface JobOrderUnit {
  id: number;
  job_order_id: number;
  product_item_id: number | null;
  identifier: string | null;
  status: JobOrderUnitStatus;
  /** Number of inspection stages this unit has passed so far. */
  stage: number;
  location_id: number | null;
  /** Sales order that sold or relocated this unit (nullable). */
  order_id: number | null;
  /** Production batch this unit belongs to (nullable — serialized units may be loose). */
  batch_id: number | null;
  /** Set when the unit was failed (see UnitDisposition). */
  disposition: UnitDisposition | null;
  remarks: string | null;
  created_at: string;
  updated_at: string;
  /** Joined into GET /finished-products/:id/units. */
  job_order_number?: string;
  location_name?: string | null;
  order_number?: string | null;
}

/** A production team — a named crew a job order is assigned to. */
export interface ProductionTeam {
  id: number;
  name: string;
  notes: string | null;
  is_active: number; // 0 | 1
  created_at: string;
  updated_at: string;
  /** Joined for API responses. */
  member_count?: number;
  members?: ProductionTeamMember[];
  open_job_orders?: number;
}

export interface ProductionTeamMember {
  id: number;
  team_id: number;
  employee_id: number;
  role: string | null;
  created_at: string;
  /** Joined. */
  name?: string | null;
  employee_no?: string | null;
  position?: string | null;
}

export type ProductionBatchStatus = 'open' | 'released' | 'closed';

/** A named group of units off one job order. Non-serialized job orders create one per
 *  progress entry; serialized ones can opt in. See src/routes/production.routes.ts. */
export interface ProductionBatch {
  id: number;
  number: string;
  job_order_id: number | null;
  product_item_id: number | null;
  qty: number;
  identifier: string | null;
  status: ProductionBatchStatus;
  notes: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  /** Joined for API responses. */
  job_order_number?: string | null;
  product_name?: string | null;
  created_by_name?: string | null;
  unit_count?: number;
}

/** "Products In" — the Purchasing Goods Receipt pattern mirrored for finished-goods output.
 *  Posting one moves stock in at `location_id`. See src/routes/job-orders.routes.ts
 *  POST /:id/products-in. */
export interface ProductionReceipt {
  id: number;
  number: string;
  job_order_id: number;
  location_id: number | null;
  received_date: string | null;
  notes: string | null;
  received_by: number | null;
  created_at: string;
  received_by_name?: string | null;
  location_name?: string | null;
  job_order_number?: string | null;
  product_name?: string | null;
  items?: ProductionReceiptItem[];
}

export interface ProductionReceiptItem {
  id: number;
  receipt_id: number;
  unit_id: number | null;
  batch_id: number | null;
  quantity: number;
  unit_identifier?: string | null;
  batch_number?: string | null;
}

export type RepairRequestKind = 'add' | 'replace';
export type RepairRequestStatus = 'requested' | 'accepted' | 'rejected' | 'cancelled';
/** Who/what caused the part to be missing or need replacing. */
export type RepairFault = 'assembler' | 'production' | 'supplier' | 'wear' | 'other';

/** A rework unit's request to the warehouse for a part. Nothing moves until the
 *  warehouse accepts (then stock is issued, and for a `replace` the removed part is
 *  booked into its damage twin). See src/routes/production.routes.ts. */
export interface RepairPartRequest {
  id: number;
  number: string;
  unit_id: number;
  job_order_id: number | null;
  kind: RepairRequestKind;
  component_item_id: number | null;
  component_name: string;
  quantity: number;
  fault: RepairFault | null;
  return_to_damage: number; // 0 | 1
  from_location_id: number | null;
  status: RepairRequestStatus;
  requested_by: number | null;
  decided_by: number | null;
  warehouse_remarks: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  /** Joined for API responses. */
  requested_by_name?: string | null;
  decided_by_name?: string | null;
  unit_identifier?: string | null;
  job_order_number?: string | null;
  product_name?: string | null;
  from_location_name?: string | null;
}

export interface MailSettings {
  transport: 'off' | 'smtp';
  from_name: string;
  from_email: string;
  reply_to: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
}

export interface MailLogRow {
  id: number;
  to_addr: string;
  subject: string | null;
  status: 'sent' | 'failed';
  provider_id: string | null;
  error: string | null;
  sent_by: number | null;
  created_at: string;
  sent_by_name?: string | null;
}

export interface QcRecord {
  id: number;
  job_order_id: number;
  unit_id: number | null;
  /** 1 = QA, 2 = QC. */
  stage: number;
  result: 'pass' | 'fail';
  remarks: string | null;
  /** JSON string in the row; parsed to QcChecklistResult[] in API responses. */
  checklist: string | QcChecklistResult[] | null;
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

export type BugReportStatus = 'open' | 'resolved';

/** An in-app bug report — steps to reproduce + up to 5 screenshots (see
    bug_report_attachments). Any signed-in user can file one; users.manage can
    review/resolve them (src/routes/bug-reports.routes.ts). */
export interface BugReport {
  id: number;
  title: string;
  steps_to_reproduce: string;
  description: string | null;
  page_context: string | null;
  status: BugReportStatus;
  reported_by: number | null;
  created_at: string;
  resolved_by: number | null;
  resolved_at: string | null;
}

export type OrderType = 'sale' | 'job' | 'purchase';

export interface Order {
  /** Edit token computed from stored header/lines; optional for legacy integrations. */
  revision?: string;
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
  /** Purchase orders only: the supplier this PO is raised against + expected delivery. */
  supplier_id: number | null;
  expected_date: string | null;
  /** Sale orders only: the customer this order is raised for. */
  customer_id: number | null;
  /** Sale orders only: the location stock ships from (defaults to the default location). */
  location_id: number | null;
  /** Sale orders only: set once the sale's lines have been drawn down from stock and COGS
   *  posted; cleared when the sale is pulled back to a non-firm status. */
  fulfilled_at: string | null;
  /** Sale orders only: set on the first `POST /orders/:id/release` (a warehouse releaser
   *  scanned/entered goods out) and stamped with `released_by`; cleared when the order is
   *  cancelled / re-opened. Does NOT move stock — that still happens on confirm. */
  released_at: string | null;
  released_by: number | null;
  /** Optional VAT / tax classification (drives the GL post + the BIR journals). */
  tax_code_id: number | null;
  created_by_name?: string | null;
  supplier_name?: string | null;
  /** Job orders only: the manufacturing job_orders row this order spawned via "Start
   *  production" (Orders → Job Order), if any — the most recent one when more than one
   *  somehow exists. Lets the UI show/link to it instead of offering "Start production"
   *  again and risking a duplicate. Null for sale/purchase orders and job orders where
   *  production hasn't started yet. */
  job_order_id?: number | null;
  job_order_number?: string | null;
  job_order_status?: string | null;
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
  tax_code_id: number | null; // per-line VAT / tax classification for mixed-rate documents
  sort: number;
  /** Released quantity for a non-serialized (bulk) sale-order line — a warehouse releaser
   *  entering goods out; capped at `quantity`. Serialized units use `job_order_units`. */
  released_qty: number;
  /** Sale orders (joined into GET /orders/:id only): serialized finished units of this
   *  product that are `sold` against this order (`allocated_qty`) or `reserved` for it but
   *  not yet stock-out (`reserved_qty`). */
  allocated_qty?: number;
  reserved_qty?: number;
}

/** A goods receipt (GRN) recording what physically arrived against a purchase order.
    Posting one moves stock in at `location_id`. See src/routes/purchasing.routes.ts. */
export interface GoodsReceipt {
  id: number;
  number: string;
  order_id: number;
  supplier_id: number | null;
  location_id: number | null;
  received_date: string | null;
  notes: string | null;
  received_by: number | null;
  created_at: string;
  received_by_name?: string | null;
  location_name?: string | null;
  order_number?: string | null;
  items?: GoodsReceiptItem[];
}

export interface GoodsReceiptItem {
  id: number;
  receipt_id: number;
  order_item_id: number | null;
  item_id: number | null;
  name: string;
  sku: string | null;
  quantity: number;
  unit: string | null;
  sort: number;
}

/** A vendor bill / supplier invoice against a purchase order, gated on a 3-way match
    (PO ↔ goods receipts ↔ bill) before it can be approved for payment. */
export interface VendorBill {
  id: number;
  number: string;
  vendor_ref: string | null;
  order_id: number;
  supplier_id: number | null;
  bill_date: string | null;
  due_date: string | null;
  currency: string;
  subtotal: number;
  tax_percent: number;
  tax_amount: number;
  total: number;
  status: 'draft' | 'approved' | 'disputed';
  tax_code_id: number | null;
  /** Expanded withholding tax held back from the supplier and remitted to BIR. */
  ewt_rate: number;
  ewt_amount: number;
  ewt_atc: string | null;
  match_json: string | null;
  dispute_note: string | null;
  approved_by: number | null;
  approved_at: string | null;
  notes: string | null;
  created_by: number | null;
  created_at: string;
  approved_by_name?: string | null;
  supplier_name?: string | null;
  order_number?: string | null;
  items?: VendorBillItem[];
}

export interface VendorBillItem {
  id: number;
  bill_id: number;
  order_item_id: number | null;
  item_id: number | null;
  name: string;
  sku: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
  line_total: number;
  tax_code_id: number | null; // per-line VAT / tax classification for mixed-rate documents
  sort: number;
}

/** A named petty-cash fund + its running money-in / money-out register.
    See src/routes/accounting.routes.ts and docs/ACCOUNTING-SYSTEM-PLAN.md. */
export interface PettyCashFund {
  id: number;
  name: string;
  custodian: string | null;
  location_id: number | null;
  opening_balance: number;
  currency: string;
  active: number;
  notes: string | null;
  created_by: number | null;
  created_at: string;
  location_name?: string | null;
  /** Joined in by GET /accounting/petty-cash/funds. */
  balance?: number;
  entry_count?: number;
}

export interface PettyCashEntry {
  id: number;
  fund_id: number;
  entry_date: string;
  direction: 'in' | 'out';
  amount: number;
  category: string | null;
  counterparty: string | null;
  reference_no: string | null;
  notes: string | null;
  recorded_by: number | null;
  created_at: string;
  recorded_by_name?: string | null;
  /** Running balance after this entry — computed in GET .../entries. */
  running_balance?: number;
}

/* ---- Double-entry general ledger (ACCOUNTING-SYSTEM-PLAN.md Phase 0) ---- */

export type AccountRootType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface Account {
  id: number;
  code: string;
  name: string;
  root_type: AccountRootType;
  account_type: string | null;
  parent_id: number | null;
  is_group: number;
  currency: string;
  description: string | null;
  archived: number;
  created_at: string;
  /** Joined / computed for API responses. */
  parent_code?: string | null;
  balance?: number;
  children?: Account[];
}

export interface AccountingPeriod {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed';
  closed_by: number | null;
  closed_at: string | null;
  created_at: string;
}

export interface JournalEntry {
  id: number;
  number: string;
  book: 'general' | 'sales' | 'purchase' | 'cash_receipts' | 'cash_disbursements' | 'payroll';
  entry_date: string;
  memo: string | null;
  reference: string | null;
  source_type: string | null;
  source_id: number | null;
  status: 'draft' | 'posted' | 'void';
  reverses_id: number | null;
  posted_by: number | null;
  posted_at: string | null;
  created_by: number | null;
  created_at: string;
  created_by_name?: string | null;
  total_debit?: number;
  lines?: JournalLine[];
}

export interface JournalLine {
  id: number;
  entry_id: number;
  account_id: number;
  debit: number;
  credit: number;
  party_type: string | null;
  party_id: number | null;
  memo: string | null;
  sort: number;
  account_code?: string;
  account_name?: string;
}

export interface DocTemplate {
  id: number;
  name: string;
  type: 'sale' | 'job' | 'purchase' | 'generic';
  period: string | null;
  body: string;
  // N-up print tiling (SCHEMA_VERSION 30/32) — shown in the template editor as "Grid rows" /
  // "Grid columns" / fill mode. Default 1/1/'blank' (plain one-record-per-page). Only consulted
  // by the generic printRecordsViaTemplate() path; HR Payroll Slip keeps its own hand-built
  // 2x2 layout in hr-payroll-print.js regardless of these.
  copies_per_record: number; // grid rows
  records_per_page: number; // grid columns
  tile_fill: 'blank' | 'repeat';
  // (SCHEMA_VERSION 35) Continuous tiling — see the db.ts version-history comment. Only
  // meaningful when tile_continuous is truthy; otherwise copies_per_record alone is still
  // the repeat count, exactly as before these two fields existed.
  repeat_count: number;
  tile_continuous: number; // 0 | 1
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
  leave_days_per_year: number; // admin-set fixed bank, not accrual-based (see db.ts migration)
  leave_days_used: number; // running counter, incremented as paid Leave forms are approved
  leave_days_remaining?: number; // computed: leave_days_per_year - leave_days_used
  rest_days: number[] | null; // weekday indices (0=Sun..6=Sat) this employee rests on; null = use PayrollPolicy.default_rest_days
  // Exempt from late deductions (e.g. the company president) — see hr-payroll-compute.ts's
  // computeAttendanceForEmployee. Stored as a plain 0/1 SQLite integer; truthy checks work fine
  // at runtime despite the boolean type here (same as every other INTEGER flag on this table).
  late_exempt: boolean;
  // Exempt from overtime pay entirely (e.g. a salaried supervisor) — same convention as
  // late_exempt: ot_hours still computes and shows on the payslip detail, only overtime_pay
  // is zeroed. See hr-payroll-compute.ts.
  ot_exempt: boolean;
  // A fixed withholding-tax peso amount for this employee, replacing the computed BIR formula
  // every cutoff (e.g. a negotiated/BIR-registered special rate). null = use the normal
  // computed amount. Only takes effect while deduct_withholding_tax is also on — see
  // computeEmployeeStatutory in hr.routes.ts.
  withholding_tax_override: number | null;
  // Same fixed-amount override as withholding_tax_override, for the three contribution funds —
  // null = use the normal computed (and slot-divided) amount. Each only takes effect while its
  // matching deduct_* switch is also on; never affects the employer-side contribution.
  sss_override: number | null;
  philhealth_override: number | null;
  pagibig_override: number | null;
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
    computed, as opposed to *when* a shift runs (that's per-Shift). Late/undertime always round
    UP against the employee; OT and per-hours-basis pay always round DOWN (only a fully
    completed block is credited) — the direction itself isn't configurable, only the block size
    (late_unit/ot_unit/hours_basis_unit). */
export interface PayrollPolicy {
  grace_minutes: number;
  late_unit: 'minute' | 'hour';
  ot_unit: 'minute' | '30min' | 'hour';
  ot_rate_percent: number;
  /** When true (the default), OT only pays when the day is linked to an approved Overtime
      Request form — a raw late clock-out by itself isn't auto-paid. When false, any clock-out
      past the shift's expected end auto-pays OT with no form needed. */
  require_ot_form: boolean;
  night_diff_enabled: boolean;
  night_diff_percent: number;
  night_start: string; // "HH:MM"
  night_end: string;   // "HH:MM", wraps midnight if < night_start
  monthly_rate_divisor: number; // effective daily_rate = monthly_rate / this, e.g. 26
  /** How often payroll is run — picks the BIR withholding table and how the monthly
      SSS/PhilHealth/Pag-IBIG contribution is split across cutoffs. */
  pay_frequency: 'monthly' | 'semi_monthly' | 'weekly' | 'daily';
  /** When true, generate-payslips computes SSS/PhilHealth/Pag-IBIG + withholding tax
      from the statutory rate tables. When false, those stay manual (carried over). */
  auto_statutory: boolean;
  /** Weekday indices (0=Sun..6=Sat) that count as a rest day company-wide, unless an
      individual employee has their own employees.rest_days override. Default [0, 6]. */
  default_rest_days: number[];
  /** Which statutory deductions land in which cutoff of the month — e.g. SSS only on the
      1st cutoff, PhilHealth/Pag-IBIG/withholding tax only on the 2nd, instead of splitting
      every deduction evenly across every cutoff. One entry per cutoff "slot" (index 0..
      periodsPerMonth-1 for the current pay_frequency — see PERIODS_PER_MONTH in
      hr.routes.ts); when a key is true for a slot, that cutoff takes a share of the FULL
      monthly amount (split only across however many slots have that key on); when false,
      that cutoff contributes 0 for that key. Absent, or a length mismatch against the
      current pay_frequency's period count (e.g. left over from switching frequencies),
      falls back to "every slot has everything on" — exactly the old always-divide-evenly
      behavior, so this is fully opt-in. */
  deduction_schedule?: Array<{ sss: boolean; philhealth: boolean; pagibig: boolean; withholding_tax: boolean }>;
  /** Below this many actual minutes worked in one day, HR gets a flag + allow/deny button on
      that attendance record (attendance_records.min_hours_decision) — 0 (default) disables the
      check entirely. Doesn't withhold pay on its own: a short day still pays for the actual
      hours/fraction worked by default, same as any other day; only an explicit per-record
      'deny' decision zeroes it. See computeAttendanceForEmployee's minimum-hours check. */
  min_work_minutes: number;
  /** Minutes of unpaid lunch assumed within a shift's span. Subtracted from worked time for
      hours_basis: 'per_hour' pay (unless count_lunch_as_worked), and used to derive a linked
      Half Day request's own AM/PM window regardless of hours_basis — see lunchWindow/
      halfDayWindow in hr-payroll-compute.ts. */
  lunch_break_minutes: number;
  /** When true, lunch is paid time — not subtracted from a per-hours-basis worked span. Has no
      effect on fixed-basis pay (a full flat day already included lunch) or half-day window
      derivation, which always assumes the structural lunch gap regardless of this flag. */
  count_lunch_as_worked: boolean;
  /** When true, a lunch break that runs past PayrollPolicy.lunch_break_minutes adds the excess
      to that day's late deduction, exactly like an ordinary late arrival (same grace_minutes/
      late_unit rounding, same employees.late_exempt exemption) — judged against the shift's own
      structural lunch window (see lunchWindow in hr-payroll-compute.ts) unless a linked Lunch/
      Break Offset Request shifts the expected window for that specific day. When false (default
      — preserves the pre-2026-09 behavior), attendance_records.lunch_out/lunch_in stay a plain
      record HR can see on the Daily Time grid, with no effect on pay: some companies track lunch
      times purely for reference and don't want a long lunch to cost anything. See
      computeAttendanceForEmployee's lunch-lateness block. */
  count_lunch_late_as_late: boolean;
  /** 'fixed' (default): a worked day credits a flat 1 day (0.5 for a linked Half Day request,
      0 for an "Undertime Day" — see whole_day_min_minutes) once present for at least
      whole_day_min_minutes; late/OT/undertime are peso adjustments around the shift's fixed
      start/end. 'per_hour': basic pay is prorated directly from actual worked minutes (lunch
      excluded per count_lunch_as_worked), rounded to hours_basis_unit — e.g. clocking
      08:00-14:00 on an 08:00-17:00 shift with a 60-min lunch pays exactly 5 hours, not a flat
      full or half day. In this mode late arrival/leaving early are inherently self-correcting
      (already paid only for hours present), so no separate late/undertime peso deduction is
      layered on top. */
  hours_basis: 'fixed' | 'per_hour';
  /** Rounding block for hours_basis: 'per_hour' pay (and an "Undertime Day"'s own proportional
      pay under 'fixed' mode — see whole_day_min_minutes) — same rounding-DOWN convention as OT
      (only a fully completed block is paid). */
  hours_basis_unit: 'minute' | '30min' | 'hour';
  /** hours_basis: 'fixed' only. Net minutes actually present (lunch excluded, same rule as
      hours_basis: 'per_hour') a day needs to count as a full "whole day" credit (1.0) toward
      days_worked — not just having clocked in/out at all. Below this, the day becomes its own
      "Undertime Day": 0 credit toward days_worked (tracked separately, see
      AttendanceComputation.days_undertime), paid proportionally for the actual net minutes
      present instead of the flat daily rate, and no separate late/undertime peso deduction is
      layered on top (same self-correcting reasoning as hours_basis: 'per_hour'). Doesn't apply
      to a linked Half Day request (always its own fixed 0.5, never judged by this) or a linked
      Undertime Request with with_pay = 'Yes' (explicitly authorized as a full paid day
      regardless of hours present). Default 420 (7 hours) — deliberately a bit under a full
      8-hour shift so up to an hour late still reads as a whole day. 0 disables the check
      entirely (every present day is a flat whole day, the pre-2026-09 behavior). */
  whole_day_min_minutes: number;
  /** Caps OT credited per day, in hours — hours worked past this are simply not paid as OT
      (same as unauthorized OT when require_ot_form is on: presence without pay, not converted
      into undertime either). null/undefined (default): no cap. Applies in both hours_basis
      modes, scaled by hours_basis_unit's own rounding as usual before the cap is applied. */
  max_ot_hours: number | null;
  /** How the Special (Non-Working) Holiday 30% premium is computed for a day marked via the
      Company Holidays calendar / a per-record override (NOT the employee-filed Holiday Work
      Request form, which has always reported its own hours_worked — this setting now also caps
      that path at 8 hours' worth, but doesn't change its shape). 'flat' (default, the pre-2026-09
      behavior): the full 30% of daily rate, regardless of how many hours were actually worked
      that day — a half-day worked on a special holiday still earns the same premium as a full
      day. 'prorated': the premium scales with actual hours present that day (lunch excluded,
      same convention as hours_basis: 'per_hour'), capped at 8 hours' worth — a half-day (~4
      hours) earns roughly half the premium a full day would. Regular Holiday's premium is
      unaffected either way — it's always the full statutory rate regardless of hours, per Labor
      Code Art. 94. See the special_non_working branch in computeAttendanceForEmployee. */
  special_holiday_premium_mode: 'flat' | 'prorated';
  /** Whether an employee must have attended (or been on an excused/paid day — see below) the day
      immediately before and/or after a Regular or Special Non-Working Holiday to receive that
      holiday's pay/premium at all — some companies' policy (a common, though not universally
      applied, DOLE-adjacent practice) withholds the holiday benefit entirely if the employee was
      unexcused-absent on the qualifying adjacent day(s). 'none' (default, the pre-2026-09
      behavior): no such requirement — holiday pay/premium is never withheld for this reason.
      'before'/'after'/'both': the employee must satisfy the requirement for that specific
      adjacent date (or both). "Satisfies" means: actually present (clocked in and out), on an
      approved paid leave, or the date wasn't a scheduled workday for them at all (a rest day, or
      itself another holiday) — only a genuine unexcused absence on the required day disqualifies.
      When there's no attendance record at all for the adjacent date (e.g. it falls outside any
      period on file), the requirement is treated as satisfied rather than guessed as a failure.
      Applies to both Regular Holiday's full-day pay and Special Non-Working Holiday's premium (in
      either mode above) — never to a plain rest day with no holiday involved. See
      holidayAdjacencyOk / attendanceDaysForEmployee in hr.routes.ts (the check needs a
      period-independent DB lookup, so it can't live in the DB-free compute engine itself) and
      AttendanceDay.holidayEligible in hr-payroll-compute.ts. */
  holiday_adjacency_requirement: 'none' | 'before' | 'after' | 'both';
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

/** One asset (laptop, tool, uniform, ID, …) on an AssetIssuance form — independently
    returnable, since items issued together don't necessarily come back together. Standalone
    register: not linked to Inventory stock. */
export interface AssetIssuanceItem {
  id: number;
  issuance_id: number;
  asset_name: string;
  category: string | null;
  asset_tag: string | null; // serial / property number, if any
  quantity: number;
  condition_on_issue: string | null;
  status: 'issued' | 'returned' | 'lost' | 'damaged';
  returned_date: string | null;
  condition_on_return: string | null;
  return_notes: string | null;
  sort: number;
}

/** A printable "Asset Issuance Form" — one or more assets (AssetIssuanceItem rows) handed to
    one employee on one date. See EmployeeDocument for the analogous 201-file pattern. */
export interface AssetIssuance {
  id: number;
  number: string; // AI-00001
  employee_id: number;
  issued_date: string;
  issued_by: number | null;
  notes: string | null;
  created_at: string;
  issued_by_name?: string | null;
  items?: AssetIssuanceItem[];
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
  /** Lunch-break bracket — start of / return from the unpaid lunch. Split from the raw
      time_punches on reconcile (importPunchesForPeriod) or hand-typed in the Daily Time grid.
      Payroll still always subtracts the structural PayrollPolicy.lunch_break_minutes for pay
      purposes (these two fields never change how much lunch time is excluded) — but the compute
      engine now also reads them for two things: (1) lunch_out set with neither lunch_in nor
      time_out ever recorded (timed out for lunch and never punched again) is treated as an
      effective time-out at lunch, auto-crediting a half day instead of a flat absence; (2)
      PayrollPolicy.count_lunch_late_as_late's optional lunch-return-lateness deduction. See
      hr-payroll-compute.ts. */
  lunch_out: string | null;
  lunch_in: string | null;
  time_out: string | null;
  notes: string | null;
  shift_id: number | null;
  /** Legacy single link — kept and mirrored to the first entry of form_record_ids for
      anything still reading it. Prefer form_record_ids. */
  form_record_id: number | null;
  /** JSON array of form_records ids — a day can link multiple OT/Half Day/Leave/Undertime/
      Offset forms (SCHEMA_VERSION 24). null/absent on rows that predate the feature and were
      never re-saved; the resolver falls back to form_record_id in that case. */
  form_record_ids: string | null;
  /** Per-record holiday override; null inherits the Company Holidays calendar. */
  holiday_type: 'regular' | 'special_non_working' | 'special_working' | 'none' | null;
  /** Per-record rest-day override; null inherits the weekly rest-day pattern
      (employees.rest_days else PayrollPolicy.default_rest_days). */
  rest_day: 'yes' | 'no' | null;
  /** HR's explicit decision on a day that came in under PayrollPolicy.min_work_minutes — set
      via the Daily Time grid's allow/deny button once one appears. null = no decision made yet
      (still pays for actual hours worked, same as 'allow' — see computeAttendanceForEmployee).
      'deny' zeroes the day's credit entirely (not an absence, just excused/undetermined). */
  min_hours_decision: 'allow' | 'deny' | null;
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

/** Automated actions a form fires when a record is created / approved. See src/form-actions.ts.
    `run_on` defaults to 'create'. */
export interface FormAction {
  type:
    | 'notify_employee'      // message the linked employee's login account (+ push)
    | 'save_to_201'          // render the form's template and file it into their 201 documents
    | 'email_employee'       // email the rendered notice via the company SMTP mailbox
    | 'notify_hr'            // message the employee's dept head, else hr.manage holders
    | 'create_followup_task' // add a task due on `due_field`
    | 'apply_no_work';       // date_from/date_to/paid range feeds paid/unpaid no-work into payroll
  run_on?: 'create' | 'approved';
  subject?: string;          // notify_employee / email_employee — templated
  body?: string;             // notify_employee — templated
  due_field?: string;        // create_followup_task — a date field key on the form
  title?: string;            // create_followup_task
}

/** A custom form type created by an admin. */
export interface FormDefinition {
  id: number;
  name: string;
  slug: string;
  number_prefix: string;
  icon: string;
  fields: string | FieldDef[];  // raw JSON string in DB; parsed array in API responses
  actions: string | FormAction[]; // raw JSON string in DB; parsed array in API responses
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
  /** When true, image attachments over ~1 MB are downscaled/re-encoded by the client
      before upload (Messages). Purely a client-side storage saver; default on. */
  compress_images: boolean;
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
