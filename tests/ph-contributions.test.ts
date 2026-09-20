/** Agency monthly contribution schedules (pure). */
import { describe, it, expect } from 'vitest';
import { contributionSchedule, type ContribEmployeeInput } from '../src/modules/payroll/ph-contributions';
import { STATUTORY_TABLES_2026 } from '../src/modules/payroll/ph-statutory';

const emps: ContribEmployeeInput[] = [
  { name: 'Zamora, Ana', id_number: '34-1111111-1', monthly_comp: 30_000, monthly_basic: 28_000 },
  { name: 'Abad, Ben', id_number: '34-2222222-2', monthly_comp: 15_000, monthly_basic: 15_000 },
  { name: 'NoPay, Nil', id_number: null, monthly_comp: 0, monthly_basic: 0 },
];

describe('contributionSchedule', () => {
  it('SSS: EE/ER/EC columns, sorted, totals add up, drops zero-comp rows', () => {
    const s = contributionSchedule('sss', '2026-07', emps, STATUTORY_TABLES_2026);
    expect(s.headers).toContain('EC ER');
    expect(s.rows.map((r) => r.name)).toEqual(['Abad, Ben', 'Zamora, Ana']); // sorted, NoPay dropped
    for (const r of s.rows) {
      expect(r.total).toBeCloseTo(r.employee + r.employer + (r.ec || 0), 2);
      expect(r.employee).toBeGreaterThan(0);
    }
    expect(s.totals.grand).toBeCloseTo(s.rows.reduce((t, r) => t + r.total, 0), 2);
    expect(s.cells[0]!.length).toBe(s.headers.length);
  });

  it('PhilHealth: uses monthly basic, no EC column', () => {
    const s = contributionSchedule('philhealth', '2026-07', emps, STATUTORY_TABLES_2026);
    expect(s.headers).not.toContain('EC ER');
    expect(s.id_label).toBe('PhilHealth No.');
    const ana = s.rows.find((r) => r.name === 'Zamora, Ana')!;
    expect(ana.basis).toBe(28_000); // monthly_basic, not comp
    expect(ana.total).toBeCloseTo(ana.employee + ana.employer, 2);
  });

  it('Pag-IBIG: employee + employer shares from monthly comp', () => {
    const s = contributionSchedule('pagibig', '2026-07', emps, STATUTORY_TABLES_2026);
    const ana = s.rows.find((r) => r.name === 'Zamora, Ana')!;
    expect(ana.basis).toBe(30_000);
    expect(ana.employee).toBeGreaterThan(0);
    expect(ana.employer).toBeGreaterThan(0);
    expect(s.cells[0]!.length).toBe(s.headers.length);
  });
});
