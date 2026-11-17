const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const FORESTS = A.sdg("bosques");
const ORCID = "https://example.org/ns/agents#orcid";
const OTHER_SCHEME = "https://example.org/another-scheme";
const OTHER_CONCEPT = "https://example.org/another-scheme/concept/one";

/**
 * Coverage for three features that shipped in an earlier pass (see
 * developer-docs/FUNCTION-MAP.md's "Multi-scheme tree, the Triples tab, and
 * the SPARQL console" section) but never got their own tests: the
 * scheme-grouped tree and moving a concept between schemes, the Triples
 * tab's original add/edit/remove flow, and the free-form SPARQL console.
 * mock mode's own demo schemes each live in their own separate graph, so a
 * second real scheme sharing one graph is built by hand below rather than
 * switching to a fixture that doesn't exist.
 */
async function addSecondScheme(page) {
  await page.evaluate(({ other, c1 }) => {
    const g = currentGraph();
    State.store.add(g, iri(other), P("rdf:type"), P("skos:ConceptScheme"));
    State.store.add(g, iri(other), P("skos:prefLabel"), lit("Another Scheme", "en"));
    State.store.add(g, iri(c1), P("rdf:type"), P("skos:Concept"));
    State.store.add(g, iri(c1), P("skos:prefLabel"), lit("Concept One", "en"));
    State.store.add(g, iri(c1), P("skos:inScheme"), iri(other));
    State.store.add(g, iri(c1), P("skos:topConceptOf"), iri(other));
  }, { other: OTHER_SCHEME, c1: OTHER_CONCEPT });
  await page.evaluate(async () => { await Data.schemesInGraph(true); renderTree(); });
}

test.describe("Multi-scheme tree", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
  });

  test("a graph declaring a second scheme groups the tree by scheme", async ({ page }) => {
    await addSecondScheme(page);
    const groups = await page.$$eval(".trow[data-scheme]", (els) => els.map((e) => e.dataset.scheme));
    expect(groups).toHaveLength(2);
    expect(groups).toContain(OTHER_SCHEME);
    expect(await page.textContent("#tree")).toContain("Another Scheme");
  });

  test("expanding a non-primary scheme's group loads and shows its own top concepts", async ({ page }) => {
    await addSecondScheme(page);
    expect(await page.$(`.trow[data-c="${OTHER_CONCEPT}"]`)).toBeNull();
    await page.click(`[data-twscheme="${OTHER_SCHEME}"]`);
    await page.waitForSelector(`.trow[data-c="${OTHER_CONCEPT}"]`);
    expect(await page.textContent(`.trow[data-c="${OTHER_CONCEPT}"]`)).toContain("Concept One");
  });

  test("moving a concept to another scheme updates its skos:inScheme and the change log", async ({ page }) => {
    await addSecondScheme(page);
    await A.rightClick(page, FORESTS);
    expect(await A.menuKeys(page)).toContain("movescheme");
    await A.clickMenu(page, "movescheme");
    await A.waitModal(page, "Move to another scheme");
    await page.selectOption("#mScheme", OTHER_SCHEME);
    await A.modalOk(page);
    const schemes = await page.evaluate((c) => conceptSchemes(c), FORESTS);
    expect(schemes).toEqual([OTHER_SCHEME]);
    const fresh = await A.logs(page, "audit");
    expect(fresh.map((e) => (e.msg || "") + (e.code || "")).join(" | ")).toMatch(/MoveConceptScheme/);
  });

  test("with only one scheme declared, the tree is unchanged — no group header at all", async ({ page }) => {
    expect(await page.$(".trow[data-scheme]")).toBeNull();
  });
});

