/**
 * All request-body validation lives here as zod schemas.
 * Routes call parseBody(schema, req.body); invalid input throws a ValidationError
 * which the central error handler turns into a 400 response.
 */
import { z } from 'zod';

export class ValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Validate `data` against `schema`, returning typed output or throwing ValidationError. */
export function parseBody<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path?.join('.');
    const msg = first ? (path ? `${path}: ${first.message}` : first.message) : 'Invalid input';
    throw new ValidationError(msg);
  }
  return result.data;
}

const trimmed = z.string().trim();
const optionalText = trimmed.max(2000).optional().nullable();

/** Accepts number, numeric string, '', null or missing -> number | null. */
const optionalId = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? null : v),
  z.coerce.number().int().positive().nullable()
);

/** Accepts a real boolean or the strings '1'/'0'/'true'/'false'. */
const boolish = z.preprocess((v) => {
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
  return v;
}, z.boolean());

const intCoerce = z.coerce.number().int();

// ---- Auth ----
export const loginSchema = z.object({
  username: trimmed.min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'Current password is required'),
  new_password: z.string().min(6, 'New password must be at least 6 characters'),
});

// ---- Users / departments ----
const roleEnum = z.enum(['admin', 'admin_staff', 'accounting', 'warehouse', 'releasing', 'csr', 'hr', 'marketing']);

const emailOpt = z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email')])
  .optional().nullable();

export const createUserSchema = z.object({
  username: trimmed
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,30}$/, 'Username must be 3-30 chars: letters, numbers, dot, underscore, hyphen'),
  full_name: trimmed.min(1, 'Full name is required').max(120),
  email: emailOpt,
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: roleEnum.default('admin_staff'),
  department_id: optionalId,
});

export const updateUserSchema = z.object({
  full_name: trimmed.min(1).max(120).optional(),
  email: emailOpt,
  role: roleEnum.optional(),
  department_id: optionalId,
  active: boolish.optional(),
});

export const resetPasswordSchema = z.object({
  new_password: z.string().min(6, 'New password must be at least 6 characters'),
});

/** POST /api/auth/forgot-password — username or email. Always answered with 200. */
export const forgotPasswordSchema = z.object({
  identifier: trimmed.min(1, 'Enter your username or email').max(200),
});

/** POST /api/auth/reset-password — the emailed token + a new password. */
export const selfResetPasswordSchema = z.object({
  token: trimmed.min(10).max(200),
  new_password: z.string().min(6, 'New password must be at least 6 characters'),
});

export const createDepartmentSchema = z.object({
  name: trimmed.min(1, 'Department name is required').max(80),
});

export const updateDepartmentSchema = createDepartmentSchema.extend({
  // Absent ⇒ leave the head unchanged; '' / null ⇒ clear it; an id ⇒ set it.
  head_user_id: optionalId.optional(),
});

export const updateProfileSchema = z.object({
  full_name: trimmed.min(1, 'Full name is required').max(120),
});

// ---- Inventory ----
/** Extended item fields (the ECOUNT-style catalog) stored as one JSON column.
    Flat map of scalar values; keys are bounded to keep the blob sane. */
export const attributesSchema = z
  .record(
    z.string().max(64),
    z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])
  )
  .refine((o) => Object.keys(o).length <= 200, 'Too many attributes')
  .optional();

/** Like optionalText, but a blank / whitespace-only value collapses to null rather than
    `''` — the DB's UNIQUE constraint on inventory_items.sku exempts only NULL, so two items
    both saved with an empty SKU would otherwise collide. */
const optionalSku = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  optionalText
);

export const createItemSchema = z.object({
  name: trimmed.min(1, 'Item name is required').max(160),
  sku: optionalSku,
  category: optionalText,
  department_id: optionalId,
  supplier_id: optionalId,
  location_id: optionalId, // where the starting stock lands (default: the default location)
  quantity: intCoerce.default(0),
  unit: trimmed.max(40).optional().nullable(),
  min_quantity: intCoerce.min(0).default(0),
  location: optionalText,
  notes: optionalText,
  attributes: attributesSchema,
});

