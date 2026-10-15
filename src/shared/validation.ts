/**
 * All request-body validation lives here as zod schemas.
 * Routes call parseBody(schema, req.body); invalid input throws a ValidationError
 * which the central error handler turns into a 400 response.
 */
import { newPasswordSchema } from './password-policy';
import { z } from 'zod';
import { MODULES } from './modules';
import { isMultiPageDocument, MULTIPAGE_GRID_ERROR } from './document-layout';

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
const realCalendarDate = trimmed.refine(v => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v, 'Enter a real YYYY-MM-DD date');
const optionalText = trimmed.max(2000).optional().nullable();

/** Accepts number, numeric string, '', null or missing -> number | null. */
const optionalId = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? null : v),
  z.coerce.number().int().positive().nullable()
);

/** Accepts a real boolean, the strings '1'/'0'/'true'/'false', or the numbers 1/0. */
const boolish = z.preprocess((v) => {
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
  if (typeof v === 'number') return v !== 0;
  return v;
}, z.boolean());

const intCoerce = z.coerce.number().int();

// ---- Auth ----
export const loginSchema = z.object({
  username: trimmed.min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  /** Borrowed-phone sign-in: a short, idle-limited session with no push (src/shared/auth.ts). */
  shared: z.boolean().optional(),
});

export const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'Current password is required'),
  new_password: newPasswordSchema('New password'),
});

// ---- Users / departments ----
// A key from the tenant's roles table — routes check it exists (src/shared/roles.ts getRole).
const roleEnum = z.string().trim().min(1, 'Role is required').max(40);

/** POST /api/roles. The key is derived from the label when omitted (roles.routes.ts). */
export const createRoleSchema = z.object({
  label: trimmed.min(1, 'Role name is required').max(60),
  key: z.string().trim().toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,39}$/, 'Role key must be 2-40 chars: lowercase letters, numbers, underscore')
    .optional(),
  description: trimmed.max(200).optional().default(''),
  permissions: z.array(z.string()).max(200).default([]),
});

/** PUT /api/roles/:key — any subset; the key itself never changes (accounts hold it). */
export const updateRoleSchema = z.object({
  label: trimmed.min(1, 'Role name is required').max(60).optional(),
  description: trimmed.max(200).optional(),
  permissions: z.array(z.string()).max(200).optional(),
});

const emailOpt = z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email')])
  .optional().nullable();

export const createUserSchema = z.object({
  username: trimmed
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,30}$/, 'Username must be 3-30 chars: letters, numbers, dot, underscore, hyphen'),
  full_name: trimmed.min(1, 'Full name is required').max(120),
  email: emailOpt,
  password: newPasswordSchema('Password'),
  role: roleEnum.default('admin_staff'),
  department_id: optionalId,
  employee_id: optionalId.optional(),
});

export const updateUserSchema = z.object({
  full_name: trimmed.min(1).max(120).optional(),
  email: emailOpt,
  role: roleEnum.optional(),
  department_id: optionalId,
  active: boolish.optional(),
});

export const resetPasswordSchema = z.object({
  new_password: newPasswordSchema('New password'),
});

/** POST /api/auth/forgot-password — username or email. Always answered with 200. */
export const forgotPasswordSchema = z.object({
  identifier: trimmed.min(1, 'Enter your username or email').max(200),
});

/** POST /api/auth/reset-password — the emailed token + a new password. */
export const selfResetPasswordSchema = z.object({
  token: trimmed.min(10).max(200),
  new_password: newPasswordSchema('New password'),
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
  new_location_levels: z.array(trimmed.min(1).max(120)).max(4).optional(), // optional children beneath location_id
  quantity: intCoerce.min(0).default(0),
  unit: trimmed.max(40).optional().nullable(),
  min_quantity: intCoerce.min(0).default(0),
  unit_cost: z.coerce.number().min(0).default(0), // standard cost — values raw materials / finished goods in the GL
  location: optionalText,
  notes: optionalText,
  // Groups variants of the same base product (e.g. "Office Chair" for Red/Blue/Green rows) —
  // each variant stays its own full item; this is just the shared label to list/filter/pick
  // them together. The variant's own descriptor (color/size/spec) is attributes.spec.
  product_group: optionalText,
  attributes: attributesSchema,
});

export const updateItemSchema = z.object({
  name: trimmed.min(1, 'Item name is required').max(160).optional(),
  sku: optionalSku,
  category: optionalText,
  department_id: optionalId,
  supplier_id: optionalId,
  preferred_location_id: optionalId.optional(),
  unit: trimmed.max(40).optional().nullable(),
  min_quantity: intCoerce.min(0).optional(),
  unit_cost: z.coerce.number().min(0).optional(),
  location: optionalText,
  notes: optionalText,
  product_group: optionalText,
  attributes: attributesSchema,
});

/** Body for the CSV import endpoints: raw CSV text (~5 MB cap) + an optional
    validate-only flag. Shared by /inventory/import, /suppliers/import, /hr/employees/import. */
export const csvImportSchema = z.object({
  csv: z.string().min(1, 'A CSV body is required').max(5_000_000, 'CSV is too large (5 MB max)'),
  dry_run: boolish.optional(),
});

/** PUT /api/ai/config — per-tenant LLM settings. `api_key` write-only ('' clears → env).
    `token_cap` is a running-usage ceiling (0 = unlimited) — see src/ai-config.ts. */
export const aiConfigSchema = z.object({
  model: trimmed.max(120).optional(),
  base_url: z.union([z.literal(''), z.string().trim().url('Endpoint must be a valid URL')]).optional(),
  api_key: z.string().max(500).optional(),
  // z.coerce.number() inline, not the shared numCoerce const — that's declared later in this
  // file and referencing it here (aiConfigSchema sits above its declaration) is a TDZ error.
  token_cap: z.coerce.number().min(0).max(1_000_000_000).optional(),
});

/** Operator-created workspaces: sandbox accounts may omit their recovery email and slug. */
export const platformCreateTenantSchema = z.object({
  name: trimmed.min(1, 'Company name is required').max(120),
  slug: trimmed.toLowerCase().optional(),
  admin_username: trimmed.toLowerCase().regex(/^[a-z0-9._-]{3,30}$/, 'Username must be 3-30 chars: letters, numbers, dot, underscore, hyphen'),
  admin_password: newPasswordSchema('Password'),
  admin_email: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid owner email address')]).optional(),
  is_sandbox: z.boolean().default(false),
  plan: trimmed.optional(),
  modules: z.array(z.string()).optional(),
  awaiting_payment: z.boolean().optional(),
  inquiry_id: z.number().int().positive().optional(),
}).superRefine((v, ctx) => {
  if (!v.is_sandbox && !v.admin_email) {
    ctx.addIssue({ code: 'custom', path: ['admin_email'], message: 'Owner email is required for regular accounts' });
  }
});

/** POST /api/signup — create a new tenant workspace (self-serve, gated by SIGNUPS_OPEN). */
export const signupSchema = z.object({
  company_name: trimmed.min(1, 'Company name is required').max(120),
  slug: trimmed.toLowerCase().regex(/^[a-z][a-z0-9-]{1,30}$/, 'Workspace name: a letter then letters/numbers/hyphens, 2–31 chars'),
  admin_username: trimmed.toLowerCase().regex(/^[a-z0-9._-]{3,30}$/, 'Username must be 3-30 chars: letters, numbers, dot, underscore, hyphen'),
  admin_password: newPasswordSchema('Password'),
  admin_email: z.union([z.literal(''), z.string().trim().email()]).optional(),
  modules: z.array(z.enum(MODULES)).min(1).optional(),
  seats: z.number().int().min(1).max(500).optional(),
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
  tin: trimmed.max(40).optional().nullable(),
  notes: optionalText,
});

export const updateSupplierSchema = createSupplierSchema.partial().extend({
  name: trimmed.min(1, 'Supplier name is required').max(160).optional(),
});

