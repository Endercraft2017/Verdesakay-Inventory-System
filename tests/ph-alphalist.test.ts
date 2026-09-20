/** BIR 1604-C Alphalist Schedule-1 row building (pure). */
import { describe, it, expect } from 'vitest';
import {
  splitName, statusCode, separationCode, alphalistScheduleRow, alphalistRowCells,
  ALPHALIST_SCHEDULE1_HEADERS,
} from '../src/modules/payroll/ph-alphalist';
import { compute2316, type PayslipYearRow } from '../src/modules/payroll/ph-2316';
import { RWT_2026 } from '../src/modules/payroll/ph-statutory';

const slip = (o: Partial<PayslipYearRow>): PayslipYearRow => ({
  basic_salary: 0, total_earnings: 0, sss: 0, philhealth: 0, pagibig: 0, withholding_tax: 0, ...o,
});

describe('name / status helpers', () => {
  it('splits names', () => {
    expect(splitName('Dela Cruz, Juan Ponce')).toEqual({ last_name: 'Dela Cruz', first_name: 'Juan', middle_name: 'Ponce' });
    expect(splitName('Maria Santos')).toEqual({ last_name: 'Santos', first_name: 'Maria', middle_name: '' });
    expect(splitName('Madonna')).toEqual({ last_name: 'Madonna', first_name: '', middle_name: '' });
  });
  it('maps employment + separation codes', () => {
    expect(statusCode('probationary')).toBe('P');
    expect(statusCode('regular')).toBe('R');
    expect(statusCode('terminated')).toBe('R');
    expect(separationCode('resigned')).toBe('T');
    expect(separationCode('regular')).toBe('');
  });
});

describe('alphalistScheduleRow', () => {
  const rows = Array.from({ length: 12 }, () =>
    slip({ basic_salary: 25_000, total_earnings: 25_000, sss: 1_300, philhealth: 650, pagibig: 200, withholding_tax: 800 })
  );
  const f = compute2316(rows, RWT_2026, '2026');
  const r = alphalistScheduleRow(1, {
    last_name: 'Santos', first_name: 'Maria', middle_name: '', tin: '123-456-789-000',
    status_code: 'R', period_from: '01/01', period_to: '12/31', separation_code: '', nationality: '',
  }, f);

  it('non-taxable columns sum to the total (7f = 7b+7c+7d+7e)', () => {
    expect(r.nt_total).toBe(
      Math.round((r.nt_13th_month + r.nt_de_minimis + r.nt_statutory + r.nt_salaries_250k_below) * 100) / 100
    );
  });
  it('taxable columns sum to the total (7j = 7g+7h+7i)', () => {
    expect(r.tx_total).toBe(
      Math.round((r.tx_basic_salary + r.tx_13th_month_excess + r.tx_salaries_other) * 100) / 100
    );
  });
  it('13th-month non-taxable is capped and any excess is taxable', () => {
    // 300000/12 = 25000, well under 90k -> all non-taxable, no excess
    expect(r.nt_13th_month).toBe(25_000);
    expect(r.tx_13th_month_excess).toBe(0);
  });
  it('adjusted tax withheld + refund vs still-due reflect the year-end position', () => {
    expect(r.tax_withheld_adjusted).toBe(f.total_tax_withheld);
    if (f.over_withheld >= 0) {
      expect(r.yea_over_withheld_refunded).toBe(f.over_withheld);
      expect(r.yea_still_due).toBe(0);
    } else {
      expect(r.yea_still_due).toBe(Math.round(-f.over_withheld * 100) / 100);
    }
  });
  it('cell array lines up with the header array', () => {
    expect(alphalistRowCells(r)).toHaveLength(ALPHALIST_SCHEDULE1_HEADERS.length);
  });
});