export const updateItemSchema = z.object({
  name: trimmed.min(1, 'Item name is required').max(160).optional(),
  sku: optionalSku,
  category: optionalText,
  department_id: optionalId,
  supplier_id: optionalId,
  unit: trimmed.max(40).optional().nullable(),
  min_quantity: intCoerce.min(0).optional(),
  location: optionalText,
  notes: optionalText,
  attributes: attributesSchema,
});

/** Body for the CSV import endpoints: raw CSV text (~5 MB cap) + an optional
    validate-only flag. Shared by /inventory/import, /suppliers/import, /hr/employees/import. */
export const csvImportSchema = z.object({
  csv: z.string().min(1, 'A CSV body is required').max(5_000_000, 'CSV is too large (5 MB max)'),
  dry_run: boolish.optional(),
});

/** PUT /api/ai/config — per-tenant LLM settings. `api_key` write-only ('' clears → env). */
export const aiConfigSchema = z.object({
  model: trimmed.max(120).optional(),
  base_url: z.union([z.literal(''), z.string().trim().url('Endpoint must be a valid URL')]).optional(),
  api_key: z.string().max(500).optional(),
});

/** POST /api/signup — create a new tenant workspace (self-serve, gated by SIGNUPS_OPEN). */
export const signupSchema = z.object({
  company_name: trimmed.min(1, 'Company name is required').max(120),
  slug: trimmed.toLowerCase().regex(/^[a-z][a-z0-9-]{1,30}$/, 'Workspace name: a letter then letters/numbers/hyphens, 2–31 chars'),
  admin_username: trimmed.toLowerCase().regex(/^[a-z0-9._-]{3,30}$/, 'Username must be 3-30 chars: letters, numbers, dot, underscore, hyphen'),
  admin_password: z.string().min(6, 'Password must be at least 6 characters'),
  admin_email: z.union([z.literal(''), z.string().trim().email()]).optional(),
});
/** @deprecated alias — use csvImportSchema. */
export const importInventorySchema = csvImportSchema;

// ---- Suppliers ----
export const createSupplierSchema = z.object({
  name: trimmed.min(1, 'Supplier name is required').max(160),
  contact_person: trimmed.max(160).optional().nullable(),
  phone: trimmed.max(80).optional().nullable(),
  email: trimmed.max(160).optional().nullable(),
  address: trimmed.max(500).optional().nullable(),
  notes: optionalText,
});

export const updateSupplierSchema = createSupplierSchema.partial().extend({
  name: trimmed.min(1, 'Supplier name is required').max(160).optional(),
});

// ---- Locations ----
const locationType = z.enum(['warehouse', 'branch', 'store', 'truck', 'other']);
export const createLocationSchema = z.object({
  name: trimmed.min(1, 'Location name is required').max(120),
  type: locationType.default('warehouse'),
  address: trimmed.max(500).optional().nullable(),
  notes: optionalText,
  is_default: boolish.optional(),
});
export const updateLocationSchema = createLocationSchema.partial().extend({
  name: trimmed.min(1, 'Location name is required').max(120).optional(),
});

export const transferStockSchema = z.object({
  from_location_id: z.coerce.number().int().positive(),
  to_location_id: z.coerce.number().int().positive(),
  amount: z.coerce.number().int().positive('Amount must be a positive whole number'),
  reason: optionalText,
});

// ---- Bill of materials (finished products) ----
export const saveBomSchema = z.object({
  components: z
    .array(
      z.object({
        component_item_id: z.coerce.number().int().positive(),
        quantity: z.coerce.number().int().positive('Component quantity must be a whole number above 0'),
        notes: trimmed.max(300).optional().nullable(),
      })
    )
    .max(200),
  // Which QA/QC checklist this product uses. Absent = leave unchanged; '' / null = clear.
  qc_checklist_id: optionalId.optional(),
});

/** POST /api/finished-products/:id/units/allocate — sell or relocate in-stock units.
    Provide either explicit `unit_ids` (serialized) or a `quantity` of bulk units. */
