/**
 * Page helpers for driving taxonomy_manager.html.
 *
 * The rule the whole harness follows (developer-docs/TESTING.md §1): read the
 * TREE from the DOM, read TRIPLES from the store, and never let one stand in
 * for the other. `tree*` helpers below only ever look at rendered rows.
 */
const path = require("path");
const { pathToFileURL } = require("url");

/* Defaults to the taxonomy_manager.html beside `tests/` — so running from a
   worktree tests that worktree's copy. TAXONOMY_HTML points it somewhere else,
   which is how a new test is checked against the version it was written for
   before the fix landed. */
const APP_FILE = process.env.TAXONOMY_HTML
  ? path.resolve(process.env.TAXONOMY_HTML)
  : path.resolve(__dirname, "..", "..", "taxonomy_manager.html");
const APP_URL = pathToFileURL(APP_FILE).href;

const EX = "https://taxonomy.example.org/id/";
/** The IRI the app mints for a concept slug in a scheme — same shape as `cid()` in buildMock. */
const cid = (scheme, slug) => `${EX}${scheme}/concept/${slug}`;
/** Shorthand for the small curated demo scheme most tests use. */
const sdg = (slug) => cid("plant-conservation", slug);

/* ------------------------------------------------------------------ boot */

/**
 * Open the app and click "Sample data" — the same gesture a user makes.
 * `alert`/`confirm` are stubbed before any app code runs so a refusal the app
 * raises becomes an assertable record instead of a hung native dialog.
 */
async function boot(page, opts = {}) {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));
  page.__errors = pageErrors;

  await page.addInitScript(() => {
    window.__alerts = [];
    window.__confirms = [];
    window.alert = (m) => { window.__alerts.push(String(m)); };
    window.confirm = (m) => { window.__confirms.push(String(m)); return true; };
    // file:// has no clipboard permission; the app guards on truthiness only.
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: (t) => { window.__clipboard = t; return Promise.resolve(); } }
      });
    } catch (_) { /* some builds already define it read-only */ }
  });

  await page.goto(APP_URL);
  await page.click("#cMock");
  await page.waitForSelector("#app.ready");
  await page.waitForSelector("#tree .trow");

  if (opts.scheme) await switchScheme(page, opts.scheme);
  return page;
}

/** Switch concept schemes through the app's own function (the selector menu is chrome, not behaviour). */
async function switchScheme(page, id) {
  await page.evaluate((s) => switchScheme(s), id);
  await page.waitForSelector("#tree .trow");
}

/* ------------------------------------------------------- tree (DOM only) */

/**
 * Every row the tree is currently rendering, in document order.
 * `depth` is decoded from the indent the renderer writes (6 + depth*15 px).
 */
function treeRows(page) {
  return page.$$eval("#tree .trow", (rows) => rows.map((r) => {
    const pad = parseFloat(r.style.paddingLeft || "0");
    const twist = r.querySelector(".twist");
    return {
      iri: r.dataset.c || null,
      collection: r.dataset.col || null,
      unfiled: r.dataset.uf === "1",
      label: (r.querySelector(".tlabel")?.textContent || "").trim(),
      depth: Math.round((pad - 6) / 15),
      selected: r.classList.contains("sel"),
      leaf: !!twist && twist.classList.contains("leaf"),
      open: !!twist && twist.classList.contains("open"),
      flags: [...r.querySelectorAll(".tflag")].map((f) => f.className.replace("tflag", "").trim()),
      /* What the mark actually says. `flags` is the CSS class, which is the
         app's own name for the mark; this is the reader's. */
      flagText: [...r.querySelectorAll(".tflag")].map((f) => f.textContent.trim())
    };
  }));
}

/**
 * The name of one capability's role, asked of the app rather than assumed.
 *
 * The prefix is not a constant: it is `taxonomy_` by default and
 * `taxonomy_mgr_app_` where a server already had a role by the plain name,
 * and older databases still carry `tax_`. A test that spells one out is
 * testing the harness's memory of last week.
 */
function roleName(page, level, scheme) {
  return page.evaluate(([lv, sc]) => levelRoleName(lv, sc), [level, scheme || null]);
}

