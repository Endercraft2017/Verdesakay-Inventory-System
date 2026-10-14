/** Department visibility policy shared by file routes and AI tools. */
import type { AuthUser } from '../shared/types';

/** Forms visible to a user: shared (no dept) + own dept. users.manage sees all. */
export function visibilityClause(user: AuthUser): { sql: string; params: unknown[] } {
  if (user.permissions.includes('users.manage')) return { sql: '', params: [] };
  return {
    sql: ' WHERE (f.department_id IS NULL OR f.department_id = ?)',
    params: [user.department_id],
  };
}
