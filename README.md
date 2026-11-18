# Taxonomy & Ontology Manager

A single self-contained HTML file for managing SKOS taxonomies (and a minimal
slice of OWL) with **Stardog as the entire backend**. No server, no build step,
no API of its own — you open the file, authenticate with your own Stardog
credentials, and every read and write executes as you, under Stardog's RBAC.

## Run it

Open `taxonomy_manager.html` in a browser. Click **Open demo with mock data** to
explore without a server or [click here](https://brendan-newlon.github.io/taxonomy-ontology-manager/) to access the live app online. 
The demo carries an entirely synthetic subject
facet — a few hundred generated terms across 30 invented sectors, a set of
publication series and document categories — modelled as four separate
concept schemes, plus a small curated Spanish/Portuguese/Guaraní thesaurus
alongside it. None of the sample data is drawn from any real organization's
vocabulary.

Live mode works: connect with your own Stardog credentials, pick a database,
and the app hydrates the graphs it needs. **Menu → Seed a Stardog database
with this data…** creates a database with the right options and writes the
demo taxonomy into it, so you can watch real triples land over a real
connection.

## What it demonstrates

| | |
|---|---|
| **Tree** | polyhierarchy, cycle detection, deprecation, per-concept issue flags, language fallback |
| **Detail tabs** | Labels (SKOS-XL + materialised plain SKOS), Notes, Relations, Mappings, Metadata, History |
| **Guarded writes** | every mutation's `WHERE` asserts its pre-state — press *Simulate concurrent edit*, then edit the label, and watch the update refuse to clobber a colleague's work |
| **Audit** | every change writes a PROV-O event into the audit graph **in the same transaction**; the History tab reads it back |
| **Validation** | three tiers — save-blocking, publish-gating, advisory — with Publish disabled until the scheme is clean |
| **Languages** | BCP 47, added at runtime and stored in the config graph, not in code |
| **Console** | four filters: what the app did · the literal RDF sent · what was recorded · internals |
| **Transparency** | every SPARQL statement the app sends is logged, in mock mode and live mode alike |

## Architecture invariants

- **One file.** No build step, no bundler, no external CDN fetches at runtime.
  Works when opened from `file://`.
- **No server, no API of its own.** Stardog is the entire backend.
- **Your own Stardog credentials.** Every read and write executes as you,
  under Stardog's RBAC — the app is a client, never a gateway.
- **No blank nodes, ever.** Anything that would conventionally be a blank
  node gets a minted IRI derived from the non-blank resources it relates to.
- **Data change and audit event, same transaction.** Never one without the
  other.
- **Every write is a guarded conditional update** — its `WHERE` asserts the
  pre-state, so a stale edit refuses to clobber someone else's work.

## Documentation

- [`APP-ONTOLOGY.md`](APP-ONTOLOGY.md) / [`APP-ONTOLOGY.ttl`](APP-ONTOLOGY.ttl) —
  the app's own bookkeeping ontology (config, audit, tags, loads) — never a
  customer's subject-matter ontology
- [`tests/`](tests/) — a Playwright suite (600+ tests) driving the app through
  a real browser

## Testing

```
cd tests
npm install
npx playwright install chromium
npm test
```

## Status

Prototype. Not wired to a live Stardog server for every feature yet, and OWL
editing is designed but not fully built.

## License

Apache 2.0 — see [LICENSE](LICENSE).
