/* Builds a styled .xlsx workbook for an HR Payroll "Download Excel" export (public/js/views/
   form-records.js — payroll only; every other form keeps the plain-CSV path since a generic
   form has no summary/department concept and CSV can't carry cell styling anyway).

   Layout (per the 2026-09-18 redesign):
     Row 1        title band  — the payroll period's own name (falls back to the form name when
                                 no single period is in view, e.g. an unfiltered "All periods"
                                 export)
     Row 2        subtitle    — payslip count (+ status filter / pay date, when they apply)
     SUMMARY      — same 5 totals payslipSummaryHTML shows on screen
     BY DEPARTMENT (only when there's more than one) — subtotal rollup, one row per department
     PAYSLIPS     — the actual employee list, grouped by department AS ROWS (a colored department
                    banner row, then that department's employees right under it) instead of
                    dept_position/payroll_period/number/status/dates being their own columns —
                    each of those either doesn't vary per row within one export (period, pay
                    date), is implied by the row grouping (department), or isn't payroll data at
                    all (record number/status/created-at). Every actual pay figure DOES still get
                    a column, all of them, grouped into 5 zones with a 2-row header (a colored
                    group banner over a specific-field header) and a blank spacer column between
                    zones: Employee Name | ATTENDANCE (daily rate, days worked/absent/half/
                    undertime, OT hours/rate) | (gap) | EARNINGS (basic salary, overtime/
                    undertime/holiday/night-diff pay, Total Earnings) | (gap) | STATUTORY
                    DEDUCTIONS (SSS/PhilHealth/Pag-IBIG/Withholding Tax) | (gap) | OTHER
                    DEDUCTIONS (cash advance, other deductions, late, Total Deductions) | (gap) |
                    NET PAY. See HR_PAYROLL_ZONES below for the exact field list per zone.

   Two layers on purpose:
   - computePayrollExportData() is pure data math (same totals payslipSummaryHTML/payslipTotals
     already show on screen — kept identical so the download always matches the page), safe to
     unit-test without a DOM or the XLSX library.
   - buildPayrollWorkbook()/downloadPayrollWorkbook() do the actual XLSX/DOM work and require the
     vendored xlsx-js-style bundle (public/js/vendor/xlsx-style.min.js, global `XLSX`) to be
     loaded — that's what gives real cell fills/fonts/number formats, which plain SheetJS builds
     don't support writing.
   Browser global + CommonJS export (for tests), same pattern as hr-payroll-print.js. */

const HR_PAYROLL_XLSX_COLOR = {
  text: '16243D', accent: '2B7FFF', accentWeak: 'E7F1FF',
  success: '168F54', successWeak: 'E3F6EC',
  danger: 'D23B46', dangerWeak: 'FDEAEC',
  warn: 'B7791F', warnWeak: 'FDF2E0',
  border: 'C6D4E6', band: 'F5F8FC', white: 'FFFFFF',
  secondary: '5C6BC0', secondaryWeak: 'E8EAF9', // "BY DEPARTMENT" section's own accent
};
const HR_PAYROLL_XLSX_NUMFMT = '#,##0.00;[red]-#,##0.00';

// Rotates across departments so each one's row-group banner (in PAYSLIPS) and its name tag (in
// BY DEPARTMENT) reads as its own color, not a repeat of the section banners above it.
const HR_PAYROLL_DEPT_PALETTE = ['5C6BC0', '00897B', 'AB47BC', '6D4C41', '3F7CAC', 'EF6C00'];
function _hrxDeptColor(i) { return HR_PAYROLL_DEPT_PALETTE[i % HR_PAYROLL_DEPT_PALETTE.length]; }

/* Department comes out of dept_position's free-text "Department / Position" convention (see
   src/db.ts's hr_payroll field seed) — there's no separate department field on the payroll
   form itself, so this is the same split a human reads it with. */
function _hrxDeptName(rec) {
  const raw = String((rec.data && rec.data.dept_position) || '').trim();
  if (!raw) return '(No Department)';
  const idx = raw.indexOf('/');
  return (idx >= 0 ? raw.slice(0, idx) : raw).trim() || '(No Department)';
}

