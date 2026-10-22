/** Line recording is limited to an explicitly assigned account or linked crew member. */
import { queryOne } from '../../shared/db';
import type { AuthUser } from '../../shared/types';
export function canRecordJob(user: AuthUser, jobId: number): boolean {
  if (user.permissions.includes('production.work_all')) return true;
  return !!queryOne(`SELECT 1 FROM job_orders j WHERE j.id=? AND (
    EXISTS(SELECT 1 FROM job_order_assignees a WHERE a.job_order_id=j.id AND a.user_id=?) OR
    EXISTS(SELECT 1 FROM production_team_members m JOIN employees e ON e.id=m.employee_id
      WHERE m.team_id=j.team_id AND e.user_id=?))`,jobId,user.id,user.id);
}
export function scopedLineReader(user: AuthUser): boolean {
  return user.permissions.includes('production.record') && !user.permissions.some(p=>[
    'production.work_all','production.view','production.plan','production.kit_release',
    'production.inspect_qc','production.inspect_qa','production.qa_review','production.repairs','production.receive'
  ].includes(p));
}
