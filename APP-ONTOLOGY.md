# Taxonomy Manager App Ontology

This document, and its companion `APP-ONTOLOGY.ttl`, describe the app's
**own** implicit ontology — every named graph, class, and property Taxonomy
Manager itself reads or writes in order to operate.

## What this is not

This is **not** the customer's ontology. Nothing here is written into an
imported vocabulary's own SKOS/OWL content, and nothing here is required to
exist for an import to work. If you're looking for how this app models
*subject-matter* things — classes on a concept, custom relation types the
data itself declares, restrictions — see `ARCHITECTURE.md` §11 (OWL scope)
and `PLAN-BEYOND-THE-SKELETON.md`.

This is also not modelling guidance for building a taxonomy. It is a
reference for one question only: **when this app writes something that
isn't your data, what does it write, and where?**

## The two namespaces, and why they look similar

| Prefix | Namespace | What it is |
|---|---|---|
| `tax:` | `https://stardog.com/taxonomy/vocab#` | This app's own bookkeeping vocabulary — stable across every install, defined in full in `APP-ONTOLOGY.ttl`. |
| `ex:` | `https://taxonomy.example.org/id/` | The **placeholder base** an install mints its own new IRIs from — new schemes, new concepts, audit events, comments, reviews, tags — until a taxonomy admin sets a real one (Menu ▸ Configure ▸ Identifier patterns…, or the Edit… button on a concept's Metadata tab). It carries no vocabulary of its own: it is a default waiting to be replaced, not a namespace to extend. |

**If you saw `ex:` in your own data** — an "In scheme" value like
`ex:idb-vocabulary-test/scheme`, say — that is a scheme or concept *this
app itself minted* (because no other base was configured at the time),
never something rewritten from your imported file. Import always preserves
a source file's own IRIs exactly as given (`openImportProfile()` in
`taxonomy_manager.html`); this app never substitutes its own namespace for
a concept's or scheme's real identity. Set a real base under Identifier
patterns and everything minted from then on uses it instead — nothing
already-minted is retroactively renamed.

## Named graphs

Every graph below is inside the one Stardog database a vocabulary lives in
(`ARCHITECTURE.md` §3 has the full narrative; this is the flat reference
form).

| Graph pattern | Holds | Who normally writes it |
|---|---|---|
| `urn:taxonomy:scheme:{id}:draft` | Editorial working copy of one vocabulary | Editors |
| `urn:taxonomy:scheme:{id}:approved` | Reviewed, not yet released | The approval step |
| `urn:taxonomy:scheme:{id}:published` | Current public state (a physical copy, not an alias) | The publish step |
| `urn:taxonomy:scheme:{id}:release:{version}` | One immutable snapshot per release | The publish step, once |
| `urn:taxonomy:scheme:{id}:shapes` | SHACL shapes governing this scheme | Taxonomy admins |
| `urn:taxonomy:scheme:{id}:incoming` | A loaded file, waiting to be incorporated or discarded | The import step |
| `urn:taxonomy:scheme:{id}:provenance` | Subjects a vocabulary's export carried that aren't part of the vocabulary itself (a change-log population, agent records) | The import step |
| `urn:taxonomy:app:config` | Admin decisions: URI templates, active/required languages, app identity | Taxonomy admins |
| `urn:taxonomy:app:audit` | Every audit event, across every vocabulary — one graph, not partitioned, so a single permission grant covers it (see the comment at `G.audit` in the code for why monthly partitioning was tried and reverted) | Every editing action, in the same transaction as the change |
| `urn:taxonomy:app:reviews` | Pending review requests, across every vocabulary a reviewer looks after | The review-request flow |
| `urn:taxonomy:app:comments` | Discussion threads and their replies — deliberately **not** in the vocabulary graph, so a thread about whether a term is right is never exported with the vocabulary or promoted by an approval | The discussion feature |
| `urn:taxonomy:app:sessions` | Live editing sessions and the per-graph `tax:revision` counters | Every committed mutation |
| `urn:taxonomy:app:loads` | The register of every file ever loaded straight into the database, and what became of it | The import step |
| `urn:taxonomy:tags:{corpus}` | Tags applying concepts to one registered external content database | The tagging feature |

## The `tax:` vocabulary

The full, canonical list — with `rdfs:label`/`rdfs:comment`/domain/range —
is `APP-ONTOLOGY.ttl`, generated from the same census as this table so the
two never drift apart. In summary, by class:

| Class | Purpose |
|---|---|
| `tax:TaxonomyAppConfig` | The single config resource in `urn:taxonomy:app:config` |
| `tax:AuditEvent` | One change-log entry |
| `tax:RelationType` | A custom registered semantic relation |
| `tax:Mapping` | A cross-scheme correspondence going through review |
| `tax:TagCorpus` | A registered external content database |
| `tax:Tag` | One concept-to-content application |
| `tax:DataLoad` | One register entry for a loaded file |
| `tax:Release` | One immutable published snapshot |
| `tax:ReviewRequest` | One pending review |
| `tax:Discussion` / `tax:Comment` | One editorial discussion thread, and its replies |
| `tax:RetiredIdentifier` | Marks a merged concept's URI as kept-resolving |
| `tax:AppGraph` | Self-description marker for an app-owned graph |

