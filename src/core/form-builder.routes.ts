/** Data forms API: definitions, records and shared template variables. */
import { Router } from 'express';
import preferences from './data-forms/preferences.routes';
import definitions from './data-forms/definitions.routes';
import records from './data-forms/records.routes';
import variables from './data-forms/variables.routes';

const router = Router();
router.use(preferences);
router.use(definitions);
router.use(records);
router.use(variables);
export default router;
