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
export const createUserSchema = z.object({
  username: trimmed
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,30}$/, 'Username must be 3-30 chars: letters, numbers, dot, underscore, hyphen'),
  full_name: trimmed.min(1, 'Full name is required').max(120),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(['admin', 'employee']).default('employee'),
  department_id: optionalId,
});

export const updateUserSchema = z.object({
  full_name: trimmed.min(1).max(120).optional(),
  role: z.enum(['admin', 'employee']).optional(),
  department_id: optionalId,
  active: boolish.optional(),
});

export const resetPasswordSchema = z.object({
  new_password: z.string().min(6, 'New password must be at least 6 characters'),
});

export const createDepartmentSchema = z.object({
  name: trimmed.min(1, 'Department name is required').max(80),
});

export const updateDepartmentSchema = createDepartmentSchema;

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

export const createItemSchema = z.object({
  name: trimmed.min(1, 'Item name is required').max(160),
  sku: optionalText,
  category: optionalText,
  department_id: optionalId,
  quantity: intCoerce.default(0),
  unit: trimmed.max(40).optional().nullable(),
  min_quantity: intCoerce.min(0).default(0),
  location: optionalText,
  notes: optionalText,
  attributes: attributesSchema,
});

export const updateItemSchema = z.object({
  name: trimmed.min(1, 'Item name is required').max(160).optional(),
  sku: optionalText,
  category: optionalText,
  department_id: optionalId,
  unit: trimmed.max(40).optional().nullable(),
  min_quantity: intCoerce.min(0).optional(),
  location: optionalText,
  notes: optionalText,
  attributes: attributesSchema,
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
});

// ---- Messages ----
export const sendMessageSchema = z.object({
  recipient_id: z.coerce.number().int().positive('Recipient is required'),
  subject: trimmed.max(200).optional().nullable(),
  body: trimmed.min(1, 'Message body is required').max(5000),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type CreateItemInput = z.infer<typeof createItemSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
