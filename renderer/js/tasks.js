/* Tasks — the agent's todo list, in one place.
 *
 * This module owns the whole feature:
 *   • the data model (state.tasks; scoped to a chat, or shared when unscoped);
 *   • the tool the agent calls (runTodo), used by the tool dispatcher;
 *   • the live list inside the chat, kept repaintable through an explicit
 *     registry instead of module-level DOM lookups or window globals.
 *
 * Three rules keep it honest, and every one was learned the hard way:
 *   1. A repaint may never throw into a tool call. A UI problem is a UI
 *      problem — it must not turn a successful "task created" into a failed
 *      tool call that the model then reports to the user.
 *   2. The list is READ-ONLY for the user. It is the agent's plan, so there is
 *      no checkbox to tick, no ＋ to add a task, nothing to remove. Clickable
 *      rows made it read as a chore list somebody had to finish by hand, and
 *      "why am I able to click this, did I write it?" is the only sane
 *      reaction. The single control left is the fold.
 *   3. A plan outlives nothing. When a run is stopped, fails or hits the step
 *      limit, its unfinished tasks are dropped: a list of nine untouched
 *      steps left behind by a dead run is furniture, not information.
 */
import { uid, now, esc, el } from './utils.js';

export const TASK_STATUSES = ['pending', 'doing', 'done'];
const PRIORITIES = ['low', 'normal', 'high'];
const ORDER = { doing: 0, pending: 1, done: 2 };
const MARK = { pending: '☐', doing: '◐', done: '☑' };
const LIMIT = 100;

/* ---------------- model ---------------- */

export function taskList(state) {
  if (!Array.isArray(state.tasks)) state.tasks = [];
  return state.tasks;
}

/* Tasks belonging to a chat. Tasks without a chatId are shared and visible
 * everywhere — that is how a list survives when a chat is deleted. */
export function tasksForChat(state, chatId = null) {
  return taskList(state).filter(t => !chatId || !t.chatId || t.chatId === chatId);
}

