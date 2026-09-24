/** The typed query builder (src/shared/qb.ts): the checked-in schema types must match what
    createSchema()/migrate() actually build (the drift guard), and compiled queries must run
    through the normal sync helpers against the active tenant DB. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setupApp, cleanup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(() => cleanup(ctx));

describe('db-types.ts', () => {
  it('is up to date with the schema (run `npm run db:types` after a schema change)', async () => {
    const { activeDb } = await import('../src/shared/db');
    const { renderDbTypes } = await import('../src/shared/db-types-codegen');
    const onDisk = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'shared', 'db-types.ts'), 'utf8');
    expect(onDisk.replace(/\r\n/g, '\n')).toBe(renderDbTypes(activeDb()));
  });
});

describe('qb helpers', () => {
  it('compiles and runs insert/select/update/delete, binding booleans as 0/1', async () => {
    const { qb, all, first, exec } = await import('../src/shared/qb');
    const info = exec(qb.insertInto('tasks').values({ user_id: 1, title: 'qb probe', done: 0 }));
    const id = Number(info.lastInsertRowid);
    expect(first(qb.selectFrom('tasks').select(['title', 'done']).where('id', '=', id))).toEqual({ title: 'qb probe', done: 0 });

    exec(qb.updateTable('tasks').set({ done: true as unknown as number }).where('id', '=', id));
    expect(first(qb.selectFrom('tasks').select('done').where('id', '=', id))!.done).toBe(1);

    expect(all(qb.selectFrom('tasks').select('id').where('title', '=', 'qb probe'))).toHaveLength(1);
    expect(exec(qb.deleteFrom('tasks').where('id', '=', id)).changes).toBe(1);
  });
});