test.describe("Triples tab: outgoing and incoming add/edit/remove", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await A.reveal(page, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
  });

  test("an outgoing statement can be added, edited and removed from this tab", async ({ page }) => {
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    await page.fill("#mProp", ORCID);
    await page.fill("#mPropVal", "0000-0002-1825-0097");
    await A.modalOk(page);
    await A.selectTab(page, "triples");
    expect(await page.textContent("#tabbody")).toContain("0000-0002-1825-0097");

    const i = await page.evaluate((p) => TRIPLES_OUT.findIndex((q) => q.p.v === p), ORCID);
    await page.click(`#tabbody [data-edittripleout="${i}"]`);
    await A.waitModal(page, "Change this value");
    await page.fill("#mPropVal", "0000-0001-5109-3700");
    await A.modalOk(page);
    expect(await page.textContent("#tabbody")).toContain("0000-0001-5109-3700");

    await A.selectTab(page, "triples");
    const i2 = await page.evaluate((p) => TRIPLES_OUT.findIndex((q) => q.p.v === p), ORCID);
    await page.click(`#tabbody [data-deltripleout="${i2}"]`);
    await A.waitModal(page, "Remove this statement?");
    await A.modalOk(page);
    const left = await page.evaluate((c) =>
      State.store.match(currentGraph(), iri(c), iri("https://example.org/ns/agents#orcid"), null), FORESTS);
    expect(left).toEqual([]);
  });

  test("an incoming statement can be added and removed", async ({ page }) => {
    const otherLabel = await page.evaluate((f) =>
      labelText(allConcepts().find((c) => c !== f)).plain, FORESTS);
    await page.click("#btnAddTripleIn");
    await A.waitModal(page, "Add a statement pointing here");
    await A.pick(page, "mInSubj", otherLabel);
    await page.fill("#mInProp", "http://purl.org/dc/terms/relation");
    await A.modalOk(page);
    await A.selectTab(page, "triples");
    const before = await page.$$eval("#tabbody [data-deltriplein]", (e) => e.length);
    expect(before).toBeGreaterThan(0);

    // Index by predicate, not position 0: the incoming table now shows every
    // incoming statement unconditionally (relations and mappings included —
    // see CLAUDE.md), so a concept with narrower/broader/mapped neighbours
    // has other incoming rows ahead of the one this test just added.
    const i = await page.evaluate((p) => TRIPLES_IN.findIndex((q) => q.p.v === p),
      "http://purl.org/dc/terms/relation");
    expect(i).toBeGreaterThanOrEqual(0);
    await page.click(`#tabbody [data-deltriplein="${i}"]`);
    await A.waitModal(page, "Remove this statement?");
    await A.modalOk(page);
    await A.selectTab(page, "triples");
    const after = await page.$$eval("#tabbody [data-deltriplein]", (e) => e.length);
    expect(after).toBe(before - 1);
  });
});

test.describe("SPARQL console", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await page.evaluate(() => {
      window.__calls = [];
      State.mode = "live";
      State.db = "testdb";
      State.conn = Object.assign({}, State.conn, { user: "tester", endpoint: "https://x.test" });
      window.__realRequest = Backend.request;
      Backend.request = async (o) => {
        window.__calls.push({ method: o.method || "GET", path: o.path, body: o.body && o.body.toString ? o.body.toString() : "" });
        if (/\/admin\/databases$/.test(o.path)) return { ok: true, json: async () => ({ databases: ["testdb", "otherdb"] }) };
        if (/\/query$/.test(o.path)) return {
          ok: true,
          json: async () => ({ head: { vars: ["s"] }, results: { bindings: [{ s: { type: "uri", value: "http://example.org/x" } }] } })
        };
        if (/\/transaction\/begin$/.test(o.path)) return { ok: true, text: async () => "tx-1" };
        return { ok: true, text: async () => "", json: async () => ({ boolean: true }) };
      };
    });
  });
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => { if (window.__realRequest) Backend.request = window.__realRequest; });
  });

  test("a SELECT renders a results table", async ({ page }) => {
    await page.evaluate(() => openSparqlConsole());
    await A.waitModal(page, "SPARQL Query");
    await page.fill("#sqText", "SELECT ?s WHERE { ?s a <http://x/Thing> }");
    await page.click("#sqRun");
    await page.waitForTimeout(80);
    expect(await page.textContent("#sqResults")).toContain("http://example.org/x");
  });

  test("an INSERT against the open database is one transaction with a paired audit event", async ({ page }) => {
    await page.evaluate(() => openSparqlConsole());
    await A.waitModal(page, "SPARQL Query");
    await page.selectOption("#sqDb", "testdb");
    await page.fill("#sqText", "INSERT DATA { GRAPH <urn:taxonomy:scheme:plant-conservation:draft> { <http://x/a> <http://x/b> \"c\" } }");
    await page.click("#sqRun");
    await page.waitForTimeout(80);
    const calls = await page.evaluate(() => window.__calls);
    expect(calls.filter((c) => /\/transaction\/begin$/.test(c.path))).toHaveLength(1);
    expect(calls.filter((c) => /\/tx-1\/update$/.test(c.path))).toHaveLength(2);
    const auditCall = calls.find((c) => /\/tx-1\/update$/.test(c.path) && /SparqlConsoleUpdate/.test(c.body));
    expect(auditCall).toBeTruthy();
  });

  test("an INSERT against a different database is a single plain request, with no audit event", async ({ page }) => {
    await page.evaluate(() => openSparqlConsole());
    await A.waitModal(page, "SPARQL Query");
    await page.selectOption("#sqDb", "otherdb");
    expect(await page.textContent("#sqNote")).toMatch(/not.*recorded/i);
    await page.fill("#sqText", "INSERT DATA { GRAPH <urn:x> { <http://x/a> <http://x/b> \"c\" } }");
    await page.click("#sqRun");
    await page.waitForTimeout(80);
    const calls = await page.evaluate(() => window.__calls);
    expect(calls.filter((c) => /\/transaction\/begin$/.test(c.path))).toHaveLength(0);
    expect(calls.filter((c) => /\/otherdb\/update$/.test(c.path))).toHaveLength(1);
  });
});