// ---- Customers (AR-side party registry) ----
export const createCustomerSchema = z.object({
  name: trimmed.min(1, 'Customer name is required').max(160),
  contact_person: trimmed.max(160).optional().nullable(),
  phone: trimmed.max(80).optional().nullable(),
  email: trimmed.max(160).optional().nullable(),
  address: trimmed.max(500).optional().nullable(),
  tin: trimmed.max(40).optional().nullable(),
  payment_terms_days: z.coerce.number().int().min(0).max(365).default(0),
  notes: optionalText,
  archived: boolish.optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial().extend({
  name: trimmed.min(1, 'Customer name is required').max(160).optional(),
});

// ---- Locations ----
const locationType = z.enum(['warehouse', 'branch', 'store', 'truck', 'other']);
export const createLocationSchema = z.object({
  name: trimmed.min(1, 'Location name is required').max(120),
  parent_id: optionalId,
  type: locationType.default('warehouse'),
  address: trimmed.max(500).optional().nullable(),
  notes: optionalText,
  is_default: boolish.optional(),
  // Room in units of stock; null / empty clears it (no limit).
  capacity: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().int().positive('Capacity must be a positive whole number').max(10_000_000).nullable()).optional(),
});
export const updateLocationSchema = createLocationSchema.partial().extend({
  name: trimmed.min(1, 'Location name is required').max(120).optional(),
});

export const transferStockSchema = z.object({
  from_location_id: z.coerce.number().int().positive(),
  to_location_id: z.coerce.number().int().positive(),
  amount: z.coerce.number().int().positive('Amount must be a positive whole number'),
  reason: optionalText,
  build_mode: z.enum(['assembled', 'semi_built']).default('assembled'),
});

// ---- Bill of materials (finished products) ----
export const saveBomSchema = z.object({
  // An empty list is allowed — a finished product may have no BOM yet and still be
  // built (a job order for it just consumes nothing unless components are added ad hoc).
  components: z
    .array(
      z.object({
        component_item_id: z.coerce.number().int().positive(),
        quantity: z.coerce.number().int().positive('Component quantity must be a whole number above 0'),
        notes: trimmed.max(300).optional().nullable(),
      })
    )
    .max(200),
  // Which QA/QC checklist this product uses at each stage. Absent = leave unchanged;
  // '' / null = clear (falls back to that stage's default).
  qc_checklist_qa_id: optionalId.optional(),
  qc_checklist_qc_id: optionalId.optional(),
  // Optional standard costs per unit, added on top of the rolled-up material cost when
  // set. Stored in the item's `attributes` JSON (std_labor_cost / std_overhead_cost).
  // Absent = leave unchanged; null = clear.
  std_labor_cost: z.coerce.number().min(0).max(1e12).optional().nullable(),
  std_overhead_cost: z.coerce.number().min(0).max(1e12).optional().nullable(),
});

/** PATCH /api/finished-products/:id/checklist — assign (or clear, via null) one stage's
    checklist without touching the rest of the BOM/costs. stage: 1 = QC, 2 = QA. */
export const assignChecklistSchema = z.object({
  stage: z.coerce.number().int().min(1).max(2),
  checklist_id: optionalId,
});

/** POST /api/finished-products/:id/units/allocate — sell or relocate in-stock units.
    Provide either explicit `unit_ids` (serialized) or a `quantity` of bulk units. */
export const allocateUnitsSchema = z
  .object({
    action: z.enum(['sell', 'move']),
    build_mode: z.enum(['assembled', 'semi_built']).default('assembled'),
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
const jobOrderDate = trimmed.regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional().nullable();

export const createJobOrderSchema = z.object({
  product_item_id: z.coerce.number().int().positive(),
  qty_ordered: z.coerce.number().int().positive('Quantity to build must be at least 1'),
  build_mode: z.enum(['assembled', 'semi_built']).default('assembled'),
  order_id: optionalId,
  source_location_id: optionalId,
  output_location_id: optionalId,
  qc_stages: z.coerce.number().int().min(0).max(2).default(0),
  team_id: optionalId,
  planned_start: jobOrderDate,
  due_date: jobOrderDate,
  priority: z.coerce.number().int().min(0).max(9).optional(),
  work_center: trimmed.max(80).optional().nullable(),
  notes: optionalText,
});

export const updateJobOrderSchema = z.object({
  qty_ordered: z.coerce.number().int().positive().optional(),
  source_location_id: optionalId,
  output_location_id: optionalId,
  qc_stages: z.coerce.number().int().min(0).max(2).optional(),
  team_id: optionalId,
  planned_start: jobOrderDate,
  due_date: jobOrderDate,
  priority: z.coerce.number().int().min(0).max(9).optional(),
  work_center: trimmed.max(80).optional().nullable(),
  notes: optionalText,
});

// ---- Production teams ----
export const productionTeamSchema = z.object({
  name: trimmed.min(1, 'Give the team a name').max(120),
  notes: trimmed.max(1000).optional().nullable(),
  is_active: boolish.optional(),
});

export const teamMemberSchema = z.object({
  employee_id: z.coerce.number().int().positive(),
  role: trimmed.max(60).optional().nullable(),
});

export const productionCapacitySchema = z.object({
  daily_capacity: z.coerce.number().int().min(0).max(1_000_000),
});

export const jobOrderComponentsSchema = z.object({
  components: z
    .array(
      z.object({
        component_item_id: z.coerce.number().int().positive(),
        qty_planned: z.coerce.number().int().min(0),
        // Given only for a line that isn't already on the job order (an ad-hoc add on a
        // draft). Defaults to qty_planned spread over the ordered quantity server-side.
        qty_per_unit: z.coerce.number().int().min(0).optional(),
      })
    )
    .max(200),
});

/** POST /job-orders/:id/accept — the production lead confirms the parts kit arrived.
 *  notes: optional remarks about the handover (e.g. a part swapped for an equivalent). */
export const acceptJobOrderSchema = z.object({
  notes: trimmed.max(500).optional().nullable(),
});
/** Approval signs the reviewed draft; live stock can still change independently. */
export const approveJobOrderSchema = acceptJobOrderSchema.extend({
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const jobOrderProgressSchema = z
  .object({
    done_delta: z.coerce.number().int().min(0).default(0),
    scrapped_delta: z.coerce.number().int().min(0).default(0),
    // Serialized job orders only: give this progress entry a batch/lot label. A
    // non-serialized job order always batches each progress entry automatically.
    batch_label: trimmed.max(80).optional().nullable(),
    // Why the units were scrapped (mobile scrap screen) — kept on each scrapped unit's remarks.
    reason: trimmed.max(300).optional().nullable(),
  })
  .refine((d) => d.done_delta + d.scrapped_delta > 0, 'Enter a finished or scrapped quantity');

/** POST /api/job-orders/:id/units — add one serialized unit "off the line" with its
    identifier captured at creation (required). See job-orders.routes.ts for why this is
    separate from jobOrderProgressSchema's bulk done_delta. batch_label is optional —
    same grouping label a bulk progress entry used to take, just applied one unit at a
    time (repeat calls with the same label add to that job order's open batch of it). */
// ---- Job-order parts release (warehouse) + floor tools ----

const idList = z.array(z.coerce.number().int().positive()).min(1, 'Pick at least one job order').max(200);

/** POST /job-orders/warehouse-accept — take on one or more approved drafts. */
export const jobOrderIdsSchema = z.object({ job_order_ids: idList });

/** POST /job-orders/prepare — picked quantities for one or more job orders. Leaving `lines`
 *  out picks that job order's whole planned kit. */
export const prepareJobOrdersSchema = z.object({
  job_orders: z.array(z.object({
    id: z.coerce.number().int().positive(),
    lines: z.array(z.object({
      component_item_id: z.coerce.number().int().positive(),
      qty_picked: z.coerce.number().int().min(0),
    })).optional(),
  })).min(1, 'Pick at least one job order').max(200),
});

/** POST /job-orders/:id/release — issuing the parts release slip. */
export const releaseJobOrderSchema = z.object({
  received_by: trimmed.max(160).optional().nullable(),
  notes: optionalText,
});

export const pauseJobOrderSchema = z.object({
  reason: trimmed.max(500).optional().nullable(),
});

const ISSUE_SEVERITIES = ['low', 'normal', 'high', 'critical'] as const;
export const createProductionIssueSchema = z.object({
  job_order_id: z.coerce.number().int().positive(),
  unit_id: z.coerce.number().int().positive().optional().nullable(),
  category: trimmed.min(1, 'Pick what the issue is about').max(80),
  severity: z.enum(ISSUE_SEVERITIES).optional(),
  description: trimmed.min(1, 'Describe the issue').max(4000),
});
export const updateProductionIssueSchema = z.object({
  unit_id: z.coerce.number().int().positive().optional().nullable(),
  category: trimmed.min(1).max(80).optional(),
  severity: z.enum(ISSUE_SEVERITIES).optional(),
  description: trimmed.min(1).max(4000).optional(),
});
export const resolveProductionIssueSchema = z.object({
  resolution: trimmed.max(2000).optional().nullable(),
});

export const addUnitSchema = z.object({
  identifier: trimmed.min(1, 'An identifier is required for each unit').max(120),
  batch_label: trimmed.max(80).optional().nullable(),
});

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
  // Mobile V2 inspection (Figma 69:* / 72:*): Pass / Issue / Not applicable per item, and the
  // reading for a measurement item (e.g. battery voltage). A required item counts only as 'pass'.
  status: z.enum(['pass', 'issue', 'na']).optional(),
  value: trimmed.max(60).optional().nullable(),
});

export const inspectUnitsSchema = z
  .object({
    unit_ids: z.array(z.coerce.number().int().positive()).min(1).max(500),
    result: z.enum(['pass', 'fail']),
    remarks: trimmed.max(2000).optional().nullable(),
    identifier: unitIdentifier,
    checklist: z.array(checklistResultSchema).max(60).optional(),
    // Required on a fail: what to do with the unit. 'repair' sends it to rework;
    // the others are terminal (the unit counts as scrapped).
    // 'hold' (final / QA pass only): held for review; decided later via /units/:unitId/hold-decision.
    disposition: z.enum(['scrap', 'dispose', 'recycle', 'repair', 'hold']).optional(),
    // Evidence photos already uploaded as `attachments` kind 'qc_unit' on the unit(s); the phone app
    // and desktop must send at least one per failed unit; dedicated inspectors need this
    // even when an API caller omits X-Client.
    evidence_ids: z.array(z.coerce.number().int().positive()).max(60).optional(),
    // With disposition 'repair': the structured repair / rectification order (the remarks
    // carry the instruction). Kept per QC record in qc_repair_details.
    repair: z.object({
      category: trimmed.max(120).optional().nullable(),
      station: trimmed.max(120).optional().nullable(),
      priority: trimmed.max(40).optional().nullable(),
    }).optional(),
  })
  .refine((v) => v.result !== 'fail' || !!v.disposition, {
    message: 'Pick what to do with the failed unit (scrap / dispose / recycle / repair / hold)',
    path: ['disposition'],
  });

/** POST /job-orders/:id/units/:unitId/hold-decision — release a unit QA held for review. */
export const holdDecisionSchema = z.object({
  expected_hold_record_id: z.coerce.number().int().positive().optional(),
  outcome: z.enum(['pass', 'rectify', 'fail']),
  checklist: z.array(checklistResultSchema).max(60).optional(),
  disposition: z.enum(['scrap', 'dispose', 'recycle']).optional(),
  remarks: trimmed.min(3, 'Give the reason for the decision').max(2000),
  repair: z.object({
    category: trimmed.max(120).optional().nullable(),
    station: trimmed.max(120).optional().nullable(),
    priority: trimmed.max(40).optional().nullable(),
  }).optional(),
});

/** POST /job-orders/:id/products-in — one receipt can combine passed units and bulk batches.
    The singular batch fields remain supported for existing mobile clients. */
export const productsInSchema = z
  .object({
    received_date: trimmed.max(40).optional().nullable(),
    location_id: z.coerce.number().int().positive('Pick the location stock is received into'),
    notes: optionalText,
    unit_ids: z.array(z.coerce.number().int().positive()).max(500).optional(),
    batch_id: z.coerce.number().int().positive().optional(),
    quantity: z.coerce.number().int().positive().optional(),
    batches: z.array(z.object({ batch_id: z.coerce.number().int().positive(), quantity: z.coerce.number().int().positive() })).max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.batch_id == null) !== (v.quantity == null)) ctx.addIssue({ code: 'custom', message: 'Batch and quantity must be supplied together' });
    if (v.batch_id != null && v.batches?.length) ctx.addIssue({ code: 'custom', message: 'Use either batch_id or batches' });
    if (!v.unit_ids?.length && v.batch_id == null && !v.batches?.length) ctx.addIssue({ code: 'custom', message: 'Select at least one unit or batch' });
    if (new Set(v.unit_ids ?? []).size !== (v.unit_ids ?? []).length) ctx.addIssue({ code: 'custom', message: 'A unit can only appear once in a receipt' });
    if (new Set((v.batches ?? []).map(b => b.batch_id)).size !== (v.batches ?? []).length) ctx.addIssue({ code: 'custom', message: 'A batch can only appear once in a receipt' });
  });

// ---- Repair / rework parts requests (src/routes/production.routes.ts) ----
const repairFault = z.enum(['assembler', 'production', 'supplier', 'wear', 'other']);

export const repairRequestSchema = z.object({
  kind: z.enum(['add', 'replace']),
  component_item_id: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive().max(9999).default(1),
  fault: repairFault.optional().nullable(),
  // replace only — book the removed part into its damage twin (default yes).
  return_to_damage: boolish.default(true),
  notes: trimmed.max(1000).optional().nullable(),
});

export const repairAcceptSchema = z.object({
  from_location_id: optionalId,
  warehouse_remarks: trimmed.max(1000).optional().nullable(),
  // Exact-request rule (mobile Parts clerk, 83:206): when given, the scanned label must be the
  // requested item's SKU and the picked quantity must equal the requested quantity.
  scanned_code: trimmed.max(120).optional().nullable(),
  picked_quantity: z.coerce.number().int().positive().max(9999).optional(),
});

/** Parts clerk proposes a different part and/or quantity; someone else approves it. */
export const repairRevisionSchema = z.object({
  component_item_id: optionalId,
  quantity: z.coerce.number().int().positive().max(9999),
  reason: trimmed.min(1, 'Give the revision reason').max(1000),
});

export const repairRevisionDecisionSchema = z.object({
  approve: z.boolean(),
  note: trimmed.max(1000).optional().nullable(),
});

export const repairShortageSchema = z.object({
  note: trimmed.max(1000).optional().nullable(),
});

export const repairRejectSchema = z.object({
  warehouse_remarks: trimmed.min(1, 'Say why the request is rejected').max(1000),
});

// ---- Production batches / lots ----
export const createBatchSchema = z.object({
  job_order_id: optionalId,
  product_item_id: optionalId,
  qty: z.coerce.number().int().min(0).max(1_000_000).default(0),
  identifier: trimmed.max(80).optional().nullable(),
  notes: trimmed.max(1000).optional().nullable(),
});

export const updateBatchSchema = z.object({
  identifier: trimmed.max(80).optional().nullable(),
  notes: trimmed.max(1000).optional().nullable(),
  status: z.enum(['open', 'released', 'closed']).optional(),
});

export const batchInspectSchema = z
  .object({
    result: z.enum(['pass', 'fail']),
    disposition: z.enum(['scrap', 'dispose', 'recycle', 'repair']).optional(),
    remarks: trimmed.max(2000).optional().nullable(),
    checklist: z.array(checklistResultSchema).max(60).optional(),
  })
  .refine((v) => v.result !== 'fail' || !!v.disposition, {
    message: 'Pick what happens to the batch on a fail',
    path: ['disposition'],
  });

/** POST/PUT /api/qc/checklists/:id — one named, reusable QC/QA checklist. Belongs to one
    stage as a whole: 1 = QC (first pass), 2 = QA (final pass). */
export const qcChecklistSchema = z.object({
  name: trimmed.min(1, 'Give the checklist a name').max(120),
  stage: z.coerce.number().int().min(1).max(2).default(1),
  is_default: boolish.default(false),
  items: z
    .array(
      z.object({
        label: trimmed.min(1, 'Each check needs a label').max(200),
        required: boolish.default(false),
        // Optional: the step this check belongs to (mobile shows one step per group, in order)
        // and, for a measurement, its unit (e.g. 'V') — the inspector records a reading.
        group: trimmed.max(80).optional().nullable(),
        measure: trimmed.max(20).optional().nullable(),
        hint: trimmed.max(160).optional().nullable(),
      })
    )
    .max(60, 'Keep the checklist under 60 items'),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    const key = item.label.trim().toLocaleLowerCase();
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['items', index, 'label'], message: 'Checklist labels must be unique within a stage' });
    seen.add(key);
  });
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
  build_mode: z.enum(['assembled', 'semi_built']).default('assembled'),
});

