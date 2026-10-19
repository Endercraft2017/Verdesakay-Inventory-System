/** Public validation is authored by us; storage/provider exceptions are never public. */
import type { NextFunction } from 'express';
import { ValidationError } from '../shared/validation';

export function forwardControlPlaneError(error: unknown, next: NextFunction): void {
  // Discard untrusted message/status/expose properties before the central handler.
  next(error instanceof ValidationError ? error : new Error('Control-plane operation failed'));
}