export const allocateUnitsSchema = z
  .object({
    action: z.enum(['sell', 'move']),
    unit_ids: z.array(z.coerce.number().int().positive()).max(500).optional(),
    quantity: z.coerce.number().int().positive().max(500).optional(),
    order_id: optionalId,
    to_location_id: optionalId,
    reason: optionalText,
  })
  .refine((v) => (v.unit_ids && v.unit_ids.length) || v.quantity, {
    message: 'Pick units or a quantity',
    path: ['unit_ids'],
  })
  .refine((v) => v.action !== 'sell' || v.order_id != null, {
    message: 'A sales order is required to sell units',
    path: ['order_id'],
  })
  .refine((v) => v.action !== 'move' || v.to_location_id != null, {
    message: 'A destination location is required to move units',
    path: ['to_location_id'],
  });

// ---- Manufacturing job orders ----
export const createJobOrderSchema = z.object({
  product_item_id: z.coerce.number().int().positive(),
  qty_ordered: z.coerce.number().int().positive('Quantity to build must be at least 1'),
  order_id: optionalId,
  source_location_id: optionalId,
  output_location_id: optionalId,
  qc_stages: z.coerce.number().int().min(0).max(2).default(0),
  notes: optionalText,
});

export const updateJobOrderSchema = z.object({
  qty_ordered: z.coerce.number().int().positive().optional(),
  source_location_id: optionalId,
  output_location_id: optionalId,
  qc_stages: z.coerce.number().int().min(0).max(2).optional(),
  notes: optionalText,
});

export const jobOrderComponentsSchema = z.object({
  components: z
    .array(
      z.object({
        component_item_id: z.coerce.number().int().positive(),
        qty_planned: z.coerce.number().int().min(0),
      })
    )
    .max(200),
});

export const jobOrderProgressSchema = z
  .object({
    done_delta: z.coerce.number().int().min(0).default(0),
    scrapped_delta: z.coerce.number().int().min(0).default(0),
  })
  .refine((d) => d.done_delta + d.scrapped_delta > 0, 'Enter a finished or scrapped quantity');

/** An alphanumeric identifier for a produced unit (serial / chassis / motor no.).
    Not required to be unique — several units may share one. */
const unitIdentifier = trimmed
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/, 'Identifier must be alphanumeric')
  .optional()
  .nullable();

/** One filled checklist line submitted with an inspection. */
const checklistResultSchema = z.object({
  label: trimmed.min(1).max(200),
  ok: boolish,
  note: trimmed.max(500).optional().nullable(),
});

export const inspectUnitsSchema = z.object({
  unit_ids: z.array(z.coerce.number().int().positive()).min(1).max(500),
  result: z.enum(['pass', 'fail']),
  remarks: trimmed.max(2000).optional().nullable(),
  identifier: unitIdentifier,
  checklist: z.array(checklistResultSchema).max(60).optional(),
});

/** POST/PUT /api/qc/checklists/:id — one named, reusable QA/QC checklist. */
export const qcChecklistSchema = z.object({
  name: trimmed.min(1, 'Give the checklist a name').max(120),
  is_default: boolish.default(false),
  items: z
    .array(
      z.object({
        label: trimmed.min(1, 'Each check needs a label').max(200),
        required: boolish.default(false),
        stage: z.coerce.number().int().min(0).max(2).default(0),
      })
    )
    .max(60, 'Keep the checklist under 60 items'),
});

export const setUnitIdentifierSchema = z.object({
  identifier: unitIdentifier,
});

/** Admin-saved item-form customization: per-field visibility / required / default. */
export const formConfigSchema = z
  .array(
    z
      .object({
        key: trimmed.min(1).max(64),
        visible: boolish,
        required: boolish,
      })
      .passthrough()
  )
  .max(500);

export const adjustStockSchema = z.object({
  change: intCoerce.refine((n) => n !== 0, 'Change must be a non-zero whole number'),
  reason: optionalText,
  location_id: optionalId, // defaults server-side to the default location
});

/** Report damaged stock: moves `quantity` units out of the item into its "damage twin"
    (a copy row with category 'Damage'). See POST /api/inventory/:id/damage. */
export const damageStockSchema = z.object({
  quantity: z.coerce.number().int().positive('Quantity must be a positive whole number'),
  reason: optionalText,
  location_id: optionalId, // defaults server-side to the default location
});

