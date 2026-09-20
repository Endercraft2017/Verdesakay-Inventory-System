/** General-ledger pure helpers (src/ledger.ts). */
import { describe, it, expect } from 'vitest';
import {
  naturalSide, accountBalance, validateJournalLines, DEFAULT_COA,
  type AccountRef,
} from '../src/modules/accounting/ledger';

const accts = (spec: Array<[number, Partial<AccountRef>]>): Map<number, AccountRef> =>
  new Map(spec.map(([id, o]) => [id, { id, is_group: 0, archived: 0, ...o }]));

describe('naturalSide / accountBalance', () => {
  it('debit-natured for asset & expense, credit-natured otherwise', () => {
    expect(naturalSide('asset')).toBe('debit');
    expect(naturalSide('expense')).toBe('debit');
    expect(naturalSide('liability')).toBe('credit');
    expect(naturalSide('equity')).toBe('credit');
    expect(naturalSide('income')).toBe('credit');
  });
  it('balance is positive in the account\'s natural direction', () => {
    expect(accountBalance('asset', 1000, 300)).toBe(700);      // net debit
    expect(accountBalance('liability', 200, 900)).toBe(700);   // net credit
    expect(accountBalance('income', 0, 5000)).toBe(5000);
    expect(accountBalance('expense', 1200, 0)).toBe(1200);
  });
});

describe('validateJournalLines', () => {
  const map = accts([[1, {}], [2, {}], [3, { is_group: 1 }], [4, { archived: 1 }]]);

  it('accepts a balanced two-line entry', () => {
    const v = validateJournalLines([
      { account_id: 1, debit: 1000 }, { account_id: 2, credit: 1000 },
    ], map);
    expect(v.ok).toBe(true);
    expect(v.total_debit).toBe(1000);
    expect(v.total_credit).toBe(1000);
  });

  it('rejects an unbalanced entry', () => {
    const v = validateJournalLines([
      { account_id: 1, debit: 1000 }, { account_id: 2, credit: 900 },
    ], map);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/out of balance/i);
  });

  it('rejects fewer than two lines', () => {
    expect(validateJournalLines([{ account_id: 1, debit: 5 }], map).ok).toBe(false);
  });

  it('rejects a line that is both a debit and a credit, or neither', () => {
    expect(validateJournalLines([
      { account_id: 1, debit: 100, credit: 100 }, { account_id: 2, credit: 100 },
    ], map).errors.join(' ')).toMatch(/either a debit or a credit/i);
    expect(validateJournalLines([
      { account_id: 1 }, { account_id: 2, credit: 100 },
    ], map).errors.join(' ')).toMatch(/enter a debit or a credit/i);
  });

  it('rejects posting to a group, archived, or unknown account', () => {
    expect(validateJournalLines([{ account_id: 3, debit: 10 }, { account_id: 1, credit: 10 }], map).errors.join(' ')).toMatch(/group/i);
    expect(validateJournalLines([{ account_id: 4, debit: 10 }, { account_id: 1, credit: 10 }], map).errors.join(' ')).toMatch(/archived/i);
    expect(validateJournalLines([{ account_id: 99, debit: 10 }, { account_id: 1, credit: 10 }], map).errors.join(' ')).toMatch(/unknown account/i);
  });
});

describe('DEFAULT_COA', () => {
  it('is a valid tree: unique codes, every parent exists and is a group, one of each root', () => {
    const codes = new Set(DEFAULT_COA.map((a) => a.code));
    expect(codes.size).toBe(DEFAULT_COA.length);
    const groups = new Set(DEFAULT_COA.filter((a) => a.is_group).map((a) => a.code));
    for (const a of DEFAULT_COA) {
      if (a.parent) expect(groups.has(a.parent)).toBe(true);
    }
    for (const root of ['asset', 'liability', 'equity', 'income', 'expense']) {
      expect(DEFAULT_COA.some((a) => a.root_type === root && !a.parent && a.is_group)).toBe(true);
    }
    // key role tags the reports / auto-posting need
    for (const t of ['cash', 'bank', 'receivable', 'payable', 'stock', 'tax', 'cogs', 'retained_earnings']) {
      expect(DEFAULT_COA.some((a) => a.account_type === t)).toBe(true);
    }
  });
});