/** Report damaged stock: moves `quantity` units out of the item into its "damage twin"
    (a copy row with category 'Damage'). See POST /api/inventory/:id/damage. */
export const damageStockSchema = z.object({
  quantity: z.coerce.number().int().positive('Quantity must be a positive whole number'),
  reason: optionalText,
  location_id: optionalId, // defaults server-side to the default location
  build_mode: z.enum(['assembled', 'semi_built']).default('assembled'),
});

/** Close a stock discrepancy (an offline stock-out accepted beyond recorded stock, D1 in
    docs/OFFLINE-FIRST.md): what the supervisor found / did. See
    POST /api/inventory/discrepancies/:id/resolve. */
export const resolveDiscrepancySchema = z.object({
  note: z.string().trim().min(1, 'Say what was found or done (e.g. counted, adjusted to 12)').max(500),
});

/** Draft purchase orders for items at/under their reorder level. `item_ids` restricts to
    a chosen set (else every low-stock item); `multiplier` sets the top-up target as a
    multiple of each item's reorder level (default 2×). See POST /api/inventory/reorder-po. */
export const reorderPoSchema = z.object({
  item_ids: z.array(z.coerce.number().int().positive()).max(2000).optional(),
  multiplier: z.coerce.number().min(1).max(20).optional(),
});

// ---- Messages ----
export const sendMessageSchema = z.object({
  recipient_id: z.coerce.number().int().positive('Recipient is required'),
  subject: trimmed.max(200).optional().nullable(),
  body: trimmed.max(5000).default(''),
  reply_to_id: z.coerce.number().int().positive().optional(),
});

export const editMessageSchema = z.object({
  body: trimmed.min(1, 'Message body is required').max(5000),
});

/** A single emoji grapheme (allows a short cluster for skin-tone/ZWJ variants), not
    arbitrary text — this becomes a `message_reactions.emoji` value. */
export const reactSchema = z.object({
  emoji: trimmed.min(1, 'Emoji is required').max(8),
});

