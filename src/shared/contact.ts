/** Search keys only; never replace the customer's original contact values. */
export function normalizePhone(value: string | null | undefined): string {
  const digits = (value || '').replace(/\D/g, '');
  return /^639\d{9}$/.test(digits) ? '0' + digits.slice(2) : digits;
}
export const normalizeEmail = (value: string | null | undefined): string => (value || '').trim().toLowerCase();
