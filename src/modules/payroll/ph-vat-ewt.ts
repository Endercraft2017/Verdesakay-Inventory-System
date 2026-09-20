/**
 * BIR monthly non-payroll returns (pure):
 *  - 2550M — Monthly Value-Added Tax Declaration (output VAT − input VAT).
 *  - 0619-E — Monthly Remittance Form of Creditable Income Taxes Withheld (Expanded).
 *
 * These are *worksheets*: the app supplies computed defaults from sale orders / vendor
 * bills, the accountant adjusts for exempt / zero-rated sales, disallowed input, and the
 * correct ATC per payee before filing in eBIRForms / eFPS.
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/* --------------------------------------------------------------- 2550M / VAT --- */

export interface VatInput {
  /** Total of the month's VAT-registered SALES documents (sale orders). */
  gross_sales: number;
  /** VAT already broken out on those sales (Σ order tax_amount). */
  output_vat_booked: number;
  /** Total of the month's PURCHASE documents subject to input VAT (approved vendor bills). */
  gross_purchases: number;
  /** VAT already broken out on those purchases (Σ bill tax_amount). */
  input_vat_booked: number;
  /** VAT rate (0.12 in PH). Used only when a document carries no tax_amount. */
  rate?: number;
  /** true → the totals are VAT-inclusive, so VAT = amount × rate/(1+rate). */
  amounts_vat_inclusive?: boolean;
  /** Carried-over excess input VAT from the prior period. */
  input_vat_carry_over?: number;
  /** Creditable VAT withheld / advance payments this month. */
  vat_payments?: number;
}

export interface Vat2550m {
  rate: number;
  vatable_sales: number;
  output_vat: number;
  vatable_purchases: number;
  input_vat_current: number;
  input_vat_carry_over: number;
  total_available_input_vat: number;
  net_vat_payable: number;   // > 0 = pay; < 0 = excess input carried forward
  vat_payments: number;
  still_payable: number;      // max(net_vat_payable − payments, 0)
  excess_input_vat: number;   // max(−net_vat_payable, 0)
  notes: string[];
}

export function vat2550m(input: VatInput): Vat2550m {
  const rate = input.rate ?? 0.12;
  const inclusive = !!input.amounts_vat_inclusive;
  const notes: string[] = [];

  const derive = (gross: number, booked: number): number => {
    if (booked > 0) return round2(booked);
    return round2(inclusive ? gross * (rate / (1 + rate)) : gross * rate);
  };

  const output_vat = derive(input.gross_sales, input.output_vat_booked);
  const input_vat_current = derive(input.gross_purchases, input.input_vat_booked);
  if (input.output_vat_booked <= 0 && input.gross_sales > 0) {
    notes.push('Output VAT was derived from the sales total — confirm no exempt / zero-rated sales are included.');
  }
  if (input.input_vat_booked <= 0 && input.gross_purchases > 0) {
    notes.push('Input VAT was derived from the purchases total — remove non-VAT / disallowed input and unsupported claims.');
  }

  const carry = round2(Math.max(0, input.input_vat_carry_over ?? 0));
  const totalInput = round2(input_vat_current + carry);
  const net = round2(output_vat - totalInput);
  const payments = round2(Math.max(0, input.vat_payments ?? 0));

  return {
    rate,
    vatable_sales: round2(inclusive ? input.gross_sales / (1 + rate) : input.gross_sales),
    output_vat,
    vatable_purchases: round2(inclusive ? input.gross_purchases / (1 + rate) : input.gross_purchases),
    input_vat_current,
    input_vat_carry_over: carry,
    total_available_input_vat: totalInput,
    net_vat_payable: net,
    vat_payments: payments,
    still_payable: round2(Math.max(0, net - payments)),
    excess_input_vat: round2(Math.max(0, -net)),
    notes,
  };
}

/* -------------------------------------------------------------- 0619-E / EWT --- */

/** A creditable-withholding line: one Alphanumeric Tax Code (ATC) bucket. */
export interface EwtLine {
  atc: string;            // e.g. WI158 / WC158 (professional fees), WI100 (rentals)
  description: string;
  tax_base: number;       // income payment subject to EWT this month
  rate: number;           // e.g. 0.02, 0.05, 0.10, 0.15
}

export interface Ewt0619e {
  lines: (EwtLine & { tax_withheld: number })[];
  total_tax_base: number;
  total_tax_withheld: number;
  /** Prior remittances this month (from 0605 / prior 0619-E), to net against. */
  remitted_prior: number;
  still_payable: number;
  notes: string[];
}

/** Common PH expanded-withholding ATCs, for the worksheet's picker. */
export const EWT_ATCS: { atc: string; description: string; rate: number }[] = [
  { atc: 'WI100/WC100', description: 'Rentals (real / personal property)', rate: 0.05 },
  { atc: 'WI010/WC010', description: 'Professional fees — individual / firm', rate: 0.10 },
  { atc: 'WI011/WC011', description: 'Professional fees — > ₱3M gross / VAT-reg', rate: 0.15 },
  { atc: 'WI120/WC120', description: 'Income payments to contractors / subcontractors', rate: 0.02 },
  { atc: 'WI158/WC158', description: 'Commission / rebates to non-employees', rate: 0.10 },
  { atc: 'WC139', description: 'Purchases of goods by a Top Withholding Agent', rate: 0.01 },
  { atc: 'WC140', description: 'Purchases of services by a Top Withholding Agent', rate: 0.02 },
];

export function ewt0619e(lines: EwtLine[], remittedPrior = 0): Ewt0619e {
  const withLines = lines
    .filter((l) => (Number(l.tax_base) || 0) > 0)
    .map((l) => ({ ...l, tax_withheld: round2((Number(l.tax_base) || 0) * (Number(l.rate) || 0)) }));
  const total_tax_base = round2(withLines.reduce((s, l) => s + (Number(l.tax_base) || 0), 0));
  const total_tax_withheld = round2(withLines.reduce((s, l) => s + l.tax_withheld, 0));
  const remitted_prior = round2(Math.max(0, remittedPrior));
  const notes: string[] = [
    '0619-E remits the tax; the payee detail goes on the quarterly 1601-EQ + QAP. Deadline: the 10th of the following month (11th if eFPS).',
  ];
  if (!withLines.length) notes.push('No EWT lines entered — add an ATC line per type of income payment made this month.');
  return {
    lines: withLines,
    total_tax_base,
    total_tax_withheld,
    remitted_prior,
    still_payable: round2(Math.max(0, total_tax_withheld - remitted_prior)),
    notes,
  };
}
