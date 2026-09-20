/**
 * AI knowledge-search tool — `search_knowledge`. Wraps src/rag.ts retrieval.
 * Available to any authenticated user; results are ACL-filtered per chunk in
 * `retrieve()`, so a user only ever sees passages they're permitted to.
 */
import { retrieve } from './rag';
import type { CerebrasTool, ToolResult } from './ai-tools';
import type { AuthUser } from '../../shared/types';

const SPEC: CerebrasTool = {
  type: 'function',
  function: {
    name: 'search_knowledge',
    description:
      'Search the unstructured text in the system — uploaded files & policies, item / order / job-order notes, QC failure remarks, leave/OT form details, and the app documentation — and return the most relevant passages. Use this for "what does our policy say", "why did QC keep failing", "find the note about X" questions. For counts, totals and rankings use the analytics tools instead.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for.' },
        source_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional filter: kb, form, form_record, item_note, qc_remark, order_note, job_order_note, employee_doc.',
        },
      },
      required: ['query'],
    },
  },
};

export function ragToolsForUser(_user: AuthUser): CerebrasTool[] {
  return [SPEC];
}

export function isRagTool(name: string): boolean {
  return name === 'search_knowledge';
}

export function executeRagTool(name: string, args: unknown, user: AuthUser): ToolResult {
  if (name !== 'search_knowledge') return { success: false, error: `Unknown tool: ${name}` };
  const a = (args ?? {}) as Record<string, unknown>;
  const query = typeof a.query === 'string' ? a.query : '';
  if (!query.trim()) return { success: false, error: 'Provide a search query.' };
  const source_types = Array.isArray(a.source_types)
    ? a.source_types.filter((x): x is string => typeof x === 'string')
    : undefined;

  const results = retrieve(query, user, { source_types, k: 6 });
  return {
    success: true,
    data: {
      query,
      results,
      note: results.length
        ? 'Answer from these passages and cite their "ref" labels. If they do not cover it, say so.'
        : 'No matching passages in the knowledge base.',
    },
  };
}
