import { Router } from 'express';
import { requireAuth } from '../../shared/auth';
import { FORM_SOURCES, NUMERIC_SOURCE_FIELDS, sourceAvailable, sourceRows, type Source } from './sources';
const router=Router();router.use(requireAuth);
router.get('/data-forms/sources',(req,res)=>res.json(Object.entries(FORM_SOURCES).map(([key,source])=>({key,...source,numeric_fields:NUMERIC_SOURCE_FIELDS[key as Source],available:sourceAvailable(key as Source,req.user!)}))));
router.get('/data-forms/sources/:source',(req,res)=>{
  const source=String(req.params.source);
  if(!Object.hasOwn(FORM_SOURCES,source)){res.status(404).json({error:'Unknown form source'});return;}
  const id=req.query.id===undefined?undefined:Number(req.query.id);
  if(id!==undefined&&(!Number.isSafeInteger(id)||id<1)){res.status(400).json({error:'Invalid selected record'});return;}
  res.json(sourceRows(source as Source,req.user!,String(req.query.q||'').slice(0,100),id));
});
export default router;