// ---- Personal tools (notes / tasks / bookmarks) ----
export const checklistItemSchema = z.object({ id: trimmed.min(1).max(80), text: trimmed.min(1).max(500), done: z.boolean() });
export const noteSchema = z.object({
  title: trimmed.max(200).optional().nullable(),
  body: trimmed.max(20000).default(''),
  checklist: z.array(checklistItemSchema).max(200).optional()
    .refine(items => !items || new Set(items.map(i => i.id)).size === items.length, 'Checklist IDs must be unique'),
}).refine(v => !!v.body || !!v.checklist?.length, 'Add a note or a checklist item');
export const scheduleNoteSchema = z.object({
  due_date: trimmed.refine(v => /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?$/.test(v) && realCalendarDate.safeParse(v.slice(0, 10)).success && (!v.slice(11) || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v.slice(11))), 'Choose a valid due date and time'),
  remind_at: z.string().datetime({ offset: true }).optional().nullable(),
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

// ---- Bug reports (in-app bug reporting; see src/routes/bug-reports.routes.ts) ----
export const createBugReportSchema = z.object({
  title: trimmed.min(1, 'Title is required').max(200),
  steps_to_reproduce: trimmed.min(1, 'Steps to reproduce are required').max(4000),
  description: trimmed.max(4000).optional().nullable(),
  page_context: trimmed.max(200).optional().nullable(),
});

export const updateBugReportSchema = z.object({
  status: z.enum(['open', 'resolved']),
});

// ---- Employee self-service profile (see src/modules/hr/employee-profile.ts) ----
/** Blank → null; otherwise a Philippine mobile number (09xxxxxxxxx / +639xxxxxxxxx / 639…),
 *  normalized to +639xxxxxxxxx, or any other international number written with a leading +. */
const phoneOpt = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().trim().max(24).transform((s, ctx) => {
    const digits = s.replace(/[\s().-]/g, '');
    let m: RegExpExecArray | null;
    if ((m = /^(?:\+?63|0)(9\d{9})$/.exec(digits))) return '+63' + m[1];
    if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
    ctx.addIssue({ code: 'custom', message: 'Enter a mobile number like 0917 123 4567 or +63 917 123 4567' });
    return z.NEVER;
  }).optional().nullable()
);
const blankToNull = (max: number) => z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  trimmed.max(max).optional().nullable()
);
export const selfProfileSchema = z.object({
  // Re-authentication: floor phones get shared, so a contact/emergency change needs the password.
  current_password: z.string().min(1, 'Enter your current password to save changes').max(200),
  preferred_name: blankToNull(60),
  mobile_phone: phoneOpt,
  personal_email: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().toLowerCase().email('Enter a valid email').max(160).optional().nullable()
  ),
  home_address: blankToNull(500),
  emergency_contact_name: blankToNull(120),
  emergency_contact_relation: blankToNull(60),
  emergency_contact_phone: phoneOpt,
}).strict(); // unknown keys (e.g. name, position, daily_rate) are rejected, not silently ignored

// ---- Confidential (anonymous) reports (see src/core/confidential-reports.ts) ----
export const REPORT_STATUSES = ['new', 'triaged', 'investigating', 'resolved', 'closed'] as const;
export const REPORT_CATEGORIES = [
  'Workplace concern', 'Harassment or misconduct', 'Safety risk', 'Payroll or attendance',
  'Equipment or facility', 'Stock or operations', 'System support', 'Other',
] as const;
const isoDateOpt = z.preprocess(
  (v) => (v === '' ? null : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date').optional().nullable()
);
export const anonymousReportSchema = z.object({
  ticket: trimmed.min(10, 'Submission ticket missing').max(200),
  category: z.enum(REPORT_CATEGORIES, { message: 'Choose a category' }),
  subject: trimmed.max(160).optional().nullable(),
  description: trimmed.min(10, 'Describe the concern (at least 10 characters)').max(5000),
  incident_date: isoDateOpt,
  location: trimmed.max(160).optional().nullable(),
});
export const anonymousLookupSchema = z.object({
  number: trimmed.min(1, 'Enter the report number').max(20),
  access_code: trimmed.min(10, 'Enter the access code').max(40),
});
export const anonymousPhotoSchema = anonymousLookupSchema.extend({
  photo_id: z.coerce.number().int().positive('Choose a photo'),
});
export const anonymousFollowupSchema = anonymousLookupSchema.extend({
  body: trimmed.min(1, 'Write a message').max(3000),
});
export const confidentialStatusSchema = z.object({
  status: z.enum(REPORT_STATUSES),
});
export const confidentialReplySchema = z.object({
  body: trimmed.min(1, 'Write a message').max(3000),
});

// ---- Documents: orders + templates ----
const numCoerce = z.coerce.number();

const orderItemSchema = z.object({
  item_id: optionalId,
  fulfillment_mode: z.enum(['assembled', 'semi_built', 'ckd']).default('assembled'),
  name: trimmed.min(1, 'Line item name is required').max(200),
  sku: optionalText,
  description: optionalText,
  quantity: numCoerce.positive('Quantity must be greater than zero').max(Number.MAX_SAFE_INTEGER, 'Quantity is too large').default(1),
  unit: trimmed.max(40).optional().nullable(),
  unit_price: numCoerce.min(0, 'Price cannot be negative').default(0),
  tax_code_id: optionalId,   // per-line VAT classification for mixed-rate documents
});

const orderDate = z.preprocess(
  (v) => v === '' ? null : v,
  z.iso.date('Enter a valid date (YYYY-MM-DD)').optional().nullable()
);

const orderFields = {
  customer_name: optionalText,
  customer_contact: optionalText,
  customer_id: optionalId,
  location_id: optionalId,   // sale orders: ship-from location for stock draw-down + COGS
  tax_code_id: optionalId,
  order_date: orderDate,
  status: trimmed.max(40).optional().nullable(),
  notes: optionalText,
  currency: z.preprocess((v) => typeof v === 'string' && !v.trim() ? null : v,
    trimmed.regex(/^[A-Za-z]{3}$/, 'Use a three-letter currency code, such as PHP').transform((v) => v.toUpperCase()).optional().nullable()),
  tax_percent: numCoerce.min(0).max(100).default(0),
  items: z.array(orderItemSchema).min(1, 'Add at least one line item').max(300),
  // Purchase orders: which supplier + expected delivery date.
  supplier_id: optionalId,
  expected_date: orderDate,
  // Sale orders: override the stock-availability gate when moving to a firm status
  // (approve / confirm / complete) — creates an explicit backorder.
  force: boolish.optional(),
};

export const createOrderSchema = z.object({
  type: z.enum(['sale', 'job', 'purchase']),
  ...orderFields,
});

export const updateOrderSchema = z.object(orderFields).extend({
  items: z.array(orderItemSchema).min(1, 'Add at least one line item').max(300).optional(),
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid order revision').optional(),
});

// ---- Sale-order status-only change (no line-item body) — used by the delivery→fulfil
// prompt and any "just advance the order" action. Runs the same availability gate. ----
export const shortfallActionSchema = z.object({
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid order revision').optional(),
});
export const orderStatusSchema = shortfallActionSchema.extend({
  status: trimmed.min(1).max(40),
  force: boolish.optional(),
});

// ---- Sale-order release (warehouse scans goods out against an approved SO) ----
export const releaseOrderSchema = z
  .object({
    // Serialized finished units — by id and/or by scanned QR-label text (identifier).
    unit_ids: z.array(z.coerce.number().int().positive()).max(2000).optional(),
    codes: z.array(trimmed.min(1).max(120)).max(2000).optional(),
    // Non-serialized (bulk) lines — { item_id, quantity } to add to that line's released_qty.
    bulk: z.array(z.object({
      item_id: z.coerce.number().int().positive(),
      quantity: numCoerce.positive().max(1_000_000),
    })).max(300).optional(),
  })
  .refine((v) => (v.unit_ids?.length || v.codes?.length || v.bulk?.length), {
    message: 'Scan or enter something to release',
  });

export const unreserveOrderSchema = z.object({
  unit_ids: z.array(z.coerce.number().int().positive()).max(2000).optional(),
  bulk: z.array(z.object({
    item_id: z.coerce.number().int().positive(),
    quantity: numCoerce.positive().max(1_000_000),
  })).max(300).optional(),
}).refine((v) => (v.unit_ids?.length || v.bulk?.length), {
  message: 'Choose an allocated unit or quantity to undo',
});

// Issuing a release slip — who physically collected the goods, and the vehicle they left in.
export const releaseSlipSchema = z.object({
  collected_by: trimmed.min(1, 'Enter who collected the goods').max(160),
  vehicle_plate: optionalText,
  notes: optionalText,
  // Warehouse-out rules (modules/inventory/release-auth.ts): the token the recipient presents,
  // each package item confirmed, the seal / tag, the handoff area and the recipient's acknowledgement.
  authorization_token: trimmed.max(40).optional().nullable(),
  package: z.array(z.object({
    item_id: z.coerce.number().int().positive(),
    label: trimmed.min(1).max(120),
    ok: z.boolean(),
  })).max(300).optional(),
  seal_tag: trimmed.max(80).optional().nullable(),
  handoff_area: trimmed.max(80).optional().nullable(),
  acknowledged: z.boolean().optional(),
  // Handoff photos uploaded first as `attachments` kind 'release_proof' on the order; the slip
  // takes them over. The phone and desktop apps must send at least one (isAppClient).
  evidence_ids: z.array(z.coerce.number().int().positive()).max(20).optional(),
});

/** Releaser asks a supervisor to release without the token the recipient can't present. */
export const releaseOverrideRequestSchema = z.object({
  reason: trimmed.min(5, 'Say why the token can’t be presented').max(500),
});

/** A supervisor (inventory.adjust) approves or declines releasing without the token — with a reason. */
export const releaseOverrideDecisionSchema = z.object({
  approve: z.boolean().default(true),
  reason: trimmed.min(5, 'Give the reason for the override').max(500),
});

/** Sales issues who may receive an order's goods (release-auth.ts). */
export const releaseAuthorizationSchema = z.object({
  mode: z.enum(['pickup', 'delivery']),
  recipient_name: trimmed.min(1, 'Enter the approved recipient').max(120),
  // Only the last 4 characters are kept — never the full ID number.
  id_reference: trimmed.max(40).optional().nullable(),
  valid_hours: z.coerce.number().min(1).max(24 * 14).default(24),
  handoff_area: trimmed.max(80).optional().nullable(),
  partial_allowed: z.boolean().optional(),
  notes: optionalText,
});

export const revokeReleaseAuthorizationSchema = z.object({
  reason: trimmed.min(1, 'Give a reason').max(300),
});

export const releaseReportSchema = z.object({
  kind: z.enum(['authorization', 'identity', 'unit_mismatch', 'package_missing', 'partial_request', 'other']),
  description: trimmed.min(1, 'Describe the problem').max(1500),
  unit_identifier: trimmed.max(120).optional().nullable(),
});

export const resolveReleaseReportSchema = z.object({
  resolution: trimmed.max(1000).optional().nullable(),
});

/** A finished product's package checklist (what leaves with each unit). */
export const packageItemsSchema = z.object({
  items: z.array(z.object({
    label: trimmed.min(1).max(120),
    required: z.boolean().default(true),
  })).max(40),
});

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
  tax_code_id: optionalId,   // per-line VAT classification for mixed-rate documents
});