/* Same math as form-records.js's payslipTotals()/payslipSummaryHTML() — statutory is the 4
   government lines, "other deductions" is whatever's left of total_deductions once those are
   subtracted (cash advance, late, itemized other-deduction lines, etc). Kept in lockstep on
   purpose so the workbook's numbers never drift from what the page shows above the table.
   Each department entry also carries its own raw `records` (in original list order) — the
   PAYSLIPS section groups by department by re-walking these, and the BY DEPARTMENT section
   reads the totals fields sitting alongside them. */
function computePayrollExportData(records) {
  const list = records || [];
  const num = (v) => Number(v) || 0;
  const sum = (rows, key) => rows.reduce((s, r) => s + num(r.data[key]), 0);
  const totalsOf = (rows) => {
    const gross = sum(rows, 'total_earnings');
    const statutory = sum(rows, 'sss') + sum(rows, 'philhealth') + sum(rows, 'pagibig') + sum(rows, 'withholding_tax');
    const totalDeductions = sum(rows, 'total_deductions');
    return { count: rows.length, gross, statutory, otherDeductions: totalDeductions - statutory, totalDeductions, net: sum(rows, 'net_pay') };
  };
  const byDept = new Map();
  for (const r of list) {
    const name = _hrxDeptName(r);
    if (!byDept.has(name)) byDept.set(name, []);
    byDept.get(name).push(r);
  }
  const departments = [...byDept.entries()]
    .map(([name, rows]) => ({ name, records: rows, ...totalsOf(rows) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { totals: totalsOf(list), departments };
}

function _hrxSheetName(name) {
  return String(name || 'Payroll').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Payroll';
}

function _hrxBorder(color) {
  const b = { style: 'thin', color: { rgb: color || HR_PAYROLL_XLSX_COLOR.border } };
  return { top: b, bottom: b, left: b, right: b };
}

/* Every hr_payroll amount field ends up in exactly one of these 5 zones — this IS the "which
   columns" answer: everything payroll-related stays (attendance basis, every earnings line,
   every deduction line), only what's redundant across every row of a single export (payroll
   period, pay date — see the subtitle instead) or isn't payroll data at all (record number,
   status, created-at) is left out. `subtotal: true` just bolds that column — it's still a real
   figure (total_earnings/total_deductions), not a duplicate of the line items beside it.
   `weak`/`deep` are that zone's two shades: `deep` for its group-header band, `weak` for its
   column header + every data cell under it (see HR_PAYROLL_XLSX_STYLE.zoneCell). */
const HR_PAYROLL_ZONES = [
  {
    key: 'attendance', label: 'ATTENDANCE', deep: '546E7A', weak: 'ECEFF1', text: HR_PAYROLL_XLSX_COLOR.text,
    fields: [
      ['daily_rate', 'Daily Rate'], ['days_worked', 'Days Worked'], ['days_absent', 'Days Absent'],
      ['days_half', 'Half Days'], ['days_undertime', 'Undertime Days'],
      ['ot_hours', 'OT Hours'], ['ot_rate_hour', 'OT Rate/Hour'],
    ],
  },
  {
    key: 'earnings', label: 'EARNINGS', deep: '1565C0', weak: HR_PAYROLL_XLSX_COLOR.accentWeak, text: HR_PAYROLL_XLSX_COLOR.text,
    fields: [
      ['basic_salary', 'Basic Salary'], ['overtime_pay', 'Overtime Pay'], ['undertime_pay', 'Undertime Pay'],
      ['undertime_day_pay', 'Undertime Day Pay'], ['holiday_pay', 'Holiday Pay'],
      ['special_holiday_30', 'Special Holiday 30%'], ['rest_day_ot', 'Rest Day OT'],
      ['night_diff_pay', 'Night Differential'], ['total_earnings', 'Total Earnings', true],
    ],
  },
  {
    key: 'statutory', label: 'STATUTORY DEDUCTIONS', deep: '9C7A1E', weak: HR_PAYROLL_XLSX_COLOR.warnWeak, text: HR_PAYROLL_XLSX_COLOR.warn,
    fields: [
      ['sss', 'SSS'], ['philhealth', 'PhilHealth'], ['pagibig', 'Pag-IBIG'], ['withholding_tax', 'Withholding Tax'],
    ],
  },
  {
    key: 'other', label: 'OTHER DEDUCTIONS', deep: 'B71C1C', weak: HR_PAYROLL_XLSX_COLOR.dangerWeak, text: HR_PAYROLL_XLSX_COLOR.danger,
    fields: [
      ['cash_advance', 'Cash Advance'], ['other_deductions_total', 'Other Deductions'],
      ['late_absences', 'Late'], ['total_deductions', 'Total Deductions', true],
    ],
  },
  {
    key: 'net', label: 'NET PAY', deep: '1B5E20', weak: HR_PAYROLL_XLSX_COLOR.successWeak, text: HR_PAYROLL_XLSX_COLOR.success,
    fields: [['net_pay', 'Net Pay', true]],
  },
];

function _hrxFieldLabel(formDef, key, fallback) {
  const f = (formDef.fields || []).find((x) => x.key === key);
  return (f && f.label) || fallback;
}

const HR_PAYROLL_NAME_COL = 0;

/** Walks HR_PAYROLL_ZONES to assign real column indices — column 0 is Employee Name, then each
    zone's fields get consecutive columns, with one blank spacer column between zones (not
    after the last one). Returns the flat column list, each zone's merge span (for its group-
    header banner), the gap column indices, and the total column count. */
function _hrxLayout(formDef) {
  const cols = [];
  const zoneSpans = [];
  const gapCols = [];
  let c = HR_PAYROLL_NAME_COL + 1;
  HR_PAYROLL_ZONES.forEach((zone, zi) => {
    const start = c;
    zone.fields.forEach(([key, fallback, subtotal]) => {
      cols.push({ col: c, key, label: _hrxFieldLabel(formDef, key, fallback), zone: zone.key, subtotal: !!subtotal });
      c++;
    });
    zoneSpans.push({ zone: zone.key, label: zone.label, start, end: c - 1 });
    if (zi < HR_PAYROLL_ZONES.length - 1) { gapCols.push(c); c++; }
  });
  return { cols, zoneSpans, gapCols, mainCols: c };
}

function _hrxZoneStyle(key) {
  return HR_PAYROLL_ZONES.find((z) => z.key === key);
}

const HR_PAYROLL_XLSX_STYLE = {
  title: () => ({
    font: { bold: true, sz: 16, color: { rgb: HR_PAYROLL_XLSX_COLOR.white } },
    fill: { fgColor: { rgb: HR_PAYROLL_XLSX_COLOR.text } },
    alignment: { vertical: 'center' },
  }),
  subtitle: () => ({ font: { italic: true, sz: 10, color: { rgb: HR_PAYROLL_XLSX_COLOR.text } } }),
  section: (fill) => ({
    font: { bold: true, sz: 11, color: { rgb: HR_PAYROLL_XLSX_COLOR.white } },
    fill: { fgColor: { rgb: fill || HR_PAYROLL_XLSX_COLOR.accent } },
    alignment: { vertical: 'center' },
  }),
  label: () => ({
    font: { bold: true, sz: 9, color: { rgb: HR_PAYROLL_XLSX_COLOR.text } },
    fill: { fgColor: { rgb: HR_PAYROLL_XLSX_COLOR.accentWeak } },
    border: _hrxBorder(),
    alignment: { horizontal: 'center', wrapText: true, vertical: 'center' },
  }),
  value: (fill, color) => ({
    font: { bold: true, sz: 13, color: { rgb: color || HR_PAYROLL_XLSX_COLOR.text } },
    fill: { fgColor: { rgb: fill || HR_PAYROLL_XLSX_COLOR.white } },
    border: _hrxBorder(),
    alignment: { horizontal: 'center' },
    numFmt: HR_PAYROLL_XLSX_NUMFMT,
  }),
  tableHeader: (fill) => ({
    font: { bold: true, sz: 10, color: { rgb: HR_PAYROLL_XLSX_COLOR.white } },
    fill: { fgColor: { rgb: fill || HR_PAYROLL_XLSX_COLOR.accent } },
    border: _hrxBorder(fill || HR_PAYROLL_XLSX_COLOR.accent),
    alignment: { vertical: 'center', wrapText: true },
  }),
  totalRow: () => ({
    font: { bold: true, sz: 10, color: { rgb: HR_PAYROLL_XLSX_COLOR.text } },
    fill: { fgColor: { rgb: HR_PAYROLL_XLSX_COLOR.warnWeak } },
    border: { ..._hrxBorder(), top: { style: 'medium', color: { rgb: HR_PAYROLL_XLSX_COLOR.text } } },
    numFmt: HR_PAYROLL_XLSX_NUMFMT,
  }),
  cell: (banded, numeric, numFmt, bold) => {
    const s = {
      font: { sz: 10, bold: !!bold, color: { rgb: HR_PAYROLL_XLSX_COLOR.text } },
      fill: { fgColor: { rgb: banded ? HR_PAYROLL_XLSX_COLOR.band : HR_PAYROLL_XLSX_COLOR.white } },
      border: _hrxBorder(),
    };
    if (numeric) { s.numFmt = numFmt || HR_PAYROLL_XLSX_NUMFMT; s.alignment = { horizontal: 'right' }; }
    else { s.alignment = { horizontal: 'left' }; }
    return s;
  },
  // The employee-name column in PAYSLIPS — plain (no zebra: the department banner rows already
  // give the table plenty of visual rhythm without alternating every single row too).
  name: (bold) => ({
    font: { sz: 10, bold: !!bold, color: { rgb: HR_PAYROLL_XLSX_COLOR.text } },
    fill: { fgColor: { rgb: HR_PAYROLL_XLSX_COLOR.white } },
    border: _hrxBorder(),
    alignment: { horizontal: 'left' },
  }),
  // A spacer column: light fill, no border — reads as an intentional gap instead of a stray
  // empty cell in the middle of a bordered grid.
  gap: () => ({ fill: { fgColor: { rgb: HR_PAYROLL_XLSX_COLOR.band } } }),
  // A zone's group-header band (e.g. "EARNINGS" spanning all of that zone's columns) — the
  // deep shade of that zone's color, white bold text.
  zoneBand: (zoneKey) => {
    const z = _hrxZoneStyle(zoneKey);
    return { font: { bold: true, sz: 10, color: { rgb: HR_PAYROLL_XLSX_COLOR.white } }, fill: { fgColor: { rgb: z.deep } }, alignment: { horizontal: 'center', vertical: 'center' } };
  },
  // That zone's specific field-name header, one level lighter than its group band above it —
  // same weak tint the data cells below use, so the whole zone reads as one color column-to-column.
  zoneHeader: (zoneKey) => {
    const z = _hrxZoneStyle(zoneKey);
    return { font: { bold: true, sz: 9, color: { rgb: z.text } }, fill: { fgColor: { rgb: z.weak } }, border: _hrxBorder(z.deep), alignment: { horizontal: 'center', vertical: 'center', wrapText: true } };
  },
  // One payslip amount cell, tinted by which zone it belongs to.
  zoneCell: (zoneKey, bold) => {
    const z = _hrxZoneStyle(zoneKey);
    return {
      font: { sz: 10, bold: !!bold, color: { rgb: z.text } },
      fill: { fgColor: { rgb: z.weak } },
      border: _hrxBorder(),
      numFmt: HR_PAYROLL_XLSX_NUMFMT,
      alignment: { horizontal: 'right' },
    };
  },
  // A department's row-group banner inside PAYSLIPS — its own rotating color, not the section
  // blue, so each department block is visually distinct at a glance.
  deptBand: (color) => ({
    font: { bold: true, sz: 11, color: { rgb: HR_PAYROLL_XLSX_COLOR.white } },
    fill: { fgColor: { rgb: color } },
    alignment: { vertical: 'center' },
  }),
  // The department name "tag" cell in BY DEPARTMENT — same rotating color as that department's
  // banner in PAYSLIPS, tying the two sections together.
  deptTag: (color) => ({
    font: { bold: true, sz: 10, color: { rgb: HR_PAYROLL_XLSX_COLOR.white } },
    fill: { fgColor: { rgb: color } },
    border: _hrxBorder(color),
    alignment: { horizontal: 'left', vertical: 'center' },
  }),
};

function _hrxColWidths(layout) {
  const widths = [];
  widths[HR_PAYROLL_NAME_COL] = { wch: 24 };
  layout.gapCols.forEach((c) => { widths[c] = { wch: 3 }; });
  layout.cols.forEach((cdef) => { widths[cdef.col] = { wch: Math.max(9, Math.min(18, cdef.label.length + 2)) }; });
  return widths;
}

/** records: form-records.js's currentRecords (or a bundle's slice) — [{number,status,created_at,data}].
    formDef: the hr_payroll form definition ({name, fields:[{key,label,type}]}).
    opts.title: the big banner text — normally the payroll period's own name (form-records.js
    passes labelHint/state.period; falling back to formDef.name only happens there, when no
    single period is in view).
    opts.subtitle: the line under it (payslip count, status filter, etc) — a shared pay date
    across every record in this export is appended automatically. */
function buildPayrollWorkbook(records, formDef, opts) {
  if (typeof XLSX === 'undefined') throw new Error('XLSX library not loaded');
  opts = opts || {};
  const list = records || [];
  const { totals, departments } = computePayrollExportData(list);
  const layout = _hrxLayout(formDef);
  const S = HR_PAYROLL_XLSX_STYLE;
  const C = HR_PAYROLL_XLSX_COLOR;
  const SUMMARY_COLS = 5;
  const DEPT_COLS = 7;

  const ws = {};
  const merges = [];
  const put = (row, col, v, s) => {
    ws[XLSX.utils.encode_cell({ r: row, c: col })] = { t: typeof v === 'number' ? 'n' : 's', v, s };
  };
  const band = (row, c1, c2, text, style) => {
    put(row, c1, text, style);
    if (c2 > c1) merges.push({ s: { r: row, c: c1 }, e: { r: row, c: c2 } });
  };

  let r = 0;
  band(r, 0, layout.mainCols - 1, opts.title || formDef.name || 'HR Payroll', S.title()); r++;
  // pay_date is the same for every row of a single-period export — showing it once here instead
  // of as a repeated column (an "All periods" export can span several dates, so it's only shown
  // when every row in view actually agrees on one).
  const payDates = [...new Set(list.map((rec) => rec.data && rec.data.pay_date).filter(Boolean))];
  const subtitle = (opts.subtitle || `${list.length} payslip${list.length === 1 ? '' : 's'}`) +
    (payDates.length === 1 ? `  •  Pay Date: ${payDates[0]}` : '');
  band(r, 0, layout.mainCols - 1, subtitle, S.subtitle()); r++;
  if(opts.copyNotice){band(r,0,layout.mainCols-1,opts.copyNotice,S.subtitle());r++;}
  r++;

  band(r, 0, SUMMARY_COLS - 1, 'SUMMARY', S.section()); r++;
  const summaryLabels = ['Total Gross', 'Statutory (SSS/PhilHealth/Pag-IBIG/Tax)', 'Other Deductions', 'Total Deductions', 'Total Net Pay'];
  summaryLabels.forEach((l, i) => put(r, i, l, S.label())); r++;
  const summaryVals = [totals.gross, totals.statutory, totals.otherDeductions, totals.totalDeductions, totals.net];
  const summaryFills = [C.accentWeak, C.warnWeak, C.dangerWeak, C.dangerWeak, C.successWeak];
  const summaryTextColors = [C.text, C.warn, C.danger, C.danger, C.success];
  summaryVals.forEach((v, i) => put(r, i, v, S.value(summaryFills[i], summaryTextColors[i]))); r += 2;

  if (departments.length > 1) {
    band(r, 0, DEPT_COLS - 1, 'BY DEPARTMENT', S.section(C.secondary)); r++;
    ['Department', 'Employees', 'Gross', 'Statutory', 'Other Deductions', 'Total Deductions', 'Net Pay']
      .forEach((h, i) => put(r, i, h, S.tableHeader(C.secondary))); r++;
    departments.forEach((d, i) => {
      const bd = i % 2 === 1;
      put(r, 0, d.name, S.deptTag(_hrxDeptColor(i)));
      put(r, 1, d.count, S.cell(bd, true, '0'));
      put(r, 2, d.gross, S.cell(bd, true));
      put(r, 3, d.statutory, S.cell(bd, true));
      put(r, 4, d.otherDeductions, S.cell(bd, true));
      put(r, 5, d.totalDeductions, S.cell(bd, true));
      put(r, 6, d.net, S.cell(bd, true));
      r++;
    });
    put(r, 0, 'TOTAL', S.totalRow());
    put(r, 1, totals.count, { ...S.totalRow(), numFmt: '0' });
    put(r, 2, totals.gross, S.totalRow());
    put(r, 3, totals.statutory, S.totalRow());
    put(r, 4, totals.otherDeductions, S.totalRow());
    put(r, 5, totals.totalDeductions, S.totalRow());
    put(r, 6, totals.net, S.totalRow());
    r += 2;
  }

  band(r, 0, layout.mainCols - 1, 'PAYSLIPS', S.section()); r++;

  // Group-header row: one merged, deep-colored band per zone (e.g. "EARNINGS" spread across
  // every earnings column) — Employee Name and the gap columns just carry blank filler so the
  // row reads clean edge-to-edge.
  put(r, HR_PAYROLL_NAME_COL, '', S.name(true));
  layout.gapCols.forEach((c) => put(r, c, '', S.gap()));
  layout.zoneSpans.forEach((z) => band(r, z.start, z.end, z.label, S.zoneBand(z.zone)));
  r++;

  // Field-name header row underneath — Employee Name here (not on the group-header row above)
  // since it doesn't belong to any zone.
  const headerRow = r;
  put(r, HR_PAYROLL_NAME_COL, 'Employee Name', S.tableHeader());
  layout.gapCols.forEach((c) => put(r, c, '', S.gap()));
  layout.cols.forEach((cdef) => put(r, cdef.col, cdef.label, S.zoneHeader(cdef.zone)));
  r++;

  departments.forEach((d, di) => {
    band(r, 0, layout.mainCols - 1, d.name, S.deptBand(_hrxDeptColor(di))); r++;
    d.records.forEach((rec) => {
      put(r, HR_PAYROLL_NAME_COL, rec.data.employee_name || rec.number || '', S.name());
      layout.gapCols.forEach((c) => put(r, c, '', S.gap()));
      layout.cols.forEach((cdef) => put(r, cdef.col, Number(rec.data[cdef.key]) || 0, S.zoneCell(cdef.zone, cdef.subtotal)));
      r++;
    });
  });
  const lastRow = r - 1;

  ws['!merges'] = merges;
  ws['!cols'] = _hrxColWidths(layout);
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: layout.mainCols - 1 } });
  if (list.length) {
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: headerRow, c: 0 }, e: { r: lastRow, c: layout.mainCols - 1 } }) };
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, _hrxSheetName(opts.sheetName || opts.title || formDef.name));
  return wb;
}