`tax:targetDatabase` (added 2026-09-09) is a plain string literal — the
database name a write actually targeted, defaulting to the currently open
one (`State.db`) unless a creation modal's destination picker sent it
somewhere else. Every audit event carries it now, not only a cross-database
one, so the log never has to assume "this database" for an event it holds.

Several properties (`tax:status`, `tax:targetGraph`, `tax:decidedBy`,
`tax:decidedAt`, `tax:scheme`, `tax:concept`, `tax:target`, ...) are
deliberately reused across more than one class rather than given a
class-specific name each time — the ttl omits `rdfs:domain` on those rather
than forcing a false single answer.

Three properties (`tax:action`, `tax:outcome`, `tax:status`) take values
from an **open, dynamically-named enumeration** rather than a fixed closed
list — each is a real individual IRI under `tax:` (`tax:AddProperty`,
`tax:Committed`, `tax:NeedsReview`, ...), minted from whatever string the
calling code names, not declared as an exhaustive `owl:oneOf`. Grep
`taxonomy_manager.html` for `P("tax:action")`/`P("tax:status")` call sites
if you need the current full set at a point in time.

## Worked example: one audit event

Every guarded write commits its data change and its audit event in the same
transaction (invariant 5). This is the literal shape `auditEvent()` in
`taxonomy_manager.html` produces for, say, adding a property to a concept:

```trig
GRAPH <urn:taxonomy:app:audit> {
  <https://taxonomy.example.org/id/plant-conservation/audit/01J8ZQ2R4M...>
    a tax:AuditEvent, prov:Activity ;
    prov:wasAssociatedWith <https://taxonomy.example.org/id/user/alex> ;
    prov:startedAtTime "2026-09-04T14:02:11.000Z"^^xsd:dateTime ;
    tax:action tax:AddProperty ;
    tax:targetDatabase "plant-conservation-db" ;
    tax:targetGraph <urn:taxonomy:scheme:plant-conservation:draft> ;
    tax:subject <https://taxonomy.example.org/id/plant-conservation/concept/tropical-rainforest> ;
    tax:property dct:source ;
    tax:newValue "FAO AGROVOC" ;
    tax:outcome tax:Committed ;
    tax:graphRevision 4822 .
}
```

## Worked example: the URI-minting config

Saving Identifier patterns (Menu ▸ Configure ▸ Identifier patterns…, or the
Edit… button on a concept's Metadata tab) writes this shape into
`urn:taxonomy:app:config`:

```trig
GRAPH <urn:taxonomy:app:config> {
  <urn:taxonomy:app:config>
    tax:uriBase "https://taxonomy.example.org/id/" ;
    tax:uriDomain "plant-conservation" ;
    tax:uriLocalIdStrategy "ulid" ;
    tax:uriTemplate "{base}{domain}/{class}/{localId}" ;
    tax:uriTemplateFor <https://stardog.com/taxonomy/vocab#uriTemplateFor/concept> ;
    tax:uriVersionToken "" .

  <https://stardog.com/taxonomy/vocab#uriTemplateFor/concept>
    tax:forClass "concept" ;
    tax:pattern "{base}{domain}/concept/{localId}" .
}
```

A per-class override (when one is set) points at a fixed, deterministic
resource — `tax:uriTemplateFor/{class}` — rather than a blank node, so
re-saving the same class's override converges on the same resource instead
of leaving the previous one behind. (Fixed 2026-09-04: this used to be
written as an anonymous `[ tax:forClass "concept" ; tax:pattern "..." ]`
node — a genuine blank node, conflicting with this project's own
no-blank-node rule, `ARCHITECTURE.md` §11.1 — and the save also never
cleaned up an old override, so both are corrected in the same fix.)

The save is now a real guarded write through the same `mutation()`/
`commit()` pipeline every other edit in this app uses (fixed 2026-09-04,
same pass as the above): it used to build this exact shape only to show it
in the transparency console, while the actual change was a direct
`State.config`/`State.store` mutation with no `Backend.apply()` call at
all — invisible in mock/offline mode, since there's no server to notice the
gap, but meaning a live-mode save of Identifier patterns (and, in the same
bug, adding an active language, retargeting or flagging tags on merge/
split/deprecate/URI-change) never reached Stardog: it looked applied for
the rest of the session and was silently gone on the next reconnect.

A code-review pass on that fix found the other half of the same problem:
even with the save now real, nothing ever read the saved values back on
the *next* connect — `State.config.uriTemplate` was hydrated once from a
hardcoded default and never refreshed from `G.config` the way the active
language set already was. `bootWorkspace()` now reads it back the same
way, so a template saved in one session is still the template in effect
the next time anyone — including a different user — opens this database.

## Answering the two questions that prompted this document

**"What is `ex:` and why did I see it in my data?"** — see "The two
namespaces" above: it is this app's own default placeholder base for
whatever it mints itself, replaceable under Identifier patterns, never
substituted into anything you imported.

**"Is the URI pattern real, or just documentation?"** — real: every
`mintIri()` call in the app (creating a concept, a scheme, an audit event,
a comment, a tag) resolves and expands the pattern from
`urn:taxonomy:app:config` at the moment of minting. The Identifier
patterns dialog's live preview shows the exact IRI a pattern would produce
right now — it is not illustrative text.