export const vendorBillSchema = z.object({
  vendor_ref: trimmed.max(80).optional().nullable(),
  bill_date: trimmed.max(40).optional().nullable(),
  due_date: trimmed.max(40).optional().nullable(),
  currency: trimmed.max(10).optional().nullable(),
  tax_percent: numCoerce.min(0).max(100).default(0),
  tax_code_id: optionalId,
  ewt_rate: numCoerce.min(0).max(100).default(0),
  ewt_atc: trimmed.max(20).optional().nullable(),
  ewt_amount: numCoerce.min(0).optional(),   // omitted -> computed from ewt_rate on the net
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

// PUT /api/accounting/statutory-deductions — per-employee statutory-deduction switches.
export const statutoryDeductionsSchema = z.object({
  updates: z.array(z.object({
    employee_id: z.coerce.number().int().positive(),
    deduct_sss: boolish.optional(),
    deduct_philhealth: boolish.optional(),
    deduct_pagibig: boolish.optional(),
    deduct_withholding_tax: boolish.optional(),
    contribution_basis: z.enum(['actual', 'fixed']).optional(),
  })).min(1).max(2000),
});

// ---- Petty cash ----
export const pettyCashFundSchema = z.object({
  name: trimmed.min(1, 'Fund name is required').max(120),
  custodian: trimmed.max(120).optional().nullable(),
  location_id: optionalId,
  opening_balance: numCoerce.min(0).default(0),
  currency: trimmed.max(10).optional().nullable(),
  active: boolish.optional(),
  notes: optionalText,
});

export const pettyCashEntrySchema = z.object({
  entry_date: trimmed.regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  direction: z.enum(['in', 'out']),
  amount: numCoerce.positive('Amount must be greater than 0'),
  category: trimmed.max(80).optional().nullable(),
  counterparty: trimmed.max(160).optional().nullable(),
  reference_no: trimmed.max(80).optional().nullable(),
  notes: optionalText,
});

// ---- General ledger (Phase 0) ----
export const ledgerSetupSchema = z.object({
  fiscal_year_start: trimmed.regex(/^\d{4}-\d{2}-\d{2}$/, 'Fiscal year start must be YYYY-MM-DD'),
  base_currency: trimmed.min(3).max(3).default('PHP'),
});

export const accountSchema = z.object({
  code: trimmed.min(1, 'Account code is required').max(20),
  name: trimmed.min(1, 'Account name is required').max(140),
  root_type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
  account_type: trimmed.max(40).optional().nullable(),
  parent_id: optionalId,
  is_group: boolish.default(false),
  currency: trimmed.max(10).optional().nullable(),
  description: optionalText,
  archived: boolish.optional(),
});

const journalLineSchema = z.object({
  account_id: z.coerce.number().int().positive(),
  debit: numCoerce.min(0).default(0),
  credit: numCoerce.min(0).default(0),
  party_type: z.enum(['customer', 'supplier', 'employee']).optional().nullable(),
  party_id: optionalId,
  memo: trimmed.max(300).optional().nullable(),
});

export const journalEntrySchema = z.object({
  entry_date: trimmed.regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  book: z.enum(['general', 'sales', 'purchase', 'cash_receipts', 'cash_disbursements', 'payroll']).default('general'),
  memo: optionalText,
  reference: trimmed.max(120).optional().nullable(),
  lines: z.array(journalLineSchema).min(2, 'A journal entry needs at least two lines').max(200),
});

export const glPeriodSchema = z.object({
  name: trimmed.min(1).max(60),
  start_date: trimmed.regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: trimmed.regex(/^\d{4}-\d{2}-\d{2}$/),
});

// ---- Payments (Phase 1b): money in from a customer / out to a supplier ----
const paymentAllocationSchema = z.object({
  doc_type: z.enum(['sale_order', 'vendor_bill']),
  doc_id: z.coerce.number().int().positive(),
  amount: numCoerce.positive(),
});

export const paymentSchema = z.object({
  direction: z.enum(['in', 'out']),
  party_type: z.enum(['customer', 'supplier']),
  party_id: optionalId,
  party_name: trimmed.max(200).optional().nullable(),
  payment_date: trimmed.regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  amount: numCoerce.positive('Amount must be greater than zero'),
  method: trimmed.max(40).optional().nullable(),
  reference: trimmed.max(120).optional().nullable(),
  deposit_account_id: z.coerce.number().int().positive(),
  memo: optionalText,
  allocations: z.array(paymentAllocationSchema).max(200).optional(),
});

// ---- Credit / debit notes (Phase 1b): sales / purchase returns & allowances ----
export const creditNoteSchema = z.object({
  kind: z.enum(['customer', 'supplier']),
  party_id: optionalId,
  party_name: trimmed.max(200).optional().nullable(),
  note_date: trimmed.regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  source_doc_type: z.enum(['sale_order', 'vendor_bill']).optional().nullable(),
  source_doc_id: optionalId,
  tax_code_id: optionalId,
  reason: optionalText,
  subtotal: numCoerce.min(0).default(0),
  tax_amount: numCoerce.min(0).default(0),
});

// A physical customer return is one slip line per receipt. Serialised receipts
// identify the exact shipped unit; inspection alone can put it back on hand.
export const salesReturnReceiveSchema = z.object({
  slip_id: z.coerce.number().int().positive(),
  slip_item_id: z.coerce.number().int().positive(),
  quantity: numCoerce.positive(),
  unit_id: optionalId,
  reason: trimmed.min(5).max(500),
  evidence_ids: z.array(z.coerce.number().int().positive()).min(1).max(12),
});
export const salesReturnInspectSchema = z.object({
  decision: z.enum(['restock', 'reject']),
  condition_note: trimmed.min(5).max(500),
  location_id: optionalId,
});
export const salesReturnDispositionSchema = z.object({
  decision: z.enum(['repair', 'salvage', 'dispose']),
  note: trimmed.min(5).max(500),
  location_id: optionalId,
});
export const salesReturnRepairCompleteSchema = z.object({
  note: trimmed.min(5).max(500),
});
export const salesReturnReinspectSchema = salesReturnInspectSchema;
export const salesReturnCreditLinkSchema = z.object({
  credit_note_id: z.coerce.number().int().positive(),
});

// ---- Tax codes (Phase 2): VAT / withholding classifications ----
export const taxCodeSchema = z.object({
  code: trimmed.min(1, 'Code is required').max(20),
  name: trimmed.min(1, 'Name is required').max(80),
  kind: z.enum(['output_vat', 'input_vat', 'exempt', 'zero_rated', 'ewt']),
  rate: numCoerce.min(0).max(100).default(0),
  account_id: optionalId,
  atc: trimmed.max(20).optional().nullable(),
  active: boolish.optional(),
});

// ---- Auto-posting rules (Phase 1): which account each posted amount lands on ----
export const postingRulesSchema = z.object({
  ar_account_id: optionalId,
  sales_income_account_id: optionalId,
  output_vat_account_id: optionalId,
  ap_account_id: optionalId,
  purchase_expense_account_id: optionalId,
  input_vat_account_id: optionalId,
  sales_returns_account_id: optionalId,
  ewt_payable_account_id: optionalId,
  payroll_expense_account_id: optionalId,
  payroll_er_contrib_account_id: optionalId,
  sss_payable_account_id: optionalId,
  philhealth_payable_account_id: optionalId,
  pagibig_payable_account_id: optionalId,
  withholding_tax_payable_account_id: optionalId,
  net_pay_payable_account_id: optionalId,
  employee_advance_account_id: optionalId,
  inventory_asset_account_id: optionalId,
  wip_account_id: optionalId,
  mfg_variance_account_id: optionalId,
  grir_clearing_account_id: optionalId,
  cogs_account_id: optionalId,
});

export const matchToleranceSchema = z.object({
  price_pct: numCoerce.min(0).max(100).default(2),
  price_abs: numCoerce.min(0).default(0),
  qty_pct: numCoerce.min(0).max(100).default(0),
});

export const templateSchema = z.object({
  studio_version: z.number().int().nonnegative().optional(),
  expected_revision: trimmed.regex(/^[a-f0-9]{64}$/).optional(),
  source_template_id: optionalId,
  source_revision: trimmed.regex(/^[a-f0-9]{64}$/).optional(),
  name: trimmed.min(1, 'Template name is required').max(120),
  type: z.enum(['sale', 'job', 'purchase', 'generic']).default('generic'),
  period: trimmed.max(60).optional().nullable(),
  body: trimmed.min(1, 'Template body cannot be empty').max(5000000).refine((body) => {
    const content = body.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    return !!content.replace(/<[^>]+>/g, '').replace(/&nbsp;|\s/g, '') || /<(?:img|table|hr)\b|class=["'][^"']*doc-float/i.test(content);
  }, 'Template body cannot be empty'),
  // N-up print tiling (SCHEMA_VERSION 30/32) — the template editor shows these as Grid Rows /
  // Grid Columns / Fill mode. Both grid dimensions default to 1 (today's plain
  // one-record-per-page behavior). Capped at 6 each and 12 combined — past that a real page
  // layout (columns/rows this small) stops being legible anyway.
  copies_per_record: intCoerce.min(1).max(6).default(1), // grid rows
  records_per_page: intCoerce.min(1).max(6).default(1), // grid columns
  // 'blank' (default): unfilled cells stay empty — right when each cell is meant to be a
  // specific record (HR Payroll Slip's "2 employees x 2 copies"). 'repeat': cycle back through
  // the printed records to fill every cell — right for repeating ONE design across its whole
  // grid (print one record as a 3x3 sheet of itself).
  grid_gap_x_mm: z.coerce.number().finite().min(0).max(30).default(6),
  grid_gap_y_mm: z.coerce.number().finite().min(0).max(30).default(6),
  tile_fill: z.enum(['blank', 'repeat']).default('blank'),
  // (SCHEMA_VERSION 35) Continuous tiling: repeat_count is only consulted when tile_continuous
  // is on — copies_per_record/records_per_page then become a fixed page shape instead of the
  // repeat count itself. Capped well above the grid-cell cap (12) since a repeat count isn't
  // bounded by page legibility the way grid dimensions are — it just controls how many pages
  // the continuous stream spans.
  repeat_count: intCoerce.min(1).max(100).default(1),
  tile_continuous: boolish.default(false),
}).refine((v) => v.copies_per_record * v.records_per_page <= 12, {
  message: 'Copies per record × records per page can\'t exceed 12',
  path: ['copies_per_record'],
}).refine(v => !isMultiPageDocument(v.body) || (v.copies_per_record === 1 && v.records_per_page === 1 && !v.tile_continuous), {message: MULTIPAGE_GRID_ERROR, path: ['copies_per_record']});

// ---- Form builder ----

// 'employee' renders as a live dropdown of current employees (never a stale, form-design-time
// options list) — its stored value is still just the employee's name, the same plain string
// convention every other form already relies on (e.g. matching attendance to a form record).
const fieldTypeEnum = z.enum(['text', 'number', 'date', 'time', 'select', 'textarea', 'checkbox', 'employee']);

export const fieldDefSchema = z.object({
  key: trimmed.min(1).max(64).regex(/^[a-z0-9_]+$/, 'Key must be lowercase letters, numbers, or underscores'),
  label: trimmed.min(1).max(120),
  type: fieldTypeEnum,
  required: boolish.default(false),
  options: z.array(trimmed.max(200)).max(100).default([]),
  default: trimmed.max(500).default(''),
});

export const formActionSchema = z.object({
  type: z.enum([
    'notify_employee', 'save_to_201', 'email_employee',
    'notify_hr', 'create_followup_task', 'apply_no_work',
  ]),
  run_on: z.enum(['create', 'approved']).default('create'),
  subject: trimmed.max(200).optional(),
  body: trimmed.max(4000).optional(),
  due_field: trimmed.max(64).optional(),
  title: trimmed.max(200).optional(),
});

export const formDefinitionSchema = z.object({
  expected_version: z.number().int().positive().optional(),
  change_reason: trimmed.max(1000).optional(),
  name: trimmed.min(1, 'Form name is required').max(120),
  slug: trimmed.min(1).max(60).regex(/^[a-z0-9_]+$/, 'Slug must be lowercase letters, numbers, or underscores'),
  number_prefix: trimmed.min(1).max(10).regex(/^[A-Z0-9]+$/, 'Prefix must be uppercase letters or numbers').default('FM'),
  icon: trimmed.max(40).default('file'),
  fields: z.array(fieldDefSchema).max(100).default([]),
  actions: z.array(formActionSchema).max(20).default([]),
  scope: z.enum(['hr', 'inventory', 'admin', 'accounting']).nullable().default(null),
});

export const linkFormTemplateSchema = z.object({
  template_id: z.coerce.number().int().positive().nullable(),
});

// A field value is normally a scalar, but one level of nested scalar-only object is also
// allowed — e.g. hr_payroll's generate-payslips-only `employer_contributions` breakdown
// (never shown/edited in the generic form UI, but round-tripped through {...existing.data,
// otherField} by both that UI and PUT /form-records/:id, so it has to survive validation).
// An array of such flat objects is also allowed — hr_payroll's `other_deductions` (ad-hoc
// Cash Advance / misc deduction lines, [{label, amount}, ...]) — same "generate-payslips-only,
// round-tripped by the generic PUT" reasoning.
const formFieldScalar = z.union([z.string().max(10000), z.number(), z.boolean(), z.null()]);
const formFieldObject = z.record(z.string().max(64), formFieldScalar);
const formFieldValue = z.union([formFieldScalar, formFieldObject, z.array(formFieldObject).max(50), z.string().max(500000)]);
const formRecordData = z.record(z.string().max(64), formFieldValue).superRefine((data, ctx) => {
  for (const [key, value] of Object.entries(data)) if (key !== '_calculation_snapshot' && typeof value === 'string' && value.length > 10000)
    ctx.addIssue({ code: 'custom', path: [key], message: 'Field must not exceed 10000 characters' });
});

export const createFormRecordSchema = z.object({
  expected_definition_version: z.number().int().positive().optional(),
  form_def_id: z.coerce.number().int().positive('Form definition is required'),
  data: formRecordData.default({}),
  status: trimmed.max(40).default('draft'),
});

export const updateFormRecordSchema = z.object({
  expected_revision: z.number().int().positive().optional(),
  change_reason: trimmed.max(1000).optional(),
  data: formRecordData.default({}),
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
  compress_images: boolish.default(true),
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

const employeeStatusEnum = z.enum(['probationary', 'regular', 'suspended', 'resigned', 'terminated']);
const optionalIdText = trimmed.max(40).optional().nullable();
// A fixed peso amount replacing a computed statutory deduction (SSS/PhilHealth/Pag-IBIG/
// withholding tax) for one employee. '' / null / omitted -> null (use the normal computed
// amount) — shared by all four override fields on employeeSchema below.
const optionalOverrideAmount = (label: string) => z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? null : v),
  numCoerce.min(0, `${label} override cannot be negative`).nullable()
).optional();

/** Civil status values on the employee record (PSA categories; "Divorced" covers foreign and
 *  Shari'a divorces recognized in the Philippines). */
export const CIVIL_STATUSES = ['Single', 'Married', 'Widowed', 'Legally separated', 'Annulled', 'Divorced'] as const;

/** Why a birth date can't be right, or null: YYYY-MM-DD, a real calendar date, 1900 or later,
 *  and at least 15 years ago (the minimum working age). */
export function birthDateError(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'Use a YYYY-MM-DD date';
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return 'That date doesn’t exist';
  if (v < '1900-01-01') return 'Birth date is too far in the past';
  const latest = new Date();
  latest.setUTCFullYear(latest.getUTCFullYear() - 15);
  if (v > latest.toISOString().slice(0, 10)) return 'Birth date must be at least 15 years ago';
  return null;
}

const rateEffectiveDate = trimmed.pipe(z.iso.date());

export const employeeSchema = z.object({
  employee_no: trimmed.min(1, 'Employee number is required').max(40),
  name: trimmed.min(1, 'Employee name is required').max(160),
  department_id: optionalId,
  position: trimmed.max(120).optional().nullable(),
  user_id: optionalId,
  // Usual shift — a UI pre-fill only for new Daily Time rows (dailyGridModal), never enforced;
  // any single day can still be set to a different shift, or none, in Time Keeping.
  default_shift_id: optionalId,
  rate_type: z.enum(['daily', 'monthly']).default('daily'),
  daily_rate: numCoerce.min(0, 'Daily rate cannot be negative').default(0),
  monthly_rate: numCoerce.min(0, 'Monthly rate cannot be negative').optional().nullable(),
  // Only used when this save actually changes the effective daily rate — logs it to
  // employee_rate_history instead of just overwriting the flat current value. Not persisted as
  // an employees column. See src/employee-rate-history.ts and hr.routes.ts PUT /employees/:id.
  rate_effective_date: rateEffectiveDate.or(trimmed.length(0)).optional().nullable(),
  rate_change_note: trimmed.max(200).optional().nullable(),
  status: employeeStatusEnum.default('probationary'),
  start_date: trimmed.max(40).optional().nullable(),
  sss_no: optionalIdText,
  philhealth_no: optionalIdText,
  pagibig_no: optionalIdText,
  tin_no: optionalIdText,
  // Omitted ⇒ unchanged on update (CSV import and older clients don't send them); '' ⇒ cleared.
  birth_date: z.preprocess(
    (v) => (v === '' ? null : v),
    trimmed.nullable().superRefine((v, ctx) => {
      const err = v == null ? null : birthDateError(v);
      if (err) ctx.addIssue({ code: 'custom', message: err });
    })
  ).optional(),
  civil_status: z.preprocess(
    (v) => (v === '' ? null : v),
    z.enum(CIVIL_STATUSES, { message: `Civil status must be one of: ${CIVIL_STATUSES.join(', ')}` }).nullable()
  ).optional(),
  leave_days_per_year: numCoerce.min(0).max(366).default(5),
  leave_days_used: numCoerce.min(0).default(0),
  rest_days: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
  // Exempt from late deductions (e.g. the company president) — real lateness still shows on the
  // payslip detail, it just never subtracts pay. See src/hr-payroll-compute.ts.
  late_exempt: boolish.optional(),
  // Exempt from overtime pay entirely — real OT hours still show on the payslip detail, it
  // just never adds pay. See src/hr-payroll-compute.ts.
  ot_exempt: boolish.optional(),
  // Always paid a whole day for any day with both a time-in and a time-out (no half day, late,
  // undertime). Omitted on update ⇒ unchanged. See src/modules/payroll/hr-payroll-compute.ts.
  always_whole_day: boolish.optional(),
  // May time in from anywhere (field staff) — exempt from the office location lock, and may
  // punch without the kiosk QR. Omitted on update ⇒ unchanged. See clock-geofence.ts.
  clock_anywhere: boolish.optional(),
  // Per-employee statutory-deduction switches — the same columns Accounting → Statutory
  // Deductions edits, now also editable straight from the Edit Employee form. Default true
  // (deduct) when omitted, matching how those columns already default in the database.
  deduct_sss: boolish.optional(),
  deduct_philhealth: boolish.optional(),
  deduct_pagibig: boolish.optional(),
  deduct_withholding_tax: boolish.optional(),
  // A fixed peso amount replacing the computed BIR withholding formula for this employee every
  // cutoff, and the same for the three contribution funds (still divided across cutoffs the
  // same way the computed amount is — see computeEmployeeStatutory in hr.routes.ts). Each only
  // takes effect while its matching deduct_* switch above is also on.
  withholding_tax_override: optionalOverrideAmount('Withholding tax'),
  sss_override: optionalOverrideAmount('SSS'),
  philhealth_override: optionalOverrideAmount('PhilHealth'),
  pagibig_override: optionalOverrideAmount('Pag-IBIG'),
  // SSS / Pag-IBIG on the month's actual pay ('actual', the law's default) or on the fixed
  // monthly rate ('fixed', by the employee's written agreement). Omitted on update = unchanged.
  contribution_basis: z.enum(['actual', 'fixed']).optional(),
  photo: z.preprocess(
    (v) => (v === '' ? null : v),
    z.string().max(2_000_000).regex(/^data:image\//, 'Photo must be an image').optional().nullable()
  ),
}).refine(
  (v) => v.rate_type !== 'monthly' || (v.monthly_rate != null && v.monthly_rate > 0),
  { message: 'Monthly rate is required when rate type is monthly', path: ['monthly_rate'] }
);

/** HR → Employees → Edit → Pay → Change rate (POST /api/hr/employees/:id/rate-change). */
export const rateChangeSchema = z.object({
  rate_type: z.enum(['daily', 'monthly']),
  daily_rate: numCoerce.min(0, 'Daily rate cannot be negative').default(0),
  monthly_rate: numCoerce.min(0, 'Monthly rate cannot be negative').optional().nullable(),
  effective_date: rateEffectiveDate,
  note: trimmed.max(200).optional().nullable(),
}).refine(
  (v) => v.rate_type !== 'monthly' || (v.monthly_rate != null && v.monthly_rate > 0),
  { message: 'Monthly rate is required when rate type is monthly', path: ['monthly_rate'] }
).refine(
  (v) => v.rate_type !== 'daily' || v.daily_rate > 0,
  { message: 'Daily rate is required', path: ['daily_rate'] }
);

// ---- HR: Asset issuance (company property issued to an employee) ----
const assetIssuanceLineSchema = z.object({
  asset_name: trimmed.min(1, 'Asset name is required').max(160),
  category: trimmed.max(60).optional().nullable(),
  asset_tag: trimmed.max(80).optional().nullable(),
  quantity: intCoerce.min(1, 'Quantity must be at least 1').max(100_000).default(1),
  condition_on_issue: trimmed.max(60).optional().nullable(),
});

export const createAssetIssuanceSchema = z.object({
  issued_date: trimmed.min(1, 'Issue date is required').max(40),
  notes: optionalText,
  items: z.array(assetIssuanceLineSchema).min(1, 'Add at least one asset').max(100),
});

export const returnAssetItemSchema = z.object({
  status: z.enum(['returned', 'lost', 'damaged']).default('returned'),
  returned_date: trimmed.min(1, 'Return date is required').max(40),
  condition_on_return: trimmed.max(60).optional().nullable(),
  return_notes: optionalText,
});

export const attendancePeriodSchema = z
  .object({
    label: trimmed.min(1, 'Cutoff label is required').max(120),
    start_date: realCalendarDate,
    end_date: realCalendarDate,
  })
  .refine((v) => v.end_date >= v.start_date, {
    message: 'End date must be on or after the start date',
    path: ['end_date'],
  }).refine(v => (Date.parse(v.end_date) - Date.parse(v.start_date)) / 86400000 < 366, 'A cutoff must not exceed 366 days');

const timeOfDay = z.union([trimmed.refine(v => v === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), 'Time must be HH:MM, 24-hour'), z.null()]).optional();
const nullableId = z.coerce.number().int().positive().nullable().optional();

const attendanceDaySchema = z.object({
  work_date: realCalendarDate,
  time_in: timeOfDay,
  // Lunch-break bracket — display-only (payroll subtracts PayrollPolicy.lunch_break_minutes,
  // it never reads these). Split from the raw punches on reconcile, or hand-typed in the grid.
  lunch_out: timeOfDay,
  lunch_in: timeOfDay,
  time_out: timeOfDay,
  notes: optionalText,
  shift_id: nullableId,
  // Legacy single link — still accepted for back-compat. New clients send form_record_ids.
  form_record_id: nullableId,
  // A day can link multiple OT/Half Day/Leave/Undertime/Offset forms. When present this wins
  // over form_record_id; the route also mirrors the first entry back into form_record_id.
  form_record_ids: z.array(z.coerce.number().int().positive()).max(20).optional().nullable(),
  holiday_type: z.enum(['regular', 'special_non_working', 'special_working', 'cancelled_paid', 'cancelled_unpaid', 'none']).nullable().optional(),
  // 'yes'/'no' force this one date on/off as a rest day for this employee; null inherits the
  // weekly rest-day pattern. See attendance_records.rest_day (db.ts, SCHEMA_VERSION 18).
  rest_day: z.enum(['yes', 'no']).nullable().optional(),
  // HR's explicit allow/deny decision on a day under PayrollPolicy.min_work_minutes — see
  // attendance_records.min_hours_decision (db.ts).
  min_hours_decision: z.enum(['allow', 'deny']).nullable().optional(),
  // HR manually crediting this day as a half day (AM or PM) with NO linked Half Day Request
  // backing it — for when the raw times don't happen to match the automatic "possible half
  // day" heuristic but HR knows it was one anyway. Ignored by the payroll engine when a real
  // halfday_request IS linked (that always wins). See attendance_records.half_day_override
  // (db.ts) and hr-payroll-compute.ts's halfDayOverride.
  half_day_override: z.enum(['am', 'pm']).nullable().optional(),
});

export const saveAttendanceSchema = z.object({
  employee_id: z.coerce.number().int().positive('Employee is required'),
  days: z.array(attendanceDaySchema).max(62),
}).refine(v => new Set(v.days.map(d => d.work_date)).size === v.days.length, 'Each attendance date must appear only once');

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
  // 0 (default) = off for both — see PayrollPolicy.ot_grace_minutes / ot_min_minutes.
  ot_grace_minutes: z.coerce.number().int().min(0).max(59).default(0),
  ot_min_minutes: z.coerce.number().int().min(0).max(480).default(0),
  ot_rate_percent: z.coerce.number().min(0).max(1000).default(125),
  require_ot_form: boolish.default(true),
  night_diff_enabled: boolish.default(true),
  night_diff_percent: z.coerce.number().min(0).max(200).default(10),
  night_start: hhmm.default('22:00'),
  night_end: hhmm.default('06:00'),
  monthly_rate_divisor: z.coerce.number().min(1).max(31).default(26),
  pay_frequency: z.enum(['monthly', 'semi_monthly', 'weekly', 'daily']).default('semi_monthly'),
  auto_statutory: boolish.default(true),
  default_rest_days: z.array(z.number().int().min(0).max(6)).max(7).default([0, 6]),
  // Absent = every slot deducts everything (today's always-divide-evenly behavior) — see
  // PayrollPolicy.deduction_schedule (src/types.ts) for the full semantics.
  deduction_schedule: z.array(z.object({
    sss: boolish, philhealth: boolish, pagibig: boolish, withholding_tax: boolish,
  })).max(31).optional(),
  min_work_minutes: z.coerce.number().int().min(0).max(1440).default(0),
  lunch_break_minutes: z.coerce.number().int().min(0).max(480).default(60),
  count_lunch_as_worked: boolish.default(false),
  // false (default) preserves the pre-2026-09 behavior — lunch_out/lunch_in stay record-only.
  count_lunch_late_as_late: boolish.default(false),
  hours_basis: z.enum(['fixed', 'per_hour']).default('fixed'),
  hours_basis_unit: z.enum(['minute', '30min', 'hour']).default('30min'),
  // 0 (default) = off, preserving the pre-existing "any presence at all is a whole day"
  // behavior — same opt-in-by-default safety convention as min_work_minutes above, so
  // upgrading an existing install never silently changes its payroll math. 420 (7 hours) is
  // the company's own suggested value, not baked in as the default.
  whole_day_min_minutes: z.coerce.number().int().min(0).max(1440).default(0),
  // Blank/null (default) = no cap, same "opt-in" safety convention.
  max_ot_hours: z.coerce.number().min(0).max(24).nullable().optional().default(null),
  // 'flat' (default) preserves the pre-2026-09 behavior — same opt-in-by-default safety
  // convention as whole_day_min_minutes/max_ot_hours above.
  special_holiday_premium_mode: z.enum(['flat', 'prorated']).default('flat'),
  // 'none' (default) preserves the pre-2026-09 behavior — holiday pay is never withheld for an
  // adjacent-day absence unless HR explicitly opts in.
  holiday_adjacency_requirement: z.enum(['none', 'before', 'after', 'both']).default('none'),
  // false (default) keeps the rest-day premium automatic — same opt-in-by-default convention.
  require_rest_day_form: boolish.default(false),
});

// POST /api/hr/payroll/:recordId/preview-deductions, PUT .../deductions — which of the four
// statutory deductions apply to ONE payslip record. All optional; an omitted key keeps whatever
// that deduction's current applied state already is (not reset to on).
export const payrollDeductionTogglesSchema = z.object({
  expected_revision: z.number().int().positive().optional(),
  change_reason: trimmed.max(1000).optional(),
  statutory_overrides: z.object({
    sss: z.number().finite().min(0).max(10_000_000).multipleOf(0.01).nullable().optional(),
    philhealth: z.number().finite().min(0).max(10_000_000).multipleOf(0.01).nullable().optional(),
    pagibig: z.number().finite().min(0).max(10_000_000).multipleOf(0.01).nullable().optional(),
    withholding_tax: z.number().finite().min(0).max(10_000_000).multipleOf(0.01).nullable().optional(),
  }).optional(),
  sss_applied: boolish.optional(),
  philhealth_applied: boolish.optional(),
  pagibig_applied: boolish.optional(),
  withholding_tax_applied: boolish.optional(),
  // Ad-hoc per-cutoff deduction lines for this one payslip (Cash Advance, uniform, misc, …) —
  // no running balance tracked across cutoffs, see docs/CASH-ADVANCE-LEDGER-TODO.md for the
  // planned persistent-ledger version. Omitted keeps whatever is already stored.
  other_deductions: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    amount: z.coerce.number().min(0).max(10_000_000),
  })).max(20).optional(),
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
  // Omitted only by employees exempt from the office location lock (clock_anywhere), punching
  // away from the office — see src/modules/hr/clock-geofence.ts. The route enforces that.
  code: z.string().trim().length(10, 'Scan the current office code').optional(),
  // The phone's GPS position (browser geolocation). Required when the location lock applies.
  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy_m: z.number().min(0).max(100_000),
  }).optional().nullable(),
});

