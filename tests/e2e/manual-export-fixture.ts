import {createHash} from 'node:crypto';
export const manualUsername='manual-export-browser';
export const manualPassword='Synthetic manual export confirmation password';
export const manualToken=createHash('sha256').update('synthetic stale manual-export session').digest('hex');
