/** Independent tenant-local append-only tool evidence. Never persist raw personal data or keys. */
import crypto from 'node:crypto';
import { run } from '../../shared/db';
export function auditTool(event: { requestId: string; actor: number; tool: string; phase: 'start' | 'complete' | 'failed'; value: unknown; success?: boolean }): void {
  const value = JSON.stringify(event.value) ?? 'null';
  run(`INSERT INTO ai_tool_audit (request_id, actor_id, tool, phase, payload_sha256, success)
       VALUES (?, ?, ?, ?, ?, ?)`, event.requestId, event.actor, event.tool.slice(0, 100), event.phase,
    crypto.createHash('sha256').update(value).digest('hex'), event.success === undefined ? null : event.success ? 1 : 0);
}
