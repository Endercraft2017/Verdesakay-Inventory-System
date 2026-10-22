/** Contribution bases per Philippine law (ph-statutory.ts "Contribution bases") and the
    contribution-month helpers (statutory-month.ts). Pure — no app/DB.
      SSS        RA 11199 §8(f): actual remuneration in the month, summed over the cutoffs
                 ending in it (IRR's month for daily-paid).
      Pag-IBIG   RA 9679 §3: basic salary (+ COLA) actually received.
      PhilHealth Circular 2020-0005: fixed monthly basic salary, not reduced by absences;
                 daily-paid = DOLE equivalent monthly rate (daily × 313 / 12 for a 6-day week). */
import { describe, it, expect } from 'vitest';
import {
  sssCompensation, pagIbigCompensation, equivalentMonthlyRate, philHealthMonthlyBasic,
  monthRemainder, contributionBasis, sssContribution, pagIbigContribution, philHealthContribution,
  SSS_2026, PAGIBIG_2026, PHILHEALTH_2026,
} from '../src/modules/payroll/ph-statutory';
import { contributionMonthOf, isLastCutoffOfMonth } from '../src/modules/payroll/statutory-month';

describe('per-cutoff compensation', () => {
  it('SSS = earnings less the late/undertime deduction; never negative', () => {
    expect(sssCompensation({ total_earnings: 10_218.75, late_absences: 1_510.94 })).toBe(8_707.81);
    expect(sssCompensation({ total_earnings: 100, late_absences: 250 })).toBe(0);
    expect(sssCompensation({})).toBe(0);
  });

  it('Pag-IBIG = SSS compensation less OT, night diff and rest-day/special-holiday premiums', () => {
    expect(pagIbigCompensation({
      total_earnings: 10_000, late_absences: 200, overtime_pay: 500, night_diff_pay: 100,
      special_holiday_30: 150, rest_day_ot: 50,
    })).toBe(9_000);
  });
});

describe('PhilHealth monthly basic salary (DOLE equivalent monthly rate)', () => {
  it('daily × (365 − 52 × rest days) / 12: 313 for 6-day, 261 for 5-day, 365 for 7-day weeks', () => {
    expect(equivalentMonthlyRate(750, 1)).toBe(19_562.5);   // 750 × 313 / 12
    expect(equivalentMonthlyRate(750, 2)).toBe(16_312.5);   // 750 × 261 / 12
    expect(equivalentMonthlyRate(750, 0)).toBe(22_812.5);   // 750 × 365 / 12
  });

  it('monthly-paid uses the monthly rate as is', () => {
    expect(philHealthMonthlyBasic({ rate_type: 'monthly', monthly_rate: 25_000, daily_rate: 961.54 }, 1)).toBe(25_000);
    expect(philHealthMonthlyBasic({ rate_type: 'daily', monthly_rate: null, daily_rate: 750 }, 1)).toBe(19_562.5);
  });

  it('is not reduced by absences — the premium is the same whatever the month\'s attendance', () => {
    const mbs = philHealthMonthlyBasic({ rate_type: 'daily', monthly_rate: null, daily_rate: 750 }, 1);
    const r = philHealthContribution(mbs, PHILHEALTH_2026); // 19,562.50 × 5% = 978.13, halved
    expect(r.employee).toBe(489.07);
    expect(r.employer).toBe(489.06);
  });
});

describe('month accrual (SSS / Pag-IBIG)', () => {
  it('worked example — ₱750/day, Sept: 1st cutoff 10,218.75 (late 1,510.94), 2nd 5,462.50 (late 168.75)', () => {
    const first = { total_earnings: 10_218.75, late_absences: 1_510.94 };
    const second = { total_earnings: 5_462.5, late_absences: 168.75 };
    const month = sssCompensation(first) + sssCompensation(second);
    expect(Math.round(month * 100) / 100).toBe(14_001.56);
    const r = sssContribution(month, SSS_2026);
    expect(r.msc).toBe(14_000);
    expect(r.employee).toBe(700);   // not the ₱975 a flat 750 × 26 estimate gave
    expect(r.employer).toBe(1_400);
    expect(r.ec).toBe(10);
  });

  it('a split deduction: 1st cutoff takes its month-to-date share, the 2nd trues it up', () => {
    const firstDue = sssContribution(contributionBasis(13_000, { monthComplete: false, laterCutoffDeducts: true, fullMonthEstimate: 26_000 }), SSS_2026).employee;
    expect(firstDue).toBe(650);
    const fullDue = sssContribution(contributionBasis(26_000, { monthComplete: true, laterCutoffDeducts: false, fullMonthEstimate: 26_000 }), SSS_2026).employee;
    expect(monthRemainder(fullDue, firstDue)).toBe(650);
  });

  it('deducting only on a cutoff before month end: the full-month rate stands in, never below actual so far', () => {
    expect(contributionBasis(6_000, { monthComplete: false, laterCutoffDeducts: false, fullMonthEstimate: 19_562.5 })).toBe(19_562.5);
    expect(contributionBasis(21_000, { monthComplete: false, laterCutoffDeducts: false, fullMonthEstimate: 19_562.5 })).toBe(21_000);
  });

  it('remainder never goes negative', () => {
    expect(monthRemainder(500, 650)).toBe(0);
  });

  it('Pag-IBIG on the month total: ₱200 cap above ₱10,000, 1% employee rate at ₱1,500 and below', () => {
    expect(pagIbigContribution(12_000, PAGIBIG_2026).employee).toBe(200);
    expect(pagIbigContribution(8_000, PAGIBIG_2026).employee).toBe(160);
    expect(pagIbigContribution(1_500, PAGIBIG_2026).employee).toBe(15);
  });
});

describe('contribution month of a cutoff', () => {
  it('a cutoff counts toward the month it ends in, whatever its pay date', () => {
    expect(contributionMonthOf({ end_date: '2026-09-30' })).toBe('2026-09');
  });

  it('semi-monthly: the cutoff starting after the 15th closes the month (Feb included)', () => {
    expect(isLastCutoffOfMonth({ start_date: '2026-09-01', end_date: '2026-09-15' }, 'semi_monthly')).toBe(false);
    expect(isLastCutoffOfMonth({ start_date: '2026-09-16', end_date: '2026-09-30' }, 'semi_monthly')).toBe(true);
    expect(isLastCutoffOfMonth({ start_date: '2026-02-01', end_date: '2026-02-15' }, 'semi_monthly')).toBe(false);
  });

  it('weekly / daily: closes the month when the next same-length cutoff ends in the next month', () => {
    expect(isLastCutoffOfMonth({ start_date: '2026-09-21', end_date: '2026-09-27' }, 'weekly')).toBe(true);  // next ends 10-04
    expect(isLastCutoffOfMonth({ start_date: '2026-09-14', end_date: '2026-09-20' }, 'weekly')).toBe(false); // next ends 09-27
    expect(isLastCutoffOfMonth({ start_date: '2026-09-30', end_date: '2026-09-30' }, 'daily')).toBe(true);
    expect(isLastCutoffOfMonth({ start_date: '2026-09-29', end_date: '2026-09-29' }, 'daily')).toBe(false);
  });

  it('monthly: always the last', () => {
    expect(isLastCutoffOfMonth({ start_date: '2026-09-01', end_date: '2026-09-30' }, 'monthly')).toBe(true);
  });
});
