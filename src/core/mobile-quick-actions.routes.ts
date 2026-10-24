/** Account-scoped shortcut preferences. These IDs never grant work permissions. */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../shared/auth';
import { getSetting, setSetting } from '../shared/db';
import { moduleEnabled, type ModuleName } from '../shared/modules';
import { parseBody } from '../shared/validation';
import { syncClass } from '../sync';
import type { AuthUser, Permission } from '../shared/types';

export const WORK_SHORTCUTS: Record<string,{permissions:Permission[];modules:ModuleName[]}>={
  qc:{permissions:['production.inspect_qc'],modules:['manufacturing']},
  qa:{permissions:['production.inspect_qa','production.qa_review'],modules:['manufacturing']},
  repairs:{permissions:['production.repairs'],modules:['manufacturing']},
  jobs:{permissions:['production.record','production.manage','production.pause','production.approve'],modules:['manufacturing']},
  receiving:{permissions:['production.receive'],modules:['manufacturing']},
  kitscan:{permissions:['production.kit_release'],modules:['manufacturing']},
  release:{permissions:['orders.release'],modules:['sales','inventory']},
  scan:{permissions:['inventory.mobile'],modules:['inventory']},
  counts:{permissions:['inventory.count'],modules:['inventory']},
  purchasing:{permissions:['purchasing.request','purchasing.manage','purchasing.approve_requests','purchasing.issue_cash','purchasing.settle_requests'],modules:['purchasing']},
  purchaseReceive:{permissions:['inventory.receive'],modules:['inventory','purchasing']},
  deliveries:{permissions:['delivery.run'],modules:['sales']},
};
const router = Router();
router.use(requireAuth, requirePermission('mobile.access'));

function allowed(user: AuthUser) {
  return Object.keys(WORK_SHORTCUTS).filter(id => {
    const choice = WORK_SHORTCUTS[id]!;
    return choice.permissions.some(permission => user.permissions.includes(permission))
      && choice.modules.every(module => moduleEnabled(module));
  });
}

// Settings belong to the current tenant database; the authenticated ID supplies the owner.
// Existing settings replication carries the preference between cloud and site PCs.
function key(user: AuthUser) { return 'mobile.quick-actions.user.' + user.id; }
function profile(user: AuthUser) {
  const saved = getSetting<string[] | null>(key(user));
  const valid = Array.isArray(saved) && saved.length >= 1 && saved.length <= 2
    && new Set(saved).size === saved.length
    && saved.every(id => typeof id === 'string' && Object.prototype.hasOwnProperty.call(WORK_SHORTCUTS, id));
  return { shortcuts: valid ? saved : null, options: allowed(user) };
}
const selection = z.object({
  shortcuts: z.array(z.string().min(1).max(40)).min(1).max(2)
    .refine(ids => new Set(ids).size === ids.length, 'Choose different work shortcuts'),
}).strict();

router.get('/', (req, res) => {
  res.json(profile(req.user!));
});
router.put('/', syncClass('merge'), (req, res) => {
  const user = req.user!;
  const input = parseBody(selection, req.body), options = allowed(user);
  if (input.shortcuts.some(id => !options.includes(id))) {
    res.status(403).json({ error: 'A selected work shortcut is no longer available. Refresh your choices.' }); return;
  }
  setSetting(key(user), input.shortcuts);
  res.json(profile(user));
});
export default router;
