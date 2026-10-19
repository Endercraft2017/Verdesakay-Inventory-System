/** Public credential/request-verifier CPU/memory budget. One scrypt job uses about 128 MiB; never create an unbounded backlog. */
const MAX_QUEUED = 8;
const MAX_WAIT_MS = 10_000;
let active = 0;
const pending: Array<() => void> = [];

export class PasswordWorkBusyError extends Error {
  readonly status = 503;
  constructor() { super('Sign-in is busy. Try again shortly.'); }
}

/** Internal operational counters only; never expose credentials or account identifiers. */
export function passwordWorkState(): { active: number; queued: number } {
  return { active, queued: pending.length };
}

export function withPasswordWork<T>(work: () => Promise<T>): Promise<T> {
  if (active && pending.length >= MAX_QUEUED) return Promise.reject(new PasswordWorkBusyError());
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      if (timer) clearTimeout(timer);
      active++;
      const finish = () => { active--; pending.shift()?.(); };
      Promise.resolve().then(work).then(
        value => { finish(); resolve(value); },
        error => { finish(); reject(error); },
      );
    };
    if (!active) start();
    else {
      pending.push(start);
      timer = setTimeout(() => {
        const index = pending.indexOf(start);
        if (index < 0) return;
        pending.splice(index, 1);
        reject(new PasswordWorkBusyError());
      }, MAX_WAIT_MS);
      timer.unref();
    }
  });
}
