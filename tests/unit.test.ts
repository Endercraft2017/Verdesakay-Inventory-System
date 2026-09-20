/** Pure unit tests: validation schemas + password hashing (no HTTP, no DB needed). */
import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import {
  loginSchema,
  createUserSchema,
  createItemSchema,
  adjustStockSchema,
  sendMessageSchema,
  parseBody,
  ValidationError,
} from '../src/shared/validation';

describe('validation: login', () => {
  it('accepts valid credentials', () => {
    const out = parseBody(loginSchema, { username: '  Admin ', password: 'x' });
    expect(out.username).toBe('Admin'); // trimmed, not lowercased here
  });
  it('rejects missing password', () => {
    expect(() => parseBody(loginSchema, { username: 'a' })).toThrow(ValidationError);
  });
});

describe('validation: createUser', () => {
  it('lowercases + accepts a valid username', () => {
    const out = parseBody(createUserSchema, {
      username: 'JDoe',
      full_name: 'Jane Doe',
      password: 'secret1',
    });
    expect(out.username).toBe('jdoe');
    expect(out.role).toBe('admin_staff'); // default
    expect(out.department_id).toBeNull();
  });
  it('rejects a too-short password', () => {
    expect(() =>
      parseBody(createUserSchema, { username: 'jdoe', full_name: 'J', password: '123' })
    ).toThrow(/at least 6/);
  });
  it('rejects an invalid username', () => {
    expect(() =>
      parseBody(createUserSchema, { username: 'a b!', full_name: 'J', password: 'secret1' })
    ).toThrow(ValidationError);
  });
  it('coerces a numeric department_id string', () => {
    const out = parseBody(createUserSchema, {
      username: 'jdoe',
      full_name: 'J',
      password: 'secret1',
      department_id: '3',
    });
    expect(out.department_id).toBe(3);
  });
});

describe('validation: inventory', () => {
  it('defaults quantity and min to 0', () => {
    const out = parseBody(createItemSchema, { name: 'Pens' });
    expect(out.quantity).toBe(0);
    expect(out.min_quantity).toBe(0);
  });
  it('rejects an empty name', () => {
    expect(() => parseBody(createItemSchema, { name: '   ' })).toThrow(ValidationError);
  });
  it('rejects a zero stock adjustment', () => {
    expect(() => parseBody(adjustStockSchema, { change: 0 })).toThrow(/non-zero/);
  });
  it('accepts a negative adjustment', () => {
    expect(parseBody(adjustStockSchema, { change: -5 }).change).toBe(-5);
  });
});

describe('validation: messages', () => {
  it('requires a non-empty body', () => {
    expect(() => parseBody(sendMessageSchema, { recipient_id: 2, body: '' })).toThrow(
      ValidationError
    );
  });
});

describe('password hashing', () => {
  it('round-trips with bcrypt', () => {
    const hash = bcrypt.hashSync('s3cret!', 10);
    expect(bcrypt.compareSync('s3cret!', hash)).toBe(true);
    expect(bcrypt.compareSync('wrong', hash)).toBe(false);
  });
});