// ---- Messages ----
export const sendMessageSchema = z.object({
  recipient_id: z.coerce.number().int().positive('Recipient is required'),
  subject: trimmed.max(200).optional().nullable(),
  body: trimmed.min(1, 'Message body is required').max(5000),
});

// ---- Personal tools (notes / tasks / bookmarks) ----
export const noteSchema = z.object({
  title: trimmed.max(200).optional().nullable(),
  body: trimmed.min(1, 'Note cannot be empty').max(20000),
});

export const taskSchema = z.object({
  title: trimmed.min(1, 'Task title is required').max(300),
  due_date: trimmed.max(40).optional().nullable(),
  notes: trimmed.max(2000).optional().nullable(),
  remind_at: trimmed.max(40).optional().nullable(),
  done: boolish.optional(),
});

export const updateTaskSchema = z.object({
  title: trimmed.min(1).max(300).optional(),
  due_date: trimmed.max(40).optional().nullable(),
  notes: trimmed.max(2000).optional().nullable(),
  remind_at: trimmed.max(40).optional().nullable(),
  done: boolish.optional(),
});

export const bookmarkSchema = z.object({
  label: trimmed.min(1, 'Bookmark label is required').max(200),
  route: trimmed.min(1, 'Bookmark route is required').max(80),
  params: z
    .record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
    .optional()
    .nullable(),
});

// ---- Documents: orders + templates ----
const numCoerce = z.coerce.number();

const orderItemSchema = z.object({
  item_id: optionalId,
  name: trimmed.min(1, 'Line item name is required').max(200),
  sku: optionalText,
  description: optionalText,
  quantity: numCoerce.min(0, 'Quantity cannot be negative').default(1),
  unit: trimmed.max(40).optional().nullable(),
  unit_price: numCoerce.min(0, 'Price cannot be negative').default(0),
});

const orderFields = {
  customer_name: optionalText,
  customer_contact: optionalText,
  order_date: trimmed.max(40).optional().nullable(),
  status: trimmed.max(40).optional().nullable(),
  notes: optionalText,
  currency: trimmed.max(10).optional().nullable(),
  tax_percent: numCoerce.min(0).max(100).default(0),
  items: z.array(orderItemSchema).min(1, 'Add at least one line item').max(300),
  // Purchase orders: which supplier + expected delivery date.
  supplier_id: optionalId,
  expected_date: trimmed.max(40).optional().nullable(),
};

export const createOrderSchema = z.object({
  type: z.enum(['sale', 'job', 'purchase']),
  ...orderFields,
});

export const updateOrderSchema = z.object(orderFields);

// ---- Purchasing: goods receipts + vendor bills (3-way match) ----
const receiptLineSchema = z.object({
  order_item_id: optionalId,
  item_id: optionalId,
  name: trimmed.min(1).max(200),
  sku: optionalText,
  unit: trimmed.max(40).optional().nullable(),
  quantity: numCoerce.min(0, 'Quantity cannot be negative').default(0),
});

export const createReceiptSchema = z.object({
  received_date: trimmed.max(40).optional().nullable(),
  location_id: z.coerce.number().int().positive('Pick the location stock is received into'),
  notes: optionalText,
  lines: z.array(receiptLineSchema).min(1, 'Add at least one line').max(300)
    .refine((ls) => ls.some((l) => (l.quantity || 0) > 0), 'Enter a received quantity on at least one line'),
});

const billLineSchema = z.object({
  order_item_id: optionalId,
  item_id: optionalId,
  name: trimmed.min(1, 'Line item name is required').max(200),
  sku: optionalText,
  unit: trimmed.max(40).optional().nullable(),
  quantity: numCoerce.min(0, 'Quantity cannot be negative').default(0),
  unit_price: numCoerce.min(0, 'Price cannot be negative').default(0),
});

export const vendorBillSchema = z.object({
  vendor_ref: trimmed.max(80).optional().nullable(),
  bill_date: trimmed.max(40).optional().nullable(),
  due_date: trimmed.max(40).optional().nullable(),
  currency: trimmed.max(10).optional().nullable(),
  tax_percent: numCoerce.min(0).max(100).default(0),
  notes: optionalText,
  lines: z.array(billLineSchema).min(1, 'Add at least one line').max(300),
});

