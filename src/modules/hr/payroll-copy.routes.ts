import {Router} from 'express';
import {requirePermission} from '../../shared/auth';
import {payrollCopy} from '../payroll/payroll-copy';
import {stablePayrollId} from '../payroll/payroll-source';
const router=Router();
// Read-only and available on an installed node against its current replica. No queued action.
router.get('/payroll/copy',requirePermission('payroll.view'),(req,res)=>{
  res.set('Cache-Control','private, no-store');
  const {form_id,ids,expected}=req.query;
  const formId=stablePayrollId(form_id);
  if(Object.keys(req.query).some(key=>!['form_id','ids','expected'].includes(key))||!formId||typeof ids!=='string'||ids.length>4000||!/^\d+(,\d+)*$/.test(ids)||
    (expected!==undefined&&(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)))){
    res.status(400).json({error:'Select 1–200 distinct saved payslips and a valid payroll form.'});return;
  }
  const recordIds=ids.split(',').map(stablePayrollId);
  if(recordIds.length>200||recordIds.some(id=>id==null)||new Set(recordIds).size!==recordIds.length){
    res.status(400).json({error:'Select 1–200 distinct saved payslips.'});return;
  }
  res.json(payrollCopy(formId,recordIds as number[],expected as string|undefined));
});
export default router;
