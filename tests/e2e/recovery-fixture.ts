import { createHash } from 'node:crypto';
export const recoveryUsername = 'browser-recovery';
// Synthetic, disposable browser fixture; not a deployed recovery credential.
export const recoveryFixtureToken = createHash('sha256').update('synthetic browser recovery scenario').digest('hex');
export const cancellationId = '11111111-1111-4111-8111-111111111111';
export const cancellationNonce = createHash('sha256').update('synthetic cancellation fixture').digest('hex');
export const cancellationFixtureToken = cancellationId + '.' + cancellationNonce;
