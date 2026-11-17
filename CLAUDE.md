# Taxonomy & Ontology Manager — working notes

A **single self-contained HTML file** taxonomy and ontology management
frontend whose only backend is a Stardog server.

## Run and test

- The app is `taxonomy_manager.html`, opened directly from `file://`. Mock
  mode needs no server.
- Test harness: Playwright in `tests/` (`cd tests && npm test`).

## Architecture invariants

1. **One file.** No build step, no bundler, no external CDN fetches at
   runtime. It must work when opened from `file://`.
2. **No server, no API of our own.** Stardog is the entire backend. If a
   feature seems to need a server, it is either out of scope or has to be
   re-thought as something Stardog does.
3. **The user's own Stardog credentials.** Every read and write executes as
   that user, under Stardog's RBAC. The app is a *client, not a gateway* — it
   cannot enforce anything, only reflect what Stardog allows.
4. **No blank nodes, ever.** Anything that would conventionally be a blank
   node (`owl:Restriction`, SKOS-XL labels, reified anything) gets a minted
   IRI derived from the non-blank resources it relates to.
5. **Data change + audit event go in the same Stardog transaction.** Never
   one without the other.
6. **Every write is a guarded conditional update** (`WHERE` asserts the
   pre-state).
7. **Nothing the app needs to remember lives in the browser.** Config,
   sessions, scratch registry, audit — all of it is triples in Stardog.
   `localStorage` is for UI preferences only (panel sizes, theme), never for
   data.

## The interface is generic

This is a general taxonomy manager. It is not built for, or about, any
particular organization. Every user-facing string should make sense to a
team that has never heard of this project — no development history, no
internal design-doc references, no vendor positioning.

## Mock mode

The app ships with an entirely synthetic embedded demo taxonomy so it runs
with no server. Mock mode must exercise the *same* code paths as live mode:
the same SPARQL strings are generated and logged to the console, they are
just applied to an in-memory store instead of being sent. If a feature only
works in one mode, that is a bug.

## Never silently filter what a "raw data" view shows

A view that bills itself as the underlying data verbatim — the Triples tab,
a raw-RDF code view, an export — shows literally everything at that level,
unconditionally. Adding an exclusion list to a "show everything" view is a
bug, not a design choice.

## Transparency console

Every user action emits to the bottom console under the right filter:
`action` (what happened), `rdf` (the literal SPARQL sent), `audit` (the
audit triples written), `internal` (timings, tx ids, conflicts). This is a
product feature, not debug output.
