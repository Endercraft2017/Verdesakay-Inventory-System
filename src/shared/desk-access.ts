/**
 * Which shop-floor desks may read which shared data — the one list every read gate uses, so a
 * floor role sees its own desk and nothing more (user decision 2026-10-06: "only their own
 * desk"). The broad view permissions still open everything they always did:
 *   inventory.view  — the item catalogue, stock, locations, suppliers …
 *   production.view — every job order, batch, repair, issue and the production record
 * A desk permission adds only the reads that desk's own task makes:
 *   LINE    production lead / manager (record, pause, manage, approve)
 *   INSPECT QC / QA inspectors and QA-hold deciders
 *   PARTS   the parts clerk (repair-parts requests)
 *   RTS     the products-in / ready-to-sell clerk
 *   RELEASE the releasing clerk (sale-order warehouse-out)
 * Use with requireAnyPermission([broad, ...desks]). An admin widens a role in Roles by ticking
 * the broad permission. tests/access-matrix.test.ts holds every built-in role to this.
 */
import type { Permission } from './types';

export const LINE: Permission[] = ['production.record', 'production.pause', 'production.manage', 'production.approve'];
export const INSPECT: Permission[] = ['production.inspect_qc', 'production.inspect_qa', 'production.qa_review'];
export const PARTS: Permission[] = ['production.repairs'];
export const RTS: Permission[] = ['production.receive'];
export const RELEASE: Permission[] = ['orders.release'];

/** Picking a component by name or code: a parts request (inspectors) or a revision (parts clerk). */
export const ITEM_PICKER: Permission[] = [...INSPECT, ...PARTS];
/** The storage-location list: where ready-to-sell stock goes. */
export const LOCATION_PICKER: Permission[] = [...RTS];
/** The job-order list: the line runs its own job orders. */
export const JOB_ORDER_LIST: Permission[] = [...LINE];
/** One job order and its units / checklist / receivable output: every production desk works on one. */
export const JOB_ORDER_DETAIL: Permission[] = [...LINE, ...INSPECT, ...PARTS, ...RTS];
/** Repair-parts requests: raised by inspectors, issued by the parts clerk, worked by the line. */
export const REPAIRS_READ: Permission[] = [...PARTS, ...INSPECT, ...LINE];
/** A unit's production record (scan → record): any desk that handles the unit. */
export const UNIT_RECORD: Permission[] = [...LINE, ...INSPECT, ...PARTS, ...RTS, ...RELEASE];
/** Unit / batch label templates: printed when units are recorded and when they are received. */
export const LABEL_TEMPLATES: Permission[] = [...LINE, ...RTS];
/** QC / QA checklists: run by the inspectors. */
export const CHECKLISTS: Permission[] = [...INSPECT];
/** Photos on a unit (QC evidence, the build photo): whoever handles the unit. */
export const UNIT_PHOTOS: Permission[] = [...LINE, ...INSPECT, ...PARTS, ...RTS];