/** Is this concept actually on screen in the tree right now? */
async function treeHas(page, iri) {
  return (await page.$(`#tree .trow[data-c="${cssEscape(iri)}"]`)) !== null;
}

async function treeRow(page, iri) {
  const rows = await treeRows(page);
  return rows.find((r) => r.iri === iri) || null;
}

/** The rows rendered directly beneath `iri` at one greater depth — i.e. what the user sees as its children. */
async function treeChildren(page, iri) {
  const rows = await treeRows(page);
  const i = rows.findIndex((r) => r.iri === iri);
  if (i < 0) return [];
  const d = rows[i].depth;
  const out = [];
  for (let j = i + 1; j < rows.length && rows[j].depth > d; j++) {
    if (rows[j].depth === d + 1) out.push(rows[j]);
  }
  return out;
}

/** Top-level rows the tree is rendering. */
async function treeRoots(page) {
  return (await treeRows(page)).filter((r) => r.depth === 0 && r.iri);
}

/** Click the twist to open/close a branch, as a user would. */
async function toggle(page, iri) {
  await page.click(`#tree .twist[data-tw="${cssEscape(iri)}"]`);
  await page.waitForTimeout(20);
}

async function isExpanded(page, iri) {
  return page.evaluate((c) => State.expanded.has(c), iri);
}

/** Select a concept by clicking its row. */
async function clickRow(page, iri) {
  await page.click(`#tree .trow[data-c="${cssEscape(iri)}"]`);
  await page.waitForTimeout(20);
}

/* ------------------------------------------------------------ store reads */

const appEval = (page, fn, arg) => page.evaluate(fn, arg);

const broaderOf = (page, c) => page.evaluate((x) => broaderOf(x), c);
const narrowerOf = (page, c) => page.evaluate((x) => narrowerOf(x), c);
const relatedOf = (page, c) => page.evaluate((x) => relatedOf(x), c);
const topConcepts = (page) => page.evaluate(() => topConcepts());
const allConcepts = (page) => page.evaluate(() => allConcepts());
const selected = (page) => page.evaluate(() => State.selected);

/** Every triple asserted by a subject in the open graph, as `[p, o]` strings. */
const triplesOf = (page, s) => page.evaluate(
  (x) => State.store.match(currentGraph(), iri(x), null, null)
    .map((q) => [q.p.v, q.o.v + (q.o.lang ? "@" + q.o.lang : "")]), s);

/** Does the open graph hold exactly this triple? */
const hasTriple = (page, s, pCurie, o) => page.evaluate(
  ([s2, p2, o2]) => State.store.match(currentGraph(), iri(s2), P(p2),
    o2 && o2.startsWith("http") || o2 && o2.startsWith("urn:") ? iri(o2) : null)
    .some((q) => q.o.v === o2), [s, pCurie, o]);

const quadCount = (page) => page.evaluate(() => State.store.countIn(currentGraph()));

/* ---------------------------------------------------------------- modals */

const modalOpen = (page) => page.evaluate(() => !!document.querySelector("#modalRoot .modal"));

async function modalTitle(page) {
  return page.$eval("#modalRoot .modal-head h2", (h) => h.textContent.trim()).catch(() => null);
}
async function modalText(page) {
  return page.$eval("#modalRoot .modal", (m) => m.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
}
async function waitModal(page, title) {
  await page.waitForSelector("#modalRoot .modal");
  if (title) await page.waitForFunction(
    (t) => document.querySelector("#modalRoot .modal-head h2")?.textContent.includes(t), title);
}
const okDisabled = (page) => page.$eval("#mOk", (b) => b.disabled).catch(() => null);

async function modalOk(page) {
  await page.click("#mOk");
  await page.waitForTimeout(60);
}
async function modalCancel(page) {
  await page.click("#mCancel");
  await page.waitForTimeout(20);
}

/**
 * Choose a row in one of the app's searchable pickers by typing and clicking,
 * which is what makes `pickerValue()` see a *chosen* item rather than free text.
 * `label` is matched case-insensitively against the row's visible text.
 */
async function pick(page, id, label) {
  await page.fill(`#${id}`, label);
  await page.waitForSelector(`#${id}_list .pick-opt`);
  const rows = await page.$$(`#${id}_list .pick-opt`);
  for (const r of rows) {
    const t = (await r.$eval(".t", (e) => e.textContent) || "").trim();
    if (t.toLowerCase() === label.toLowerCase()) { await r.click(); await page.waitForTimeout(20); return; }
  }
  await rows[0].click();
  await page.waitForTimeout(20);
}

/** Clear a picker the way a user does — select all, delete. */
async function pickClear(page, id) {
  await page.fill(`#${id}`, "");
  await page.waitForTimeout(20);
}

const pickerValue = (page, id) => page.evaluate((i) => pickerValue(i), id);

/* --------------------------------------------------- context menu / drag */

/** Right-click a tree row. Returns after the menu is in the DOM. */
async function rightClick(page, iri) {
  await page.evaluate((c) => {
    const row = document.querySelector(`.trow[data-c="${CSS.escape(c)}"]`);
    if (!row) throw new Error("no row for " + c);
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 5)
    }));
  }, iri);
  await page.waitForSelector(".menu.floating");
}

