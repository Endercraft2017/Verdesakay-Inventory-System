import {Router} from 'express';
import {z} from 'zod';
import {requirePermission} from '../../shared/auth';
import {freshVerificationFor} from '../../shared/step-up';
import {parseBody} from '../../shared/validation';
import {syncClass,DEPLOY_MODE} from '../../sync';
import {emailPreflight,reviewPayrollEmail,confirmPayrollEmail,cancelPayrollEmail} from './payroll-email';
const router=Router({mergeParams:true});
const requireFreshVerification=freshVerificationFor('release payslip email');
const id=z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const review=z.object({source_stamp:z.string().regex(/^[a-f0-9]{64}$/),retry_of:z.string().uuid().optional(),reason:z.string().trim().min(10).max(200).optional(),evidence_reference:z.string().trim().min(3).max(120).optional(),duplicate_risk_acknowledged:z.literal(true).optional()}).strict();
const confirm=z.object({review_id:z.string().uuid(),review_token:z.string().min(40).max(100)}).strict();
router.use(requirePermission('payroll.manage'),(_req,res,next)=>{
 res.set('Cache-Control','private, no-store');
 // Enrollment can be incomplete or restored separately from the process configuration.
 // Never acknowledge cloud-only work in an installed process, even without sync_node.
 if(DEPLOY_MODE==='node'){res.status(503).json({error:'Payslip email release requires the cloud connection.',sync:'online'});return;}
 next();
});
router.get('/',syncClass('online'),(req,res)=>{res.json(emailPreflight(parseBody(id,(req.params as Record<string,string>).recordId)));});
router.post('/',syncClass('online'),(req,res)=>{emailPreflight(parseBody(id,(req.params as Record<string,string>).recordId));res.status(409).json({error:'Review the recipient and exact saved email content, then confirm release. Reload the updated app.',review_required:true});});
router.post('/review',syncClass('online'),requireFreshVerification,(req,res)=>{const input=parseBody(review,req.body);res.json(reviewPayrollEmail(parseBody(id,req.params.recordId),{id:req.user!.id,token:req.token!},input.source_stamp,input));});
router.post('/confirm',syncClass('online'),requireFreshVerification,(req,res)=>{const input=parseBody(confirm,req.body);res.status(202).json(confirmPayrollEmail(parseBody(id,req.params.recordId),input.review_id,input.review_token,{id:req.user!.id,token:req.token!}));});
router.post('/:releaseId/cancel',syncClass('online'),requireFreshVerification,(req,res)=>{parseBody(z.object({}).strict(),req.body);res.json(cancelPayrollEmail(parseBody(id,req.params.recordId),parseBody(z.string().uuid(),req.params.releaseId),req.user!.id));});
export default router;
