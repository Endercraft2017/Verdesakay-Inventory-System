/** Read-only comparison, not a payment or tax-filing confirmation. */
import {db,queryOne} from '../../shared/db';
import {now} from '../../shared/sync-context';
import {payrollSourceIndex,cutoffPayrollSources,PayrollSourceError} from '../payroll/payroll-source';
import {payrollLedgerDocument,livePayrollEntries,payrollJournalLines,validPayrollJournal} from './payroll-ledger-source';
import {buildPayrollEntry} from './accounting-posting';
import {getPostingRules,ledgerEnabled} from './accounting-autopost';

function closed(date: string): boolean {
  return !!queryOne("SELECT id FROM accounting_periods WHERE status='closed' AND ? BETWEEN start_date AND end_date",date);
}
function totals(lines: {account_id:number;debit?:number;credit?:number;party_type?:string|null;party_id?:number|null}[]) {
  const groups = new Map<string,{account_id:number;debit:number;credit:number;party_type:string|null;party_id:number|null}>();
  for (const l of lines) {
    const key=JSON.stringify([l.account_id,l.party_type??null,l.party_id??null]);
    const v=groups.get(key)??{account_id:l.account_id,debit:0,credit:0,party_type:l.party_type??null,party_id:l.party_id??null};
    v.debit+=Math.round(Number(l.debit||0)*100);v.credit+=Math.round(Number(l.credit||0)*100);groups.set(key,v);
  }
  return [...groups.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export function payrollReconciliation(periodId: number, requestedLabel?: string) {
  db.exec('SAVEPOINT payroll_reconciliation');
  try {
    const index=payrollSourceIndex(),period=index.periods.get(periodId);
    if(!period)throw Object.assign(new Error('Cutoff not found'),{status:404});
    const selected=cutoffPayrollSources(index,periodId,requestedLabel);
    const issues=[...selected.issues],recordIds=new Set(selected.record_ids);
    let doc:ReturnType<typeof payrollLedgerDocument>=null;
    if(!issues.length)try{doc=payrollLedgerDocument(period,selected.rows);}catch(e){
      if(!(e instanceof PayrollSourceError))throw e;
      issues.push(...e.issues);for(const id of e.record_ids)recordIds.add(id);
    }
    const live=livePayrollEntries(periodId);
    const enabled=ledgerEnabled(),built=doc?buildPayrollEntry(doc,getPostingRules(),periodId):null;
    const expected=built?.ok?totals(built.entry.lines):null;
    const lines=live.length===1?payrollJournalLines(live[0]!.id):[];
    const validJournal=live.length===1&&validPayrollJournal(live[0]!.book,lines);
    const actual=validJournal?totals(lines):null;
    const state=issues.length?'blocked':!enabled?'ledger_off':live.length>1?'multiple_live_journals':live.length===1&&!validJournal?'invalid_journal':!doc?'empty':!built?.ok?'unpostable':!live.length?'missing'
      :live[0]!.entry_date===doc.date && live[0]!.book==='payroll' && JSON.stringify(actual)===JSON.stringify(expected)?'matches':'differs';
    const closedPeriod=!!doc && (closed(doc.date)||(live.length>0&&(closed(now().toISOString().slice(0,10))||live.some(e=>closed(e.entry_date)))));
    const result={
      cutoff:period,
      issues:[...new Set(issues)],record_ids:[...recordIds].slice(0,100),issue_record_count:recordIds.size,
      source:{record_count:selected.rows.length,draft_count:selected.rows.filter(r=>r.raw.status==='draft').length,paid_count:selected.rows.filter(r=>r.raw.status==='paid').length,
        gross_total:doc?.gross_total??null,net_pay_total:doc?.net_pay_total??null,pay_date:doc?.date??null},
      ledger:{state,entries:live.slice(0,20),live_entry_count:live.length,closed_period:closedPeriod,
        can_post:enabled&&!issues.length&&!!built?.ok&&live.length<=1&&(!live.length||validJournal)&&!closedPeriod,
        validation_error:built&&!built.ok?built.error:null,
        expected_debit:expected?expected.reduce((s,l)=>s+l.debit,0)/100:null,
        expected_credit:expected?expected.reduce((s,l)=>s+l.credit,0)/100:null,
        actual_debit:actual?actual.reduce((s,l)=>s+l.debit,0)/100:null,
        actual_credit:actual?actual.reduce((s,l)=>s+l.credit,0)/100:null},
      payment_verification:'not_linked',
      note:'Paid marks record an operator decision. Bank payment, agency remittance and tax filing evidence are not linked or verified by this comparison.',
    };
    db.exec('RELEASE payroll_reconciliation');return result;
  } catch(e){db.exec('ROLLBACK TO payroll_reconciliation; RELEASE payroll_reconciliation');throw e;}
}
