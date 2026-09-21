'use strict';

// Reads a slice.json the way the slice-aware checks need it: which events the
// slice *owns* (constructs in its own Events module) versus merely consumes,
// which files make up the touched context, and the Ruby-side spellings the
// board names map to. Not a check itself.

const { normalize, pascalCase, snakeCase } = require('./naming.cjs');

// Events a state-view or automation slice lists under events[] are its
// inputs, produced elsewhere — only a command in this slice produces an event
// this slice must construct. The export says which through dependencies[]:
// the event carries an INBOUND edge from a COMMAND, or a command carries an
// OUTBOUND edge to the event. With no dependency data at all, fall back to
// the slice shape: commands and nothing to read/react to means every
// internal event is the command's. Anything unclear → not owned → not checked
// (prefer not blocking over a false positive).
function ownedEvents(slice) {
  const events = Array.isArray(slice.events) ? slice.events : [];
  const commands = Array.isArray(slice.commands) ? slice.commands : [];
  const internal = events.filter((e) => e && e.context !== 'EXTERNAL');
  if (commands.length === 0) return [];

  const sameContext = (e) => !e.modelContext || !slice.context || normalize(e.modelContext) === normalize(slice.context);

  const hasDependencyData =
    internal.some((e) => Array.isArray(e.dependencies) && e.dependencies.length > 0) ||
    commands.some((c) => Array.isArray(c.dependencies) && c.dependencies.length > 0);

  if (!hasDependencyData) {
    const readmodels = Array.isArray(slice.readmodels) ? slice.readmodels : [];
    const processors = Array.isArray(slice.processors) ? slice.processors : [];
    return readmodels.length === 0 && processors.length === 0 ? internal.filter(sameContext) : [];
  }

  const commandIds = new Set(commands.map((c) => c.id).filter(Boolean));
  const commandOutputs = new Set();
  for (const c of commands) {
    for (const d of c.dependencies || []) {
      if (d && d.type === 'OUTBOUND' && d.elementType === 'EVENT') commandOutputs.add(d.id);
    }
  }
  return internal.filter(
    (e) =>
      sameContext(e) &&
      (commandOutputs.has(e.id) ||
        (e.dependencies || []).some((d) => d && d.type === 'INBOUND' && d.elementType === 'COMMAND' && (commandIds.size === 0 || commandIds.has(d.id)))),
  );
}

// The `type: "…"` string the board title becomes (CLAUDE.md: "the board's
// event titles verbatim, PascalCase past tense, no spaces").
function eventType(event) {
  return pascalCase(event.title);
}

// events.rb split into its `def` chunks, so a tag or type check can look at
// one constructor at a time. Returns [{ text }] — the chunk containing the
// event's `type:` string is that event's constructor.
function constructorChunks(eventsRb) {
  return String(eventsRb || '')
    .split(/\n(?=\s*def\s)/)
    .map((text) => ({ text }));
}

function constructorFor(eventsRb, type) {
  const marker = new RegExp(`\\btype:\\s*(["'])${escapeRegExp(type)}\\1`);
  return constructorChunks(eventsRb).find((c) => marker.test(c.text)) || null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// All fields of every element in the slice (commands, events, read models,
// screens, processors) — flat, with the element they belong to.
function allFields(slice) {
  const out = [];
  for (const key of ['commands', 'events', 'readmodels', 'screens', 'processors']) {
    for (const element of Array.isArray(slice[key]) ? slice[key] : []) {
      for (const f of Array.isArray(element && element.fields) ? element.fields : []) {
        if (f && f.name) out.push({ field: f, element, kind: key });
      }
    }
  }
  return out;
}

// Ruby files of the touched context that will exist after the commit, with
// their contents, under one of the slice directories.
function contextFiles(ctx, context, root = 'app') {
  const prefix = `${root}/slices/${context}/`;
  return ctx
    .files(prefix)
    .filter((p) => p.endsWith('.rb'))
    .map((p) => ({ path: p, content: ctx.read(p) }))
    .filter((f) => typeof f.content === 'string');
}

// The one context directory this commit touches, or null when the commit is
// not a single-context one (15-one-context reports that; nothing else should).
function singleContext(ctx) {
  return ctx.contexts.size === 1 ? [...ctx.contexts][0] : null;
}

// How a title appears inside a Ruby string literal of either quote style.
function rubyStringForms(text) {
  const s = String(text);
  return [`"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`];
}

module.exports = {
  ownedEvents,
  eventType,
  constructorChunks,
  constructorFor,
  allFields,
  contextFiles,
  singleContext,
  rubyStringForms,
  escapeRegExp,
  snakeCase,
};
