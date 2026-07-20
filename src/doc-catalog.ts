/**
 * Curated, categorized catalog of the data fields a document template can bind to.
 * These paths resolve against the render context built in public/js/doc-context.js
 * (company / order / items / user / today). It's the safe "data-bound" surface — a
 * custom variable of source_type 'field' points its field_path at one of these.
 */
import type { CatalogGroup } from './types';

export const DATA_SOURCE_CATALOG: CatalogGroup[] = [
  {
    group: 'Company',
    items: [
      { path: 'company.name', label: 'Company name' },
      { path: 'company.address', label: 'Company address' },
      { path: 'company.phone', label: 'Company phone' },
      { path: 'company.email', label: 'Company email' },
    ],
  },
  {
    group: 'Order',
    items: [
      { path: 'order.no', label: 'Order number' },
      { path: 'order.type', label: 'Order type' },
      { path: 'order.date', label: 'Order date' },
      { path: 'order.status', label: 'Status' },
      { path: 'order.customer_name', label: 'Customer name' },
      { path: 'order.customer_contact', label: 'Customer contact' },
      { path: 'order.notes', label: 'Notes' },
      { path: 'order.currency', label: 'Currency' },
      { path: 'order.subtotal', label: 'Subtotal' },
      { path: 'order.tax_percent', label: 'Tax %' },
      { path: 'order.tax_amount', label: 'Tax amount' },
      { path: 'order.total', label: 'Total' },
    ],
  },
  {
    group: 'Line item (per row)',
    items: [
      { path: 'name', label: 'Item name' },
      { path: 'sku', label: 'SKU' },
      { path: 'description', label: 'Description' },
      { path: 'quantity', label: 'Quantity' },
      { path: 'unit', label: 'Unit' },
      { path: 'unit_price', label: 'Unit price' },
      { path: 'line_total', label: 'Line total' },
    ],
  },
  {
    group: 'Meta',
    items: [
      { path: 'user.name', label: 'Prepared by' },
      { path: 'today', label: "Today's date" },
    ],
  },
  {
    // Flat fields from an HR Payroll record — only meaningful when this template is
    // rendered by the HR Payroll print flow (public/js/hr-payroll-print.js), which
    // builds its own flat context directly from the record, bypassing company/order.
    group: 'HR Payroll',
    items: [
      { path: 'employee_name', label: 'Employee name' },
      { path: 'dept_position', label: 'Dept./Position' },
      { path: 'payroll_period', label: 'Payroll period' },
      { path: 'pay_date', label: 'Pay date' },
      { path: 'daily_rate', label: 'Daily rate' },
      { path: 'days_worked', label: 'Days worked' },
      { path: 'ot_hours', label: 'OT hours' },
      { path: 'ot_rate_hour', label: 'OT rate/hour' },
      { path: 'basic_salary', label: 'Basic salary' },
      { path: 'overtime_pay', label: 'Overtime pay' },
      { path: 'undertime_pay', label: 'Undertime' },
      { path: 'holiday_pay', label: 'Holiday pay' },
      { path: 'special_holiday_30', label: 'Special holiday 30%' },
      { path: 'rest_day_ot', label: 'Rest day OT' },
      { path: 'total_earnings', label: 'Total earnings' },
      { path: 'sss', label: 'SSS' },
      { path: 'philhealth', label: 'PhilHealth' },
      { path: 'pagibig', label: 'Pag-IBIG' },
      { path: 'cash_advance', label: 'Cash advance' },
      { path: 'late_absences', label: 'Late/Absences' },
      { path: 'total_deductions', label: 'Total deductions' },
      { path: 'net_pay', label: 'Net pay' },
    ],
  },
];
