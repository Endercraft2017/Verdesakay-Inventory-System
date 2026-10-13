/** Employee requests share one approval lifecycle across desktop, mobile and payroll. */
export const REQUEST_SLUGS = [
  'leave_request', 'overtime_request', 'undertime_request', 'halfday_request', 'offset_form',
  'lunch_offset_form', 'holiday_work_request', 'travel_order', 'coe_request',
  'reimbursement_request', 'loan_application', 'training_request', 'incident_report',
  'information_change', 'rest_day_work_request', 'rest_day_change', 'schedule_change',
];

export function effectiveHrForm(slug: string, status: string): boolean {
  return !REQUEST_SLUGS.includes(slug) || status === 'approved';
}