const menuKeys = (page) => page.$$eval(".menu.floating [data-k]", (els) => els.map((e) => e.dataset.k));
const menuLabels = (page) => page.$$eval(".menu.floating [data-k]", (els) => els.map((e) => e.textContent.trim()));

async function clickMenu(page, key) {
  await page.click(`.menu.floating [data-k="${key}"]`);
  await page.waitForTimeout(60);
}

const menuOpen = (page) => page.evaluate(() => !!document.querySelector(".menu.floating"));

/**
 * HTML5 drag and drop, dispatched as real DragEvents carrying a DataTransfer.
 * Synthetic mouse movement does not produce a native drag in Chromium, and the
 * app's handlers read `dataTransfer` and `ctrlKey`, both of which this carries.
 */
async function dragDrop(page, srcIri, dstIri, opts = {}) {
  await page.evaluate(([s, d, ctrl]) => {
    const q = (c) => document.querySelector(`.trow[data-c="${CSS.escape(c)}"]`);
    const src = q(s), dst = q(d);
    if (!src) throw new Error("drag source not rendered: " + s);
    if (!dst) throw new Error("drop target not rendered: " + d);
    const dt = new DataTransfer();
    const fire = (type, el) => el.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, dataTransfer: dt, ctrlKey: !!ctrl
    }));
    fire("dragstart", src);
    fire("dragover", dst);
    fire("drop", dst);
    fire("dragend", src);
  }, [srcIri, dstIri, !!opts.ctrl]);
  await page.waitForTimeout(40);
}

/* ------------------------------------------------------- console / alerts */

/** Transparency-console entries, optionally one channel: action | rdf | audit | internal. */
const logs = (page, channel) => page.evaluate(
  (k) => State.log.filter((e) => !k || e.channel === k)
    .map((e) => ({ channel: e.channel, msg: e.msg, code: e.code })), channel);

const alerts = (page) => page.evaluate(() => window.__alerts.slice());
const clearAlerts = (page) => page.evaluate(() => { window.__alerts.length = 0; });

/** Toast text currently on screen, joined — for the paths that report by toast. */
const toasts = (page) => page.$$eval(".toast, #toasts > *", (e) => e.map((x) => x.textContent).join(" | "))
  .catch(() => "");

const issues = (page) => page.evaluate(
  () => State.issues.map((i) => ({ concept: i.concept, text: i.text, tier: i.tier })));

/* ------------------------------------------------------------------ misc */

/** CSS.escape for use in Node-side selector strings. */
function cssEscape(v) {
  return String(v).replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\" + ch);
}

/** Create a concept through the New concept dialog, from wherever it was opened. */
async function fillNewConcept(page, { label, broader, lang }) {
  await waitModal(page, "New concept");
  await page.fill("#mText", label);
  if (lang) await pick(page, "mLang", lang);
  if (broader === null) await pickClear(page, "mBroader");
  else if (broader) await pick(page, "mBroader", broader);
  await modalOk(page);
}

/** The concept whose displayed preferred label is `text`, or null. */
const conceptByLabel = (page, text) => page.evaluate(
  (t) => allConcepts().find((c) => labelText(c).plain === t) || null, text);

