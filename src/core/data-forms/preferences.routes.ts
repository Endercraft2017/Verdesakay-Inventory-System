import { Router } from 'express';
import { z } from 'zod';
import { queryOne, run } from '../../shared/db';
import { requireAuth } from '../../shared/auth';
import { parseBody } from '../../shared/validation';
import { now } from '../../shared/sync-context';
import { syncClass } from '../../sync';
import { canAccessRecords } from './policy';
import type { FormDefinition } from '../../shared/types';

const router=Router(); router.use(requireAuth);
type Filter={id:string;name:string;q:string;status:string;period:string};
type View={columns?:string[];filters?:Filter[]};
type Preferences={favorites:number[];recent:Array<{form_id:number;at:string}>;views:Record<string,View>};
function read(userId:number):Preferences {
  const row=queryOne<{favorites:string;recent:string;views:string}>('SELECT * FROM form_user_preferences WHERE user_id=?',userId);
  return row?{favorites:JSON.parse(row.favorites),recent:JSON.parse(row.recent),views:JSON.parse(row.views)}:{favorites:[],recent:[],views:{}};
}
const change=z.discriminatedUnion('action',[
  z.object({action:z.literal('favorite'),form_id:z.number().int().positive(),enabled:z.boolean()}),
  z.object({action:z.literal('recent'),form_id:z.number().int().positive()}),
  z.object({action:z.literal('columns'),form_id:z.number().int().positive(),columns:z.array(z.string().regex(/^[a-z0-9_]+$/).max(64)).max(12).nullable()}),
  z.object({action:z.literal('save_filter'),form_id:z.number().int().positive(),filter:z.object({id:z.string().min(1).max(64),name:z.string().trim().min(1).max(80),q:z.string().max(200).default(''),status:z.string().max(40).default(''),period:z.string().max(200).default('')})}),
  z.object({action:z.literal('delete_filter'),form_id:z.number().int().positive(),filter_id:z.string().max(64)}),
]);
router.get('/data-forms/preferences',(req,res)=>res.json(read(req.user!.id)));
router.put('/data-forms/preferences',syncClass('merge'),(req,res)=>{
  const input=parseBody(change,req.body),form=queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id=?',input.form_id);
  if(!form){res.status(404).json({error:'Form not found'});return;}
  if(!canAccessRecords(req,res,form,false))return;
  const prefs=read(req.user!.id),key=String(form.id),view=prefs.views[key]||{};
  if(input.action==='favorite') prefs.favorites=[...prefs.favorites.filter(id=>id!==form.id),...(input.enabled?[form.id]:[])].slice(-50);
  if(input.action==='recent') prefs.recent=[{form_id:form.id,at:now().toISOString()},...prefs.recent.filter(row=>row.form_id!==form.id)].slice(0,20);
  if(input.action==='columns'){if(input.columns===null)delete view.columns;else view.columns=[...new Set(input.columns)];prefs.views[key]=view;}
  if(input.action==='save_filter'){view.filters=[...(view.filters||[]).filter(filter=>filter.id!==input.filter.id),input.filter].slice(-15);prefs.views[key]=view;}
  if(input.action==='delete_filter'){view.filters=(view.filters||[]).filter(filter=>filter.id!==input.filter_id);prefs.views[key]=view;}
  run('INSERT INTO form_user_preferences(user_id,favorites,recent,views,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET favorites=excluded.favorites,recent=excluded.recent,views=excluded.views,updated_at=excluded.updated_at',req.user!.id,JSON.stringify(prefs.favorites),JSON.stringify(prefs.recent),JSON.stringify(prefs.views),now().toISOString());
  res.json(prefs);
});
export default router;
