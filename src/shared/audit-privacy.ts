/** Audit history records decisions, not private document, message or salary contents. */
const PRIVATE_PATH = /^\/api\/(?:hr|me|messages|notes|tasks|bookmarks|identified-reports|confidential-reports|ai|mail|form-records|form-definitions|global-variables)(?:\/|$)/;
const PRIVATE_KEY = /pass|token|secret|hash|otp|credential|authorization|api_?key|private_?key|access_?key|key_?id|(?:^|_)(?:body|content|description|notes|memo|salary|rate|cost|price|amount|total|address|phone|email|tin|sss|philhealth|pagibig|bank)(?:_|$)/i;
export function auditPayload(value: unknown, path = '', depth = 0): unknown {
  if (PRIVATE_PATH.test(path)) {
    return { redacted: true, fields: value && typeof value === 'object' ? Object.keys(value) : [] };
  }
  if (depth > 6) return '[redacted]';
  if (Array.isArray(value)) return value.slice(0, 50).map(v => auditPayload(v, '', depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) =>
    [k, PRIVATE_KEY.test(k) ? '[redacted]' : auditPayload(v, '', depth + 1)]));
  return typeof value === 'string' && value.length > 500 ? value.slice(0, 500) + '…' : value;
}
/** Also protects retained rows created before the privacy policy was introduced. */
export function safeAuditMeta(meta: string | null, path: string): string | null {
  if (!meta) return null;
  try {
    const envelope = JSON.parse(meta);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return JSON.stringify({redacted:true});
    return JSON.stringify(Object.fromEntries(Object.entries(envelope).map(([key,value])=>
      [key, auditPayload(value,path)])));
  }
  catch { return JSON.stringify({ redacted: true }); }
}