/**
 * Open every ancestor of a concept so its row is rendered. Tests use this to
 * set up a starting position; it is never used to rescue an assertion about
 * whether the app itself put a row on screen.
 */
async function reveal(page, c) {
  await page.evaluate((x) => {
    const up = (y, seen) => broaderOf(y).forEach((b) => {
      if (seen.has(b)) return; seen.add(b); State.expanded.add(b); up(b, seen);
    });
    up(x, new Set());
    renderTree();
  }, c);
}

/** Click a tab in the detail pane. */
async function selectTab(page, key) {
  await page.click(`#tabs [data-tab="${key}"]`);
  await page.waitForTimeout(20);
}

/* Relation tables are keyed by predicate IRI, not by a short name, because a
   registered custom type has no short name. "broader" still works here. */
const SKOS_NS = "http://www.w3.org/2004/02/skos/core#";
const relIri = (kind) => (kind.includes(":") ? kind : SKOS_NS + kind);

/** Click the "+ add" button of one relation table in the Relations tab. */
async function addRelation(page, kind) {
  await page.click(`#tabbody [data-addrel="${cssEscape(relIri(kind))}"]`);
  await page.waitForSelector("#modalRoot .modal");
}

/** Click the ✕ next to one relation row. */
async function removeRelation(page, kind, target) {
  await page.click(
    `#tabbody [data-delrel="${cssEscape(relIri(kind))}"][data-t="${cssEscape(target)}"]`);
  await page.waitForTimeout(60);
}

/** Run a document through the whole import pipeline: stage → profile → preview → apply. */
async function importText(page, text, fmt, opts = {}) {
  await page.evaluate(() => openImportDialog());
  await waitModal(page, "Import");
  await page.fill("#iPaste", text);
  if (fmt) await page.selectOption("#iFormat", fmt);
  await modalOk(page);
  await waitModal(page, "Import profile");
  /* A predicate in a namespace the app does not know defaults to "drop" on the
     profile step. `keep` is how a test says the user chose otherwise — without
     it, an assertion about foreign predicates is really asserting the default. */
  for (const pred of opts.keep || []) {
    await page.selectOption(`[data-pd="${cssEscape(pred)}"]`, "keep");
  }
  /* Per-type decisions: keep / drop / aside. Same reason as `keep` above —
     without saying so a test asserts the default, not a choice. */
  for (const [cls, choice] of Object.entries(opts.classes || {})) {
    await page.selectOption(`[data-cd="${cssEscape(cls)}"]`, choice);
  }
  await modalOk(page);
  await waitModal(page, "Import preview");
  const summary = await modalText(page);
  await page.click("#mOk");
  await page.waitForFunction(() => !document.querySelector("#modalRoot .modal"), null, { timeout: 30_000 });
  await page.waitForTimeout(60);
  return summary;
}

/* ---- relation types ---- */

/** Register a relation type through the app's own write path, not by poking
    triples into the store: the point of the test is that the write works. */
async function registerRelType(page, spec) {
  await page.evaluate(async (x) => { await registerRelType(x); }, spec);
  await page.waitForTimeout(60);
}
async function unregisterRelType(page, typeIri) {
  await page.evaluate(async (x) => { await unregisterRelType(x); }, typeIri);
  await page.waitForTimeout(60);
}
const relTypes = (page) =>
  page.evaluate(() => relTypes().map((t) => Object.assign({}, t)));
const relationsOf = (page, c, kind) =>
  page.evaluate(([x, k]) => relationsOf(x, k), [c, kind]);
const relSections = (page) =>
  page.$$eval("#tabbody [data-addrel]", (els) => els.map((e) => e.dataset.addrel));
const discoveredRelPredicates = (page) =>
  page.evaluate(() => discoveredRelPredicates());


/* ------------------------------------------------- a vocabulary at scale */

const SKOS = "http://www.w3.org/2004/02/skos/core#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/**
 * N-Triples for a scheme of the shape windowed loading exists for.
 *
 * The demo data is small on purpose, and nothing in it can reach root paging,
 * a branch that is fetched when it is opened, or a stale child count — which
 * is exactly why both of windowed mode's visibility bugs went unnoticed. This
 * builds the missing shape: `roots` top concepts (zero-padded so the order the
 * server would return them in is predictable), the first `branches` of them
 * carrying `perBranch` children each, and one chain `depth` levels deep.
 */