export const approveBillSchema = z.object({
  /** Approve despite match exceptions (records who overrode). */
  force: boolish.default(false),
  note: trimmed.max(1000).optional().nullable(),
});

export const disputeBillSchema = z.object({
  note: trimmed.min(3, 'Say what the problem is').max(1000),
});

export const matchToleranceSchema = z.object({
  price_pct: numCoerce.min(0).max(100).default(2),
  price_abs: numCoerce.min(0).default(0),
  qty_pct: numCoerce.min(0).max(100).default(0),
});

export const templateSchema = z.object({
  name: trimmed.min(1, 'Template name is required').max(120),
  type: z.enum(['sale', 'job', 'purchase', 'generic']).default('generic'),
  period: trimmed.max(60).optional().nullable(),
  body: trimmed.min(1, 'Template body cannot be empty').max(5000000),
});

// ---- Form builder ----

// 'employee' renders as a live dropdown of current employees (never a stale, form-design-time
// options list) — its stored value is still just the employee's name, the same plain string
// convention every other form already relies on (e.g. matching attendance to a form record).
const fieldTypeEnum = z.enum(['text', 'number', 'date', 'select', 'textarea', 'checkbox', 'employee']);

export const fieldDefSchema = z.object({
  key: trimmed.min(1).max(64).regex(/^[a-z0-9_]+$/, 'Key must be lowercase letters, numbers, or underscores'),
  label: trimmed.min(1).max(120),
  type: fieldTypeEnum,
  required: boolish.default(false),
  options: z.array(trimmed.max(200)).max(100).default([]),
  default: trimmed.max(500).default(''),
});

export const formDefinitionSchema = z.object({
  name: trimmed.min(1, 'Form name is required').max(120),
  slug: trimmed.min(1).max(60).regex(/^[a-z0-9_]+$/, 'Slug must be lowercase letters, numbers, or underscores'),
  number_prefix: trimmed.min(1).max(10).regex(/^[A-Z0-9]+$/, 'Prefix must be uppercase letters or numbers').default('FM'),
  icon: trimmed.max(40).default('file'),
  fields: z.array(fieldDefSchema).max(100).default([]),
  scope: z.enum(['hr', 'inventory', 'admin', 'accounting']).nullable().default(null),
});

export const linkFormTemplateSchema = z.object({
  template_id: z.coerce.number().int().positive().nullable(),
});

export const createFormRecordSchema = z.object({
  form_def_id: z.coerce.number().int().positive('Form definition is required'),
  data: z.record(z.string().max(64), z.union([z.string().max(10000), z.number(), z.boolean(), z.null()])).default({}),
  status: trimmed.max(40).default('draft'),
});

export const updateFormRecordSchema = z.object({
  data: z.record(z.string().max(64), z.union([z.string().max(10000), z.number(), z.boolean(), z.null()])).default({}),
  status: trimmed.max(40).optional(),
});

export const globalVariableSchema = z.object({
  label: trimmed.min(1, 'Label is required').max(120),
  value: trimmed.max(2000).default(''),
});

export const companyProfileSchema = z.object({
  name: trimmed.max(200).optional().nullable(),
  address: trimmed.max(500).optional().nullable(),
  phone: trimmed.max(80).optional().nullable(),
  email: trimmed.max(160).optional().nullable(),
  logo_url: trimmed.max(500).optional().nullable(),
});

/** A document-template variable (constant / bound field / formula). */
export const docVariableSchema = z.object({
  scope: z.enum(['global', 'template']).default('global'),
  template_id: optionalId,
  category: trimmed.min(1).max(60).default('Custom'),
  key: trimmed.regex(/^[a-zA-Z_][\w]{0,63}$/, 'Key must start with a letter and use only letters, numbers, _'),
  label: trimmed.min(1, 'Label is required').max(120),
  source_type: z.enum(['constant', 'field', 'formula']).default('constant'),
  value: trimmed.max(2000).optional().nullable(),
  field_path: trimmed.max(120).optional().nullable(),
  formula: trimmed.max(2000).optional().nullable(),
  data_type: z.enum(['text', 'number', 'currency', 'date']).default('text'),
  sort: intCoerce.default(0),
});

