/**
 * Per-tenant AI (LLM) configuration — same BYO pattern as src/mailer.ts. Each tenant can
 * set their own OpenAI-compatible API key (encrypted at rest via src/secrets.ts), model
 * and endpoint; if unset, the platform-wide `CEREBRAS_*` env vars are the fallback.
 * Stored in the `settings` k/v store, so it's per-tenant for free.
 */
import { getSetting, setSetting } from './db';
import { encryptSecret, decryptSecret } from './secrets';

const CONFIG_KEY = 'ai_config';
const SECRET_KEY = 'ai_api_key';

export interface AiConfig {
  /** Model name passed to the chat-completions API. */
  model: string;
  /** OpenAI-compatible chat-completions endpoint. */
  base_url: string;
}

/** Platform default: Google Gemini Flash-Lite ("mini") via its OpenAI-compatible endpoint
    — modest reasoning, very large context window, cheap. Any OpenAI-compatible provider
    works; a tenant sets its own under AI Assistant → AI settings. Env vars
    (`AI_*`, or the legacy `CEREBRAS_*`) override the platform defaults. */
const DEFAULTS: AiConfig = {
  model: process.env.AI_MODEL || process.env.CEREBRAS_MODEL || 'gemini-2.5-flash-lite',
  base_url: process.env.AI_BASE_URL || process.env.CEREBRAS_URL
    || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
};

/** The API key actually used: the tenant's stored one, else the platform env key. */
export function resolvedAiKey(): string {
  const stored = decryptSecret(getSetting<string>(SECRET_KEY) || '');
  return stored || process.env.AI_API_KEY || process.env.CEREBRAS_API_KEY || '';
}

function envKeyPresent(): boolean {
  return !!(process.env.AI_API_KEY || process.env.CEREBRAS_API_KEY);
}

export function aiReady(): boolean {
  return !!resolvedAiKey();
}

/** Config for a request. `has_key` reflects whichever key is in effect; the key itself
    is never returned. `key_source` tells the admin where it's coming from. */
export function getAiConfig(): AiConfig & { has_key: boolean; key_source: 'tenant' | 'platform' | 'none' } {
  const s = { ...DEFAULTS, ...(getSetting<Partial<AiConfig>>(CONFIG_KEY) || {}) };
  const tenantKey = !!decryptSecret(getSetting<string>(SECRET_KEY) || '');
  const envKey = envKeyPresent();
  return {
    ...s,
    has_key: tenantKey || envKey,
    key_source: tenantKey ? 'tenant' : envKey ? 'platform' : 'none',
  };
}

/** Full config for the chat route (includes the resolved key). */
export function activeAiConfig(): AiConfig & { api_key: string } {
  const s = { ...DEFAULTS, ...(getSetting<Partial<AiConfig>>(CONFIG_KEY) || {}) };
  return { ...s, api_key: resolvedAiKey() };
}

export function saveAiConfig(input: { model?: string; base_url?: string; api_key?: string }): void {
  setSetting(CONFIG_KEY, {
    model: (input.model ?? DEFAULTS.model).trim() || DEFAULTS.model,
    base_url: (input.base_url ?? DEFAULTS.base_url).trim() || DEFAULTS.base_url,
  });
  if (typeof input.api_key === 'string') {
    // present but empty ⇒ clear (fall back to env); non-empty ⇒ replace; undefined ⇒ leave
    setSetting(SECRET_KEY, input.api_key ? encryptSecret(input.api_key) : '');
  }
}
