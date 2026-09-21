'use strict';

// Looks a board slice up by its title — the way the kit's commit convention
// names it (`feat: <Slice Name>`). Shared by the slice-aware checks; not a
// check itself (no `run(ctx)` here).
//
// `.build-kit/.slices/<contextSlug>/index.json` is what `load-slice`/`fetch`
// write: `{ slices: [{ id, slice, folder, status, contextSlug?, definition? }] }`
// with the full export next to it at `<contextSlug>/<folder>/slice.json`.

const fs = require('fs');
const path = require('path');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The board may prefix a title with "slice:", and the ralph prompt writes the
// commit as `feat: [Slice Name]` — neither is part of the name.
function normalizeTitle(title) {
  return String(title || '')
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/^slice:\s*/i, '')
    .trim()
    .toLowerCase();
}

// `feat: Place Reservation` → "Place Reservation"; anything else → null.
// Conventional-commit scopes and the breaking-change bang are tolerated
// (`feat(wallet)!: …`), but the type has to be `feat` — that is the kit's
// convention for "this commit is one board slice".
function sliceTitleFromMessage(message) {
  const firstLine = String(message || '')
    .split('\n')
    .find((line) => line.trim() && !line.startsWith('#'));
  if (!firstLine) return null;
  const m = /^feat(?:\([^)]*\))?!?:\s*(.+?)\s*$/i.exec(firstLine.trim());
  if (!m) return null;
  const title = m[1].replace(/^\[(.*)\]$/, '$1').trim();
  return title || null;
}

// Every index entry across every context, each tagged with the context
// directory it came from.
function allEntries(repoRoot) {
  const root = path.join(repoRoot, '.build-kit', '.slices');
  let contextDirs;
  try {
    contextDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const dir of contextDirs) {
    if (!dir.isDirectory()) continue;
    const index = readJson(path.join(root, dir.name, 'index.json'));
    if (!index || !Array.isArray(index.slices)) continue;
    for (const entry of index.slices) {
      if (!entry || typeof entry !== 'object') continue;
      out.push({ entry, contextDir: dir.name, contextPath: path.join(root, dir.name) });
    }
  }
  return out;
}

function loadSlice({ entry, contextDir, contextPath }) {
  const file = entry.folder ? path.join(contextPath, String(entry.folder), 'slice.json') : null;
  const json = (file && readJson(file)) || (entry.definition && typeof entry.definition === 'object' ? entry.definition : null);
  if (!json) return null;
  return { title: entry.slice || json.title || '', json, entry, contextSlug: contextDir, file };
}

// Returns { title, json, entry, contextSlug, file } or null — never throws.
// Matching is case-insensitive on the index entry's `slice` title. Two
// entries with the same title (the board does not enforce uniqueness) are
// disambiguated by status: the one being built is `InProgress`. Still
// ambiguous → null, and the caller treats that as "can't verify — don't block".
function findSliceByTitle(repoRoot, title) {
  const want = normalizeTitle(title);
  if (!want) return null;

  let matches = allEntries(repoRoot).filter(
    ({ entry }) => normalizeTitle(entry.slice || (entry.definition && entry.definition.title)) === want,
  );
  if (matches.length > 1) {
    const inProgress = matches.filter(({ entry }) => String(entry.status || '').toLowerCase() === 'inprogress');
    if (inProgress.length === 1) matches = inProgress;
  }
  if (matches.length !== 1) return null;
  return loadSlice(matches[0]);
}

// The one slice currently marked InProgress, when there is exactly one — the
// ralph loop sets that status before it starts building, so a manual run of
// the guard (no commit message yet) can still check the slice being built.
function findInProgressSlice(repoRoot) {
  const matches = allEntries(repoRoot).filter(({ entry }) => String(entry.status || '').toLowerCase() === 'inprogress');
  if (matches.length !== 1) return null;
  return loadSlice(matches[0]);
}

module.exports = { findSliceByTitle, findInProgressSlice, sliceTitleFromMessage, normalizeTitle };