/** Phone punch step 2 (POST /api/hr/clock/punch/selfie, multipart): the hold from step 1's scan
 *  and the slot the employee picked (the kiosk's four: In / Afternoon Out / Afternoon In / Out);
 *  the selfie itself is the "photo" file. */
export const phoneSelfieSchema = z.object({
  hold_id: z.coerce.number().int().positive('Scan the office code first'),
  slot: z.enum(['in', 'lunchOut', 'lunchIn', 'out'], { message: 'Choose time in, afternoon out, afternoon in or time out' }),
});

/** Approve this browser as a time-in kiosk (src/modules/hr/kiosk-devices.ts). */
export const kioskDeviceSchema = z.object({
  name: trimmed.min(1, 'Name this kiosk, e.g. "Front desk PC"').max(60),
});

/** Punch Log filter (GET /api/hr/clock/punches) — a work-date range; the route caps rows at 1000. */
export const punchLogQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD'),
  source: z.enum(['phone', 'remote', 'kiosk']).optional(),
}).refine((q) => q.from <= q.to, { message: '"From" must be on or before "To"', path: ['to'] });

/** Turn the approved-kiosk-devices lock on/off (setting `kiosk_lock`). */
export const kioskLockSchema = z.object({ enabled: z.boolean() });

/** Office location lock for phone time-in (setting `clock_geofence`). */
export const clockGeofenceSchema = z.object({
  enabled: z.boolean(),
  sites: z.array(z.object({
    name: trimmed.min(1, 'Name each office location').max(80),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    radius_m: z.number().int().min(30, 'Radius must be at least 30 m (GPS is rarely more precise)').max(5000),
  })).max(20),
  max_accuracy_m: z.number().int().min(10).max(1000).default(100),
}).refine((p) => !p.enabled || p.sites.length > 0, { message: 'Add at least one office location before turning the lock on.', path: ['sites'] });