/** Builds the workbook and triggers a browser download — same Blob + temp-anchor pattern
    form-records.js's plain downloadCsv() already uses. */
function downloadPayrollWorkbook(records, formDef, opts) {
  opts = opts || {};
  const wb = buildPayrollWorkbook(records, formDef, opts);
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.filename || 'payroll.xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Printable payroll summary (register) ----------
   The same three sections as the workbook — SUMMARY, BY DEPARTMENT, and the per-department
   payroll list — as one A4-landscape HTML page for form-records.js's "Print Summary" preview
   (wrapped by UI.printableHtml there). Same computePayrollExportData() totals and the same
   HR_PAYROLL_ZONES columns, so the printout always matches the screen and the Excel file.
   Paper is narrower than a sheet, so a column that's blank/zero for every payslip in view
   (e.g. Night Differential in a period nobody worked nights) is left out; the zone subtotals
   and Net Pay always stay. Pure string building — no DOM, unit-testable. */

const _HRX_COUNT_KEYS = new Set(['days_worked', 'days_absent', 'days_half', 'days_undertime', 'ot_hours']);
const _HRX_RATE_KEYS = new Set(['daily_rate', 'ot_rate_hour']);

function _hrxEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _hrxFmt(key, v) {
  const n = Number(v) || 0;
  if (_HRX_COUNT_KEYS.has(key)) return n ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const HR_PAYROLL_SUMMARY_CSS = `
  @page { size: A4 landscape; margin: 10mm; }
  body { padding: 0; font-size: 10px; }
  @media screen { body { padding: 16px; } }
  .ps-head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #16243d; padding-bottom: 6px; margin-bottom: 10px; }
  .ps-head h1 { margin: 0; font-size: 16px; }
  .ps-head .ps-co { font-size: 12px; font-weight: 600; color: #444; }
  .ps-head .ps-meta { text-align: right; font-size: 10px; color: #444; }
  .ps-sec { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; margin: 12px 0 4px; color: #16243d; }
  .ps-totals { display: flex; border: 1px solid #c6d4e6; }
  .ps-totals > div { flex: 1; padding: 6px 10px; border-right: 1px solid #c6d4e6; }
  .ps-totals > div:last-child { border-right: 0; background: #e3f6ec; }
  .ps-totals .l { font-size: 9px; color: #555; }
  .ps-totals .v { font-size: 14px; font-weight: 700; }
  table.ps { width: 100%; border-collapse: collapse; font-size: 8.5px; }
  table.ps th, table.ps td { border: 1px solid #c6d4e6; padding: 2px 4px; }
  table.ps th { background: #f4f7fb; font-weight: 600; text-align: center; }
  table.ps th.zone { background: #16243d; color: #fff; }
  table.ps td.n { text-align: right; white-space: nowrap; }
  table.ps td.b, table.ps th.b { font-weight: 700; }
  table.ps tr.dept td { background: #e8eaf9; font-weight: 700; }
  table.ps tr.sub td { background: #f5f8fc; font-weight: 700; }
  table.ps tr.grand td { background: #fdf2e0; font-weight: 700; border-top: 2px solid #16243d; }
  table.ps tr { page-break-inside: avoid; }
  .ps-sign { display: flex; gap: 40px; margin-top: 36px; page-break-inside: avoid; }
  .ps-sign > div { flex: 1; font-size: 10px; }
  .ps-sign .line { border-top: 1px solid #222; margin-top: 30px; padding-top: 3px; text-align: center; }
`;

/** records/formDef: same as buildPayrollWorkbook. opts.title (period name), opts.subtitle,
    opts.company ({name}), opts.dateRange ("start – end"), opts.printedAt (string). */
function buildPayrollSummaryHtml(records, formDef, opts) {
  opts = opts || {};
  const list = records || [];
  const { totals, departments } = computePayrollExportData(list);
  const M = (v) => _hrxFmt('', v);

  // Columns: every zone field that has a non-zero value somewhere in view, plus the zone
  // subtotals/Net Pay unconditionally. A zone left with no columns drops out entirely.
  const used = (key) => list.some((r) => Number(r.data && r.data[key]) || 0);
  const zones = HR_PAYROLL_ZONES.map((z) => ({
    ...z,
    cols: z.fields
      .filter(([key, , subtotal]) => subtotal || used(key))
      .map(([key, fallback, subtotal]) => ({ key, label: _hrxFieldLabel(formDef, key, fallback), subtotal: !!subtotal })),
  })).filter((z) => z.cols.length);
  const allCols = zones.flatMap((z) => z.cols);
  const colSum = (rows, key) => rows.reduce((s, r) => s + (Number(r.data[key]) || 0), 0);
  // Rates aren't additive — a subtotal row leaves them blank instead of summing them.
  const sumRow = (cls, label, rows) => `<tr class="${cls}"><td>${_hrxEsc(label)}</td>${allCols.map((c) =>
    `<td class="n">${_HRX_RATE_KEYS.has(c.key) ? '' : _hrxFmt(c.key, colSum(rows, c.key))}</td>`).join('')}</tr>`;

  const payDates = [...new Set(list.map((r) => r.data && r.data.pay_date).filter(Boolean))];
  const meta = [
    opts.dateRange ? `Period: ${_hrxEsc(opts.dateRange)}` : '',
    payDates.length === 1 ? `Pay Date: ${_hrxEsc(payDates[0])}` : '',
    _hrxEsc(opts.subtitle || `${list.length} payslip${list.length === 1 ? '' : 's'}`),
    opts.printedAt ? `Printed ${_hrxEsc(opts.printedAt)}` : '',
  ].filter(Boolean).join('<br>');

  const totalsBox = [
    ['Total Gross', totals.gross], ['Statutory (SSS/PhilHealth/Pag-IBIG/Tax)', totals.statutory],
    ['Other Deductions', totals.otherDeductions], ['Total Deductions', totals.totalDeductions], ['Total Net Pay', totals.net],
  ].map(([l, v]) => `<div><div class="l">${l}</div><div class="v">${M(v)}</div></div>`).join('');

  const deptTable = departments.length > 1 ? `
    <div class="ps-sec">BY DEPARTMENT</div>
    <table class="ps"><thead><tr><th style="text-align:left">Department</th><th>Employees</th><th>Gross</th><th>Statutory</th><th>Other Deductions</th><th>Total Deductions</th><th>Net Pay</th></tr></thead>
    <tbody>${departments.map((d) => `<tr><td>${_hrxEsc(d.name)}</td><td class="n">${d.count}</td><td class="n">${M(d.gross)}</td><td class="n">${M(d.statutory)}</td><td class="n">${M(d.otherDeductions)}</td><td class="n">${M(d.totalDeductions)}</td><td class="n b">${M(d.net)}</td></tr>`).join('')}
      <tr class="grand"><td>TOTAL</td><td class="n">${totals.count}</td><td class="n">${M(totals.gross)}</td><td class="n">${M(totals.statutory)}</td><td class="n">${M(totals.otherDeductions)}</td><td class="n">${M(totals.totalDeductions)}</td><td class="n">${M(totals.net)}</td></tr>
    </tbody></table>` : '';

  const multiDept = departments.length > 1;
  const body = departments.map((d) => {
    const rows = [...d.records].sort((a, b) => String(a.data.employee_name || '').localeCompare(String(b.data.employee_name || '')));
    return (multiDept ? `<tr class="dept"><td colspan="${allCols.length + 1}">${_hrxEsc(d.name)} (${d.count})</td></tr>` : '') +
      rows.map((r) => `<tr><td>${_hrxEsc(r.data.employee_name || '')}</td>${allCols.map((c) =>
        `<td class="n${c.subtotal ? ' b' : ''}">${_hrxFmt(c.key, r.data[c.key])}</td>`).join('')}</tr>`).join('') +
      (multiDept ? sumRow('sub', `Subtotal — ${d.name}`, d.records) : '');
  }).join('');

  return `<style>${HR_PAYROLL_SUMMARY_CSS}</style>
    <div class="ps-head">
      <div>${opts.company && opts.company.name ? `<div class="ps-co">${_hrxEsc(opts.company.name)}</div>` : ''}
        <h1>Payroll Summary — ${_hrxEsc(opts.title || formDef.name || 'HR Payroll')}</h1></div>
      <div class="ps-meta">${meta}</div>
    </div>
    ${opts.copyNotice ? `<p style="font-weight:bold;border:2px solid #222;padding:8px">${_hrxEsc(opts.copyNotice)}</p>` : ''}
    <div class="ps-sec">SUMMARY</div>
    <div class="ps-totals">${totalsBox}</div>
    ${deptTable}
    <div class="ps-sec">PAYROLL</div>
    <table class="ps">
      <thead>
        <tr><th rowspan="2" style="text-align:left;min-width:110px">Employee</th>${zones.map((z) => `<th class="zone" colspan="${z.cols.length}">${z.label}</th>`).join('')}</tr>
        <tr>${allCols.map((c) => `<th${c.subtotal ? ' class="b"' : ''}>${_hrxEsc(c.label)}</th>`).join('')}</tr>
      </thead>
      <tbody>${body}${sumRow('grand', 'GRAND TOTAL', list)}</tbody>
    </table>
    <div class="ps-sign">
      <div>Prepared by:<div class="line">Signature over printed name</div></div>
      <div>Checked by:<div class="line">Signature over printed name</div></div>
      <div>Approved by:<div class="line">Signature over printed name</div></div>
    </div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computePayrollExportData, buildPayrollWorkbook, downloadPayrollWorkbook, buildPayrollSummaryHtml };
}