// ---- HR: Employees / Time Keeping ----

const employeeStatusEnum = z.enum(['probationary', 'regular', 'resigned', 'terminated']);
const optionalIdText = trimmed.max(40).optional().nullable();

export const employeeSchema = z.object({
  employee_no: trimmed.min(1, 'Employee number is required').max(40),
  name: trimmed.min(1, 'Employee name is required').max(160),
  department_id: optionalId,
  position: trimmed.max(120).optional().nullable(),
  user_id: optionalId,
  rate_type: z.enum(['daily', 'monthly']).default('daily'),
  daily_rate: numCoerce.min(0, 'Daily rate cannot be negative').default(0),
  monthly_rate: numCoerce.min(0, 'Monthly rate cannot be negative').optional().nullable(),
  status: employeeStatusEnum.default('probationary'),
  start_date: trimmed.max(40).optional().nullable(),
  sss_no: optionalIdText,
  philhealth_no: optionalIdText,
  pagibig_no: optionalIdText,
  tin_no: optionalIdText,
  photo: z.preprocess(
    (v) => (v === '' ? null : v),
    z.string().max(2_000_000).regex(/^data:image\//, 'Photo must be an image').optional().nullable()
  ),
}).refine(
  (v) => v.rate_type !== 'monthly' || (v.monthly_rate != null && v.monthly_rate > 0),
  { message: 'Monthly rate is required when rate type is monthly', path: ['monthly_rate'] }
);

export const attendancePeriodSchema = z
  .object({
    label: trimmed.min(1, 'Cutoff label is required').max(120),
    start_date: trimmed.min(1, 'Start date is required').max(40),
    end_date: trimmed.min(1, 'End date is required').max(40),
  })
  .refine((v) => v.end_date >= v.start_date, {
    message: 'End date must be on or after the start date',
    path: ['end_date'],
  });

const timeOfDay = z.union([trimmed.max(20), z.null()]).optional();
const nullableId = z.coerce.number().int().positive().nullable().optional();

const attendanceDaySchema = z.object({
  work_date: trimmed.min(1).max(40),
  time_in: timeOfDay,
  time_out: timeOfDay,
  notes: optionalText,
  shift_id: nullableId,
  form_record_id: nullableId,
});

export const saveAttendanceSchema = z.object({
  employee_id: z.coerce.number().int().positive('Employee is required'),
  days: z.array(attendanceDaySchema).max(62),
});

export const addRosterEmployeeSchema = z.object({
  employee_id: z.coerce.number().int().positive('Employee is required'),
});

/** Either an explicit id list (checkbox multi-select in the picker) or a department/status/name
    filter ("Add All" — the route resolves the matching employees itself, same filter semantics
    as GET /hr/employees, so "Add All" always reflects the true matching set, not just whatever
    happened to be rendered client-side). All fields optional; no filter at all means every
    employee in the company. */
export const addRosterEmployeesBulkSchema = z.object({
  employee_ids: z.array(z.coerce.number().int().positive()).max(1000).optional(),
  q: trimmed.max(160).optional(),
  department_id: optionalId,
  status: employeeStatusEnum.optional(),
});

export const generatePayslipsSchema = z.object({
  payroll_period: trimmed.min(1, 'Payroll period label is required').max(120),
  pay_date: trimmed.max(40).optional().nullable(),
});

// ---- Shifts + payroll policy ----

const hhmm = trimmed.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM, 24-hour');

export const shiftSchema = z.object({
  name: trimmed.min(1, 'Shift name is required').max(80),
  start_time: hhmm,
  end_time: hhmm,
  is_default: boolish.default(false),
});

export const employeeNumberPolicySchema = z.object({
  prefix: trimmed.max(20).default('EMP'),
  mode: z.enum(['sequential', 'hire_date']).default('sequential'),
  pad: z.coerce.number().int().min(1).max(8).default(5),
  date_format: z.enum(['YYYYMMDD', 'YYMMDD']).default('YYYYMMDD'),
});

/** POST /api/hr/payroll-tables — one versioned statutory rate table. `data` shape is
    validated loosely here (it's kind-specific); src/ph-statutory.ts is the contract. */
export const payrollTableSchema = z.object({
  kind: z.enum(['sss', 'philhealth', 'pagibig', 'rwt']),
  effective_from: trimmed.regex(/^\d{4}-\d{2}-\d{2}$/, 'effective_from must be YYYY-MM-DD'),
  data: z.record(z.string(), z.unknown()).refine((o) => Object.keys(o).length > 0, 'data cannot be empty'),
  note: trimmed.max(500).optional().nullable(),
});

export const payrollPolicySchema = z.object({
  grace_minutes: z.coerce.number().int().min(0).max(240).default(10),
  late_unit: z.enum(['minute', 'hour']).default('hour'),
  ot_unit: z.enum(['minute', '30min', 'hour']).default('hour'),
  ot_rate_percent: z.coerce.number().min(0).max(1000).default(125),
  night_diff_enabled: boolish.default(false),
  night_diff_percent: z.coerce.number().min(0).max(200).default(10),
  night_start: hhmm.default('22:00'),
  night_end: hhmm.default('06:00'),
  monthly_rate_divisor: z.coerce.number().min(1).max(31).default(26),
  pay_frequency: z.enum(['monthly', 'semi_monthly', 'weekly', 'daily']).default('semi_monthly'),
  auto_statutory: boolish.default(true),
});

/** Sparse permission overrides: keys are permission strings, values are booleans. */
export const permissionOverridesSchema = z.object({
  overrides: z.record(z.string().max(64), z.boolean())
    .refine((o) => Object.keys(o).length <= 50, 'Too many overrides'),
});

// ---- Email ----
export const mailSettingsSchema = z.object({
  transport: z.enum(['off', 'smtp']).default('off'),
  from_name: trimmed.max(120).default(''),
  from_email: z.union([z.literal(''), z.string().trim().email('From address must be a valid email')]).default(''),
  reply_to: z.union([z.literal(''), z.string().trim().email('Reply-to must be a valid email')]).default(''),
  smtp_host: trimmed.max(200).default(''),
  smtp_port: z.coerce.number().int().min(1).max(65535).default(587),
  smtp_secure: boolish.default(false),
  smtp_user: trimmed.max(200).default(''),
  smtp_pass: z.string().max(500).optional(),
});

export const sendMailSchema = z.object({
  to: z.string().trim().email('A valid recipient email is required').max(200),
  subject: trimmed.min(1, 'Subject is required').max(200),
  body: trimmed.min(1, 'Message body is required').max(20000),
});

// ---- Web push ----
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  expirationTime: z.union([z.number(), z.null()]).optional(),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});