function bigSchemeTriples(opts = {}) {
  const { roots = 600, branches = 40, perBranch = 12, depth = 4,
          ns = EX + "big/concept/", scheme } = opts;
  const out = [];
  const concept = (iri, label) => {
    out.push(`<${iri}> <${RDF_TYPE}> <${SKOS}Concept> .`);
    out.push(`<${iri}> <${SKOS}prefLabel> "${label}"@en .`);
  };
  const pad = (n) => String(n).padStart(4, "0");
  for (let i = 0; i < roots; i++) {
    const r = `${ns}root-${pad(i)}`;
    concept(r, `Root ${pad(i)}`);
    if (scheme) out.push(`<${r}> <${SKOS}topConceptOf> <${scheme}> .`);
    if (i < branches) {
      for (let k = 0; k < perBranch; k++) {
        const c = `${ns}root-${pad(i)}-kid-${pad(k)}`;
        concept(c, `Kid ${pad(i)}.${pad(k)}`);
        out.push(`<${c}> <${SKOS}broader> <${r}> .`);
      }
    }
  }
  let parent = `${ns}root-${pad(0)}-kid-${pad(0)}`;
  for (let d = 1; d < depth; d++) {
    const c = `${ns}deep-${d}`;
    concept(c, `Deep ${d}`);
    out.push(`<${c}> <${SKOS}broader> <${parent}> .`);
    parent = c;
  }
  return { text: out.join("\n"), ns, deepest: parent, pad };
}

/** Re-open the vocabulary under "Load as you browse", through the app's own path. */
async function useWindowedLoading(page) {
  await page.evaluate(async () => {
    State.load.pref = "windowed";
    await reopenCurrentScheme();
  });
  await page.waitForSelector("#tree .trow");
}

/**
 * Live mode with an explicit, exhaustive set of named-graph grants: every
 * graph in `graphs` comes back READ+WRITE, everything else reads as a
 * measured refusal rather than "cannot tell" (`Perms.entries` is non-empty).
 * Several specs were each hand-rolling this same `Perms.entries` shape
 * slightly differently -- one place for it here.
 */
async function grantLivePerms(page, graphs, opts = {}) {
  await page.evaluate(({ gs, db }) => {
    State.mode = "live";
    State.db = db;
    Perms.reset(); Perms.loaded = true; Perms.readable = true;
    Perms.entries = gs.reduce((acc, g) => acc.concat([
      { action: "READ", type: "named-graph", resources: [db, g] },
      { action: "WRITE", type: "named-graph", resources: [db, g] }]), []);
  }, { gs: graphs, db: opts.db || "testdb" });
}

/** The windowed bookkeeping, as plain data an assertion can read. */
const loadState = (page) => page.evaluate(() => ({
  mode: State.load.mode,
  windowed: Data.isWindowed(),
  tops: (State.load.tops || []).length,
  rootTotal: State.load.rootTotal,
  rootsTruncated: State.load.rootsTruncated,
  childrenOf: [...State.load.childrenOf],
  concepts: State.load.counts && State.load.counts.concepts
}));

module.exports = {
  roleName,
  APP_FILE, APP_URL, EX, cid, sdg,
  boot, switchScheme,
  treeRows, treeRow, treeHas, treeChildren, treeRoots, toggle, isExpanded, clickRow,
  appEval, broaderOf, narrowerOf, relatedOf, topConcepts, allConcepts, selected,
  triplesOf, hasTriple, quadCount,
  modalOpen, modalTitle, modalText, waitModal, okDisabled, modalOk, modalCancel,
  pick, pickClear, pickerValue, fillNewConcept, conceptByLabel, reveal,
  selectTab, addRelation, removeRelation, importText,
  rightClick, menuKeys, menuLabels, clickMenu, menuOpen, dragDrop,
  logs, alerts, clearAlerts, toasts, issues, cssEscape,
  registerRelType, unregisterRelType, relTypes, relationsOf, relSections,
  discoveredRelPredicates,
  bigSchemeTriples, useWindowedLoading, loadState, grantLivePerms
};
