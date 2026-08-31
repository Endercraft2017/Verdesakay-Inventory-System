/**
 * Per-tenant AI (LLM) configuration — same BYO pattern as src/mailer.ts. Each tenant can
 * set their own OpenAI-compatible API key (encrypted at rest via src/secrets.ts), model
 * and endpoint; if unset, the platform-wide `CEREBRAS_*` env vars are the fallback.
 * Stored in the `settings` k/v store, so it's per-tenant for free.
 *
 * Also holds an admin-settable **token cap**: a running count of tokens consumed (summed
 * from each LLM response's `usage.total_tokens`, across every step of the agentic loop —
 * not just one call per chat turn) against an optional ceiling. This is a workspace-level
 * spend guard the admin sets for themselves, distinct from src/quota.ts's `ai_calls_month`
 * (a SaaS *plan-tier* call-count limit that's a no-op for the self-hosted default tenant —
 * this token cap works for every tenant, including self-hosted, and counts tokens actually
 * spent, not just calls made).
 */
import { getSetting, setSetting } from './db';
import { encryptSecret, decryptSecret } from './secrets';

const CONFIG_KEY = 'ai_config';
const SECRET_KEY = 'ai_api_key';
const USAGE_KEY = 'ai_tokens_used';

export interface AiConfig {
  /** Model name passed to the chat-completions API. */
  model: string;
  /** OpenAI-compatible chat-completions endpoint. */
  base_url: string;
  /** Token cap (0 = unlimited). Once ai_tokens_used reaches this, chat is refused. */
  token_cap: number;
}

/** Platform default: Google Gemini Flash-Lite ("mini") via its OpenAI-compatible endpoint
    — modest reasoning, very large context window, cheap. Any OpenAI-compatible provider
    works; a tenant sets its own under AI Assistant → AI settings. Env vars
    (`AI_*`, or the legacy `CEREBRAS_*`) override the platform defaults. */
const DEFAULTS: AiConfig = {
  model: process.env.AI_MODEL || process.env.CEREBRAS_MODEL || 'gemini-2.5-flash-lite',
  base_url: process.env.AI_BASE_URL || process.env.CEREBRAS_URL
    || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  token_cap: 0,
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

function storedConfig(): AiConfig {
  return { ...DEFAULTS, ...(getSetting<Partial<AiConfig>>(CONFIG_KEY) || {}) };
}

export function tokensUsed(): number {
  return getSetting<number>(USAGE_KEY) || 0;
}

/** True once a positive cap has been reached (0/unset cap never blocks). */
export function tokenCapReached(): boolean {
  const cap = storedConfig().token_cap;
  return cap > 0 && tokensUsed() >= cap;
}

/** Add `n` tokens (from one LLM response's usage.total_tokens) to the running total.
    Called once per LLM call, not once per chat turn — a single turn can make several
    calls across the agentic tool-use loop, and every one of them costs real tokens. */
export function addTokenUsage(n: number): void {
  if (!n || n < 0) return;
  setSetting(USAGE_KEY, tokensUsed() + Math.round(n));
}

export function resetTokenUsage(): void {
  setSetting(USAGE_KEY, 0);
}

/** Config for a request. `has_key` reflects whichever key is in effect; the key itself
    is never returned. `key_source` tells the admin where it's coming from. */
export function getAiConfig(): AiConfig & { has_key: boolean; key_source: 'tenant' | 'platform' | 'none'; tokens_used: number } {
  const s = storedConfig();
  const tenantKey = !!decryptSecret(getSetting<string>(SECRET_KEY) || '');
  const envKey = envKeyPresent();
  return {
    ...s,
    has_key: tenantKey || envKey,
    key_source: tenantKey ? 'tenant' : envKey ? 'platform' : 'none',
    tokens_used: tokensUsed(),
  };
}

/** Full config for the chat route (includes the resolved key). */
export function activeAiConfig(): AiConfig & { api_key: string } {
  return { ...storedConfig(), api_key: resolvedAiKey() };
}

export function saveAiConfig(input: { model?: string; base_url?: string; api_key?: string; token_cap?: number }): void {
  const prev = storedConfig();
  setSetting(CONFIG_KEY, {
    model: (input.model ?? prev.model).trim() || DEFAULTS.model,
    base_url: (input.base_url ?? prev.base_url).trim() || DEFAULTS.base_url,
    token_cap: input.token_cap != null ? Math.max(0, Math.floor(input.token_cap)) : prev.token_cap,
  });
  if (typeof input.api_key === 'string') {
    // present but empty ⇒ clear (fall back to env); non-empty ⇒ replace; undefined ⇒ leave
    setSetting(SECRET_KEY, input.api_key ? encryptSecret(input.api_key) : '');
  }
}
