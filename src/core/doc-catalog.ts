/**
 * Curated, categorized catalog of the data fields a document template can bind to.
 * These paths resolve against the render context built in public/js/doc-context.js
 * (company / order / items / user / today). It's the safe "data-bound" surface — a
 * custom variable of source_type 'field' points its field_path at one of these.
 */
import type { CatalogGroup } from '../shared/types';

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
      { path: 'days_absent', label: 'Days absent' },
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
      { path: 'late_absences', label: 'Late' },
      { path: 'total_deductions', label: 'Total deductions' },
      { path: 'net_pay', label: 'Net pay' },
    ],
  },
];

// Additional fields used by the premade employee/asset/payroll and tax layouts.
DATA_SOURCE_CATALOG.push({group:"Employee and asset documents",items:[{"path": "company.tin", "label": "Company — tin"}, {"path": "employee.name", "label": "Employee — name"}, {"path": "employee.employee_no", "label": "Employee — employee no"}, {"path": "employee.position", "label": "Employee — position"}, {"path": "employee.department", "label": "Employee — department"}, {"path": "employee.photo", "label": "Employee — photo"}, {"path": "employee.tin_no", "label": "Employee — tin no"}, {"path": "employee.address", "label": "Employee — address"}, {"path": "issuance.number", "label": "Issuance — number"}, {"path": "issuance.issued_date", "label": "Issuance — issued date"}, {"path": "issuance.notes", "label": "Issuance — notes"}, {"path": "issuance.issued_by_name", "label": "Issuance — issued by name"}, {"path": "asset_name", "label": "Asset name"}, {"path": "category", "label": "Category"}, {"path": "asset_tag", "label": "Asset tag"}, {"path": "condition_on_issue", "label": "Condition on issue"}, {"path": "days_half", "label": "Days half"}, {"path": "days_undertime", "label": "Days undertime"}, {"path": "undertime_day_pay", "label": "Undertime day pay"}, {"path": "night_diff_pay", "label": "Night diff pay"}]});
DATA_SOURCE_CATALOG.push({group:"BIR 2316",items:[{"path": "f.sss_gsis_phic_pagibig_union", "label": "Sss gsis phic pagibig union"}, {"path": "f.thirteenth_month_ceiling", "label": "Thirteenth month ceiling"}, {"path": "f.thirteenth_month_and_other_benefits", "label": "Thirteenth month and other benefits"}, {"path": "f.de_minimis", "label": "De minimis"}, {"path": "f.total_non_taxable", "label": "Total non taxable"}, {"path": "f.basic_salary", "label": "Basic salary"}, {"path": "f.overtime_pay", "label": "Overtime pay"}, {"path": "f.holiday_pay", "label": "Holiday pay"}, {"path": "f.night_diff_and_other", "label": "Night diff and other"}, {"path": "f.taxable_13th_month_excess", "label": "Taxable 13th month excess"}, {"path": "f.gross_compensation", "label": "Gross compensation"}, {"path": "f.taxable_compensation_present", "label": "Taxable compensation present"}, {"path": "f.taxable_compensation_previous", "label": "Taxable compensation previous"}, {"path": "f.gross_taxable_compensation", "label": "Gross taxable compensation"}, {"path": "f.tax_due", "label": "Tax due"}, {"path": "f.tax_withheld_present", "label": "Tax withheld present"}, {"path": "f.tax_withheld_previous", "label": "Tax withheld previous"}, {"path": "f.total_tax_withheld", "label": "Total tax withheld"}, {"path": "f.over_withheld_label", "label": "Over withheld label"}, {"path": "f.over_withheld_abs", "label": "Over withheld abs"}, {"path": "f.payslip_count", "label": "Payslip count"}, {"path": "year", "label": "Tax year"}]});
