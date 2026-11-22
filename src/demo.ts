import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

type Source = 'salesforce' | 'portal';
type Event = { id: string; field: string; value: string; time: number; actor: string; source: Source };
type State = {
  seen: Record<string, Event>; fields: Record<string, Event>; history: Event[];
  pending: Event[]; attempts: number[]; crm: Record<string, string>; calls: number;
};
const empty = (): State => ({ seen: {}, fields: {}, history: [], pending: [], attempts: [], crm: {}, calls: 0 });
const load = (path: string): State => JSON.parse(readFileSync(path, 'utf8')) as State;
const save = (path: string, state: State) => writeFileSync(path, JSON.stringify(state));
const rank = (source: Source) => source === 'portal' ? 1 : 0;
function newer(a: Event, b: Event): boolean {
  return a.time > b.time || (a.time === b.time && (rank(a.source) > rank(b.source) ||
    (a.source === b.source && a.id > b.id)));
}
function apply(state: State, event: Event): boolean {
  state.history.push(event);
  const previous = state.fields[event.field];
  if (!previous || newer(event, previous)) { state.fields[event.field] = event; return true; }
  return false;
}
function inbound(state: State, event: Event): void {
  const previous = state.seen[event.id];
  if (previous) {
    assert.deepEqual(event, previous, 'same webhook ID with different payload');
    return;
  }
  state.seen[event.id] = event;
  apply(state, event);
  // Incoming changes, including echoes, never enqueue a Salesforce write.
}
function portalEdit(state: State, event: Event): void {
  if (apply(state, event)) state.pending.push(event);
}

// The fake API stores an update and generates the webhook Salesforce would send.
function fakeCrmUpdate(state: State, event: Event, now: number): Event {
  state.crm[event.field] = event.value;
  return { id: `echo-${event.id}`, field: event.field, value: event.value,
    time: now, actor: 'integration-user', source: 'salesforce' };
}

// All calls, including failed attempts and retries, use the same persisted window.
function attempt(path: string, cap: number, now: number, crmUp: boolean): 'limited' | 'failed' | 'sent' | 'empty' {
  const state = load(path);
  state.attempts = state.attempts.filter(t => now - t < 1000);
  if (!state.pending.length) return 'empty';
  if (state.attempts.length >= cap) return 'limited';
  state.attempts.push(now);
  state.calls++;
  if (!crmUp) { save(path, state); return 'failed'; }
  const work = state.pending[0];
  // Recheck that a queued field has not been superseded.
  if (state.fields[work.field]?.id !== work.id) {
    state.pending.shift(); save(path, state); return 'empty';
  }
  const echo = fakeCrmUpdate(state, work, now);
  state.pending.shift();
  inbound(state, echo);
  save(path, state);
  return 'sent';
}

const file = process.argv[3];
if (process.argv[2] === 'down') {
  assert.equal(attempt(file, 2, 100, false), 'failed');
  assert.equal(attempt(file, 2, 200, false), 'failed');
  assert.equal(attempt(file, 2, 300, false), 'limited');
  assert.equal(load(file).pending.length, 1);
  console.log('CRM down: two failed attempts (including retry) consumed the rate limit; work remains on disk.');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'sync-poc-'));
  try {
    const path = join(dir, 'state.json');
    const state = empty();
    const event = (id: string, value: string, time: number, field = 'phone'): Event =>
      ({ id, field, value, time, actor: 'sales-user', source: 'salesforce' });
    const recent = event('new', 'C', 20);
    inbound(state, recent);
    inbound(state, recent);
    assert.equal(state.history.length, 1);
    console.log('Duplicate webhook: one history entry.');
    inbound(state, event('old', 'A', 10));
    assert.equal(state.history.length, 2);
    assert.equal(state.fields.phone.value, 'C');
    console.log('Late older webhook: retained in history; current phone remains C.');
    const edit: Event = { id: 'portal-1', field: 'city', value: 'Noida', time: 30, actor: 'portal-user', source: 'portal' };
    portalEdit(state, edit);
    assert.equal(state.fields.phone.value, 'C');
    save(path, state);
    const child = spawnSync(process.execPath, [__filename, 'down', path], { encoding: 'utf8' });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, child.stderr);
    process.stdout.write(child.stdout);
    assert.equal(load(path).pending.length, 1);
    assert.equal(attempt(path, 2, 300, true), 'limited');
    console.log('After restart: pending work and rate limit survived; no call allowed yet.');
    assert.equal(attempt(path, 2, 1100, true), 'sent');
    const result = load(path);
    assert.equal(result.crm.city, 'Noida');
    assert.equal(result.pending.length, 0);
    assert.equal(result.seen['echo-portal-1'].actor, 'integration-user');
    assert.equal(result.history.filter(e => e.id === 'echo-portal-1').length, 1);
    assert.equal(result.calls, 3);
    assert.equal(attempt(path, 2, 1101, true), 'empty');
    assert.equal(load(path).calls, 3);
    console.log('Recovery: fake CRM stored city, sent echo through webhook handler, and no loop call was queued.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
