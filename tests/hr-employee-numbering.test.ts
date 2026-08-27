/** Pure unit tests for src/hr-employee-numbering.ts's suggestEmployeeNumber(). */
import { describe, it, expect } from 'vitest';
import { suggestEmployeeNumber } from '../src/hr-employee-numbering';
import type { EmployeeNumberPolicy } from '../src/types';

const SEQ: EmployeeNumberPolicy = { prefix: 'EMP', mode: 'sequential', pad: 5, date_format: 'YYYYMMDD' };
const HIRE: EmployeeNumberPolicy = { prefix: 'HD', mode: 'hire_date', pad: 2, date_format: 'YYYYMMDD' };

describe('suggestEmployeeNumber', () => {
  it('starts at 00001 with no existing employees', () => {
    expect(suggestEmployeeNumber([], SEQ, '2026-01-01')).toBe('EMP-00001');
  });

  it('continues from the highest existing number matching the prefix, ignoring gaps and unrelated formats', () => {
    expect(suggestEmployeeNumber(['EMP-00001', 'EMP-00007', 'EMP-00003'], SEQ, '2026-01-01')).toBe('EMP-00008');
    expect(suggestEmployeeNumber(['EMP-00001', 'CUSTOM-XYZ', 'HD20260101-01'], SEQ, '2026-01-01')).toBe('EMP-00002');
  });

  it('supports an empty prefix (plain numeric numbers)', () => {
    const noPrefix: EmployeeNumberPolicy = { prefix: '', mode: 'sequential', pad: 4, date_format: 'YYYYMMDD' };
    expect(suggestEmployeeNumber(['0001', '0002'], noPrefix, '2026-01-01')).toBe('0003');
  });

  it('hire_date mode keys the suffix counter by date, resetting for a new day', () => {
    expect(suggestEmployeeNumber([], HIRE, '2026-03-10')).toBe('HD20260310-01');
    expect(suggestEmployeeNumber(['HD20260310-01'], HIRE, '2026-03-10')).toBe('HD20260310-02');
    expect(suggestEmployeeNumber(['HD20260310-01', 'HD20260310-02'], HIRE, '2026-03-10')).toBe('HD20260310-03');
    expect(suggestEmployeeNumber(['HD20260310-01', 'HD20260310-02'], HIRE, '2026-03-11')).toBe('HD20260311-01');
  });

  it('formats the date as YYMMDD when configured', () => {
    const shortDate: EmployeeNumberPolicy = { prefix: 'HD', mode: 'hire_date', pad: 2, date_format: 'YYMMDD' };
    expect(suggestEmployeeNumber([], shortDate, '2026-03-10')).toBe('HD260310-01');
  });

  it('respects the configured zero-padding width', () => {
    const wide: EmployeeNumberPolicy = { prefix: 'EMP', mode: 'sequential', pad: 3, date_format: 'YYYYMMDD' };
    expect(suggestEmployeeNumber([], wide, '2026-01-01')).toBe('EMP-001');
    expect(suggestEmployeeNumber(['EMP-999'], wide, '2026-01-01')).toBe('EMP-1000'); // overflow just widens, doesn't truncate
  });
});