export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
});

// ---- Time clock ----
export const phonePunchSchema = z.object({
  code: z.string().trim().length(10, 'Scan the current office code'),
});

export const kioskPunchSchema = z.object({
  code: z.string().trim().length(10, 'The office code has changed — the screen shows a fresh one'),
  employee_no: trimmed.min(1, 'Employee number is required').max(40),
  name: trimmed.min(1, 'Name is required').max(160),
});

// ---- Announcements ----
export const announcementSchema = z.object({
  title: trimmed.min(1, 'Title is required').max(160),
  body: trimmed.min(1, 'Announcement body is required').max(5000),
  pinned: boolish.default(false),
  expires_at: trimmed.max(40).optional().nullable(),
  /** POST only: also send a web-push to everyone. */
  notify: boolish.default(false),
});
export const updateAnnouncementSchema = announcementSchema;

// ---- Attendance corrections ----
const clockTime = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.union([trimmed.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM, 24-hour'), z.null()])
);

export const timeCorrectionSchema = z
  .object({
    work_date: trimmed.regex(/^\d{4}-\d{2}-\d{2}$/, 'work_date must be YYYY-MM-DD'),
    requested_in: clockTime,
    requested_out: clockTime,
    reason: trimmed.min(3, 'A short reason is required').max(1000),
  })
  .refine((v) => v.requested_in || v.requested_out, {
    message: 'Enter at least a time-in or a time-out',
    path: ['requested_in'],
  });

export const approvalDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: trimmed.max(1000).optional().nullable(),
});