export const kioskPunchSchema = z.object({
  code: z.string().trim().length(10, 'The office code has changed — the screen shows a fresh one'),
  employee_no: trimmed.min(1, 'Employee number is required').max(40),
});

export const kioskCorrectSchema = z.object({
  code: z.string().trim().length(10, 'The office code has changed — the screen shows a fresh one'),
  employee_no: trimmed.min(1, 'Employee number is required').max(40),
  slot: z.enum(['in', 'lunchOut', 'lunchIn', 'out']),
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
    work_date: realCalendarDate,
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
  // Approve a paid Leave request even though it would push leave_days_used past
  // leave_days_per_year — otherwise that's rejected with a 400 (see me.routes.ts).
  override_balance: z.boolean().optional(),
});

// ---- Field deliveries ----
const ymd = trimmed.regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional().nullable();
const geo = z.coerce.number().min(-180).max(180).optional().nullable();

export const createDeliverySchema = z.object({
  order_id: optionalId,
  customer_name: trimmed.max(200).optional().nullable(),
  address: trimmed.max(500).optional().nullable(),
  contact_phone: trimmed.max(40).optional().nullable(),
  scheduled_date: ymd,
  assigned_to: optionalId,
  notes: optionalText,
});

export const updateDeliverySchema = createDeliverySchema.partial();

export const deliveryStatusSchema = z.object({
  status: z.enum(['out_for_delivery', 'cancelled']),
});

export const deliveryCompleteSchema = z.object({
  outcome: z.enum(['delivered', 'failed']),
  recipient: trimmed.max(160).optional().nullable(),
  note: trimmed.max(1000).optional().nullable(),
  lat: geo,
  lng: geo,
  signature_attachment_id: optionalId,
}).refine((v) => v.outcome !== 'failed' || (v.note && v.note.trim().length >= 3), {
  message: 'Say why the delivery failed', path: ['note'],
});