export function sortedTasks(tasks) {
  return [...tasks].sort((a, b) => ((ORDER[a.status] ?? 1) - (ORDER[b.status] ?? 1)) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
}

export function taskCounts(tasks) {
  const open = tasks.filter(t => t.status !== 'done').length;
  return { open, done: tasks.length - open, total: tasks.length };
}

export function findTask(state, id) {
  const key = String(id ?? '').replace(/^#/, '');
  return taskList(state).find(t => t.id === id || t.id === key) || null;
}

function missing(id) {
  return `Task "${id}" not found. Call the todo tool with action=list to see the current ids.`;
}

export function addTask(state, { chatId = null, title, plan = null, priority = 'normal' } = {}) {
  const clean = String(title ?? '').trim();
  if (!clean) throw new Error('A task needs a title.');
  const list = taskList(state);
  if (list.length >= LIMIT) throw new Error(`Too many tasks (limit ${LIMIT}) — remove finished ones first.`);
  const task = {
    id: uid('task'),
    chatId: chatId || null,
    title: clean.slice(0, 200),
    plan: plan ? String(plan).trim().slice(0, 300) : null,
    priority: PRIORITIES.includes(priority) ? priority : 'normal',
    status: 'pending',
    createdAt: now(), updatedAt: now()
  };
  list.push(task);
  return task;
}

export function updateTask(state, id, patch = {}) {
  const t = findTask(state, id);
  if (!t) throw new Error(missing(id));
  if (patch.title !== undefined) { const v = String(patch.title).trim(); if (v) t.title = v.slice(0, 200); }
  if (patch.plan !== undefined) t.plan = String(patch.plan || '').trim().slice(0, 300) || null;
  if (patch.priority !== undefined && PRIORITIES.includes(patch.priority)) t.priority = patch.priority;
  t.updatedAt = now();
  return t;
}

export function setTaskStatus(state, id, status) {
  if (!TASK_STATUSES.includes(status)) throw new Error('status must be one of: pending, doing, done');
  const t = findTask(state, id);
  if (!t) throw new Error(missing(id));
  t.status = status;
  t.updatedAt = now();
  return t;
}

export function removeTask(state, id) {
  const t = findTask(state, id);
  if (!t) throw new Error(missing(id));
  state.tasks = taskList(state).filter(x => x !== t);
  return t;
}

/* A run that died leaves nothing behind. Whatever the agent finished stays as
 * a record; everything it planned but never did is dropped, because no run is
 * working on it any more and a stranded plan reads as unfinished business the
 * user is supposed to pick up. Returns how many tasks were dropped. */
export function discardUnfinishedTasks(state, chatId = null) {
  const mine = tasksForChat(state, chatId);
  const drop = mine.filter(t => t.status !== 'done');
  if (!drop.length) return 0;
  const doomed = new Set(drop);
  state.tasks = taskList(state).filter(t => !doomed.has(t));
  return drop.length;
}

export function clearDoneTasks(state) {
  const before = taskList(state);
  const removed = before.filter(t => t.status === 'done').length;
  state.tasks = before.filter(t => t.status !== 'done');
  return removed;
}

/* One line per task — used by the tool result and the list page. */
export function taskLine(t) {
  const prio = t.priority && t.priority !== 'normal' ? ` (${t.priority})` : '';
  const plan = t.plan ? ` — ${t.plan}` : '';
  return `${MARK[t.status] || '[ ]'} #${t.id}${prio} ${t.title}${plan}`;
}

/* ---------------- the agent-facing tool ---------------- */

export function runTodo(state, args = {}, ctx = {}) {
  // The agent's call already succeeded once the data changed; a broken
  // repaint is logged, never reported back as a tool failure.
  const done = (out) => {
    try { ctx.onTaskChange && ctx.onTaskChange(); }
    catch (e) { console.warn('Task list repaint failed:', e); }
    return out;
  };
  const action = String(args.action || 'list').toLowerCase();

  if (action === 'add') {
    const t = addTask(state, { chatId: ctx.chatId || null, title: args.title, plan: args.plan, priority: args.priority });
    return done(`Created task ${t.id}: ${taskLine(t)}`);
  }
  if (action === 'update') {
    const t = updateTask(state, args.id, args);
    return done(`Updated task ${t.id}: ${taskLine(t)}`);
  }
  if (action === 'status') {
    const t = setTaskStatus(state, args.id, String(args.status || '').toLowerCase());
    return done(`Task ${t.id} is now ${t.status}: ${taskLine(t)}`);
  }
  if (action === 'remove') {
    const t = removeTask(state, args.id);
    return done(`Removed task ${t.id}: ${t.title}`);
  }
  if (action === 'clear') {
    const n = clearDoneTasks(state);
    return done(n ? `Removed ${n} finished task(s).` : 'No finished tasks to remove.');
  }
  if (action === 'list') {
    const tasks = sortedTasks(tasksForChat(state, ctx.chatId || null));
    if (!tasks.length) return 'The task list is empty. Create tasks with action=add when you plan a multi-step job.';
    const c = taskCounts(tasks);
    return `Tasks (${c.open} open, ${c.done} done):\n` + tasks.map(taskLine).join('\n');
  }
  throw new Error('Unknown action — use add, update, status, remove, clear or list');
}

/* ---------------- the live in-chat view ----------------
 * One node per chat, kept across renders, so a repaint never interrupts the
 * reader and the fold survives the agent streaming next to it. */

const views = new Map();       // chatId -> the mounted node
const openState = new Map();   // chatId -> the reader's explicit fold choice
const mounted = new Set();     // nodes that need a repaint when tasks change

function keyOf(chatId) { return chatId || 'shared'; }

function prune(keep = null) {
  for (const node of [...mounted]) if (!node.isConnected) mounted.delete(node);
  for (const [k, node] of [...views]) if (!node.isConnected && k !== keep) views.delete(k);
}

export function todoView(state, chat, api) {
  const key = keyOf(chat?.id);
  prune(key);
  let node = views.get(key);
  if (!node) { node = el('<div class="todo-live"></div>'); views.set(key, node); }
  node.__todoCtx = { state, chatId: chat?.id || null, api };
  mounted.add(node);
  paintTodo(node);
  return node;
}

/* Repaint every mounted list. Safe to call at any time; never throws. */
export function refreshTodoLists() {
  prune();
  for (const node of [...mounted]) {
    try { paintTodo(node); }
    catch (e) { console.warn('Task list paint failed:', e); }
  }
}

function paintTodo(node) {
  const ctx = node.__todoCtx;
  if (!ctx) return;
  const key = keyOf(ctx.chatId);
  // Plan order — the order the agent wrote the steps in. A step that is done
  // belongs where it was planned, not at the bottom of the list.
  const tasks = tasksForChat(ctx.state, ctx.chatId);
  const c = taskCounts(tasks);
  const allDone = c.total > 0 && c.done === c.total;
  // Open while there is work to watch; folded once everything is done, or
  // whenever the reader folded it themselves.
  const open = openState.has(key) ? openState.get(key) : !allDone;
  const sig = JSON.stringify([open, tasks.map(t => [t.id, t.status, t.title, t.plan, t.priority])]);
  // An empty list is not shown at all: a chat must not carry "no tasks yet"
  // furniture. The node stays mounted (hidden) so the list can appear by
  // itself the moment the agent plans its first step.
  node.hidden = !tasks.length;
  if (!tasks.length) { node.__todoSig = sig; node.innerHTML = ''; return; }
  if (node.__todoSig === sig) return; // unchanged: leave the DOM (and the reader) alone
  node.__todoSig = sig;

  const pct = Math.round((c.done / c.total) * 100);
  node.innerHTML = `
    <div class="todo-head">
      <span class="todo-label">Plan</span>
      <span class="todo-bar"><i style="width:${pct}%"></i></span>
      <span class="todo-count">${c.done}/${c.total}</span>
      <button class="todo-fold" title="${open ? 'Collapse' : 'Expand'} the plan" aria-expanded="${open}">${open ? '▾' : '▸'}</button>
    </div>
    <div class="todo-rows"></div>`;
  const rows = node.querySelector('.todo-rows');
  rows.hidden = !open;
  for (const t of tasks) rows.appendChild(taskRow(t));
  node.querySelector('.todo-fold').onclick = () => { openState.set(key, !open); paintTodo(node); };
}

/* A read-only row. No button, no checkbox, no click handler, no pointer
 * cursor — the agent owns this list. Extras stay in the tooltip. */
function taskRow(t) {
  const row = el(`<div class="todo-row ${esc(String(t.status).replace(/[^a-z]/gi, ''))}"></div>`);
  if (t.status === 'done') row.appendChild(el('<span class="todo-tick">✓</span>'));
  else row.appendChild(el('<span class="todo-dot"></span>'));
  const name = el('<span class="todo-name"></span>');
  name.textContent = t.title;
  row.appendChild(name);
  const bits = [];
  if (t.plan) bits.push(t.plan);
  if (t.priority && t.priority !== 'normal') bits.push(t.priority + ' priority');
  if (bits.length) row.title = bits.join(' · ');
  return row;
}
