/** Customer case rules shared by cases, sale intake, and case attachments. */
import { queryOne, queryAll, run } from '../../shared/db';
import { userPermissions } from '../../shared/roles';
import { now } from '../../shared/sync-context';
import type { AuthUser, Role, Permission } from '../../shared/types';

export interface CustomerCase {
  id: number; customer_id: number; kind: 'inquiry' | 'complaint'; summary: string;
  status: 'open' | 'in_progress' | 'waiting' | 'resolved' | 'cancelled';
  owner_id: number; next_action: string | null; due_at: string | null;
  sale_order_id: number | null; resolution: string | null; version: number;
}
export function caseError(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
export const terminalCase = (status: string): boolean => ['resolved', 'cancelled'].includes(status);
export function canReadCases(user: AuthUser): boolean {
  return user.permissions.includes('cases.view') && user.permissions.includes('orders.view');
}
export function canEditCase(user: AuthUser, c: CustomerCase): boolean {
  return canReadCases(user) && user.permissions.includes('cases.edit')
    && (c.owner_id === user.id || user.permissions.includes('cases.assign'));
}
export function getCase(id: number): CustomerCase {
  return queryOne<CustomerCase>('SELECT * FROM customer_cases WHERE id = ?', id) ?? caseError(404, 'Case not found');
}
export function caseOwners(): { id: number; full_name: string }[] {
  return queryAll<{ id: number; full_name: string; role: Role; permission_overrides: string }>(
    'SELECT id, full_name, role, permission_overrides FROM users WHERE active=1'
  ).filter(u => {
    let overrides: Record<string, boolean> = {};
    try { overrides = JSON.parse(u.permission_overrides || '{}'); } catch { /* role defaults */ }
    const perms = userPermissions(u.role, overrides);
    const needed: Permission[] = ['cases.view', 'cases.edit', 'orders.view'];
    return needed.every(p => perms.includes(p));
  }).map(({ id, full_name }) => ({ id, full_name }));
}
export function validateCase(c: Omit<CustomerCase, 'id' | 'version'>): void {
  if (!queryOne('SELECT id FROM customers WHERE id=?', c.customer_id)) caseError(400, 'Customer not found');
  if (!caseOwners().some(u => u.id === c.owner_id)) caseError(400, 'Choose an active CSR with customer-case access');
  if (!terminalCase(c.status) && (!c.next_action?.trim() || !c.due_at)) caseError(400, 'Open cases require an owner, next action and due time');
  if (terminalCase(c.status) && !c.resolution?.trim()) caseError(400, 'A resolution or cancellation reason is required');
  if (c.sale_order_id != null) {
    const order = queryOne<{ type: string; customer_id: number | null }>('SELECT type, customer_id FROM orders WHERE id=?', c.sale_order_id);
    if (!order || order.type !== 'sale' || order.customer_id !== c.customer_id) caseError(400, 'Select a sale belonging to this customer');
  }
}
export function recordCaseEvent(id: number, actor: AuthUser, type: string, note?: string | null): void {
  const {id: caseId, customer_id, kind, summary, status, owner_id, next_action, due_at, sale_order_id, resolution, version} = getCase(id);
  const snapshot = {id:caseId, customer_id, kind, summary, status, owner_id, next_action, due_at, sale_order_id, resolution, version};
  run(`INSERT INTO customer_case_events(case_id, actor_id, actor_name, event_type, note, snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, id, actor.id, actor.full_name, type, note ?? null, JSON.stringify(snapshot), now().toISOString());
}
