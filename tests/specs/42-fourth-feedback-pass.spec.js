const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const FORESTS = A.sdg("bosques");
const OTHER_SCHEME = "https://example.org/another-scheme-4";
const OTHER_CONCEPT = "https://example.org/another-scheme-4/concept/one";

/**
 * Coverage for the fourth feedback pass: full browsable/editable tabs for a
 * scheme (not just a "top concepts" list), graph-view spacing and edge
 * tooltips, a discussion-based tree filter with an explicit clear-filters
 * control, a reworded empty-scheme message, admin direct mapping edits with
 * a concept picker for the target, class creation, registered external data
 * sources on the Triples tab, and the URI template panel's hover-linked
 * preview.
 */

async function addSecondScheme(page) {
  await page.evaluate(({ other, c1 }) => {
    const g = currentGraph();
    State.store.add(g, iri(other), P("rdf:type"), P("skos:ConceptScheme"));
    State.store.add(g, iri(other), P("skos:prefLabel"), lit("Another Scheme Four", "en"));
    State.store.add(g, iri(other), P("dct:description"), lit("A scheme for the fourth pass.", "en"));
    State.store.add(g, iri(c1), P("rdf:type"), P("skos:Concept"));
    State.store.add(g, iri(c1), P("skos:prefLabel"), lit("Concept Four One", "en"));
    State.store.add(g, iri(c1), P("skos:inScheme"), iri(other));
    State.store.add(g, iri(c1), P("skos:topConceptOf"), iri(other));
  }, { other: OTHER_SCHEME, c1: OTHER_CONCEPT });
  await page.evaluate(async () => { await Data.schemesInGraph(true); renderTree(); });
}

test.describe("A scheme gets the same full tab bar a concept has", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the primary scheme's Metadata tab keeps the dashboard and adds real, editable metadata", async ({ page }) => {
    const tabs = await page.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.dataset.tab));
    expect(tabs).toEqual(["metadata", "labels", "notes", "discussion", "graph", "triples", "history"]);
    const text = await page.textContent("#tabbody");
    expect(text).toContain("Start here");        // the old dashboard's own heading
    expect(text).toContain("Scheme metadata");    // the new real-metadata section
    expect(text).toContain("URI minting");
  });

  test("clicking a scheme drops the old read-only Top-concepts grid for a full tab bar", async ({ page }) => {
    await addSecondScheme(page);
    await A.clickRow(page, FORESTS);
    await page.click(`[data-scheme="${OTHER_SCHEME}"]`);
    await page.waitForTimeout(30);
    const tabs = await page.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.dataset.tab));
    expect(tabs).toEqual(["metadata", "labels", "notes", "discussion", "graph", "triples", "history"]);
    const text = await page.textContent("#tabbody");
    expect(text).toContain("Another Scheme Four");
    expect(text).not.toContain("Top concepts");
    // dct:description has no dedicated Metadata row (only Title/URI/Graph do)
    // — it's on the Triples tab now, same as any concept's (seventh feedback
    // pass moved Metadata's old "Other properties" catch-all there).
    await page.click('[data-tab="triples"]');
    await page.waitForTimeout(30);
    expect(await page.textContent("#tabbody")).toContain("A scheme for the fourth pass.");
  });

  test("a scheme's other statements can be edited on the Triples tab, the same +Add/edit/delete a concept's can", async ({ page }) => {
    await addSecondScheme(page);
    await A.clickRow(page, FORESTS);
    await page.click(`[data-scheme="${OTHER_SCHEME}"]`);
    await page.waitForTimeout(30);
    await page.click('[data-tab="triples"]');
    await page.waitForTimeout(30);
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    await page.fill("#mProp", "http://purl.org/dc/terms/subject");
    await page.fill("#mPropVal", "Testing");
    await A.modalOk(page);
    await page.waitForTimeout(30);
    // Writing a statement re-navigates via goToSubject(), which lands back on
    // Metadata (its own default tab) — same as a concept's equivalent test.
    await page.click('[data-tab="triples"]');
    await page.waitForTimeout(30);
    expect(await page.textContent("#tabbody")).toContain("Testing");
    // The write's guard asserts rdf:type against whatever this subject really
    // is — skos:ConceptScheme here, not skos:Concept — see subjectTypeGuard().
    expect(await page.evaluate((s) =>
      State.store.match(currentGraph(), iri(s), P("dct:subject"), null).length, OTHER_SCHEME)).toBe(1);
  });

  test("a scheme's Graph tab shows its own top concepts, directed outward from the scheme", async ({ page }) => {
    await addSecondScheme(page);
    await page.evaluate((s) => Data.rootsOfScheme(s), OTHER_SCHEME);
    await A.clickRow(page, FORESTS);
    await page.click(`[data-scheme="${OTHER_SCHEME}"]`);
    await page.waitForTimeout(30);
    await A.selectTab(page, "graph");
    expect(await page.textContent("#tabbody")).toContain("Concept Four One");
  });

  test("the breadcrumb's home crumb still returns to the primary scheme's own dashboard", async ({ page }) => {
    await addSecondScheme(page);
    await page.click(`[data-scheme="${OTHER_SCHEME}"]`);
    await page.waitForTimeout(30);
    await A.clickRow(page, FORESTS);
    await page.click('[data-crumb="__scheme"]');
    await page.waitForTimeout(30);
    expect(await page.textContent("#tabbody")).toContain("Start here");
  });
});

test.describe("Graph view: spacing and edge tooltips", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the graph keeps its own aspect ratio instead of collapsing to whatever height the browser defaults to", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "graph");
    const ratio = await page.$eval(".graph", (el) => getComputedStyle(el).aspectRatio);
    expect(ratio).toMatch(/780/);
  });

  test("hovering an edge names the relation and its full predicate IRI, not just a short word", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "graph");
    const titles = await page.$$eval(".graph line title", (els) => els.map((e) => e.textContent));
    expect(titles.some((t) => /skos\/core#(broader|narrower)/.test(t))).toBe(true);
  });
});

test.describe("Tree filter: discussions, and a visible way to clear one", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("filtering to 'an unresolved discussion' only shows terms with an open thread", async ({ page }) => {
    await page.evaluate((c) => {
      Discussion.start({ concept: c, text: "Is this right? @nobody" });
    }, FORESTS);
    await page.waitForTimeout(30);
    await page.click("[data-lf-toggle]");
    await page.selectOption("#lfProp", "discussion-open");
    await page.waitForTimeout(30);
    const rows = await page.$$eval("#tree .trow[data-c]", (els) => els.map((e) => e.dataset.c));
    expect(rows).toContain(FORESTS);
    expect(rows.length).toBeLessThan(await page.evaluate(() => allConcepts().length));
  });

  test("a clear-filters chip appears while filtering, and clearing it removes the filter without closing the panel", async ({ page }) => {
    await page.click("[data-lf-toggle]");
    await page.click('[data-lf="has"]');
    await page.waitForTimeout(30);
    expect(await page.$("[data-lf-clear]")).not.toBeNull();
    await page.click("[data-lf-clear]");
    await page.waitForTimeout(30);
    expect(await page.evaluate(() => State.treeFilter.mode)).toBe("all");
    // Clearing is not the same gesture as collapsing the panel.
    expect(await page.evaluate(() => State.ui.filterOpen)).toBe(true);
  });

  test("no clear-filters chip when nothing is being filtered", async ({ page }) => {
    await page.click("[data-lf-toggle]");
    expect(await page.$("[data-lf-clear]")).toBeNull();
  });
});

test.describe("A scheme with no top concepts says so precisely", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("in a multi-scheme graph, an empty scheme reads as scheme-scoped, not vocabulary-wide", async ({ page }) => {
    await page.evaluate(() => {
      const g = currentGraph();
      State.store.add(g, iri("https://example.org/empty-scheme-4"), P("rdf:type"), P("skos:ConceptScheme"));
      State.store.add(g, iri("https://example.org/empty-scheme-4"), P("skos:prefLabel"), lit("Empty Scheme Four", "en"));
    });
    await page.evaluate(async () => { await Data.schemesInGraph(true); renderTree(); });
    await page.waitForTimeout(30);
    // A non-primary scheme's group starts collapsed — expand its twist to
    // actually render its (empty) root section and its message.
    await page.click('[data-twscheme="https://example.org/empty-scheme-4"]');
    await page.waitForTimeout(30);
    const text = await page.textContent("#tree");
    expect(text).toContain("This scheme has no top concepts.");
    expect(text).not.toContain("No concepts here.");
  });

  test("a scheme whose top concepts are only filtered out of view is never reported as genuinely empty", async ({ page }) => {
    // OTHER_SCHEME's one concept carries no discussion; FORESTS (the primary
    // scheme) gets one, so filtering to "has a discussion" leaves OTHER_SCHEME
    // with real top concepts, none of which currently match.
    await addSecondScheme(page);
    await page.evaluate((c) => { Discussion.start({ concept: c, text: "Is this right?" }); }, FORESTS);
    await page.waitForTimeout(30);
    await page.click("[data-lf-toggle]");
    await page.selectOption("#lfProp", "discussion");
    await page.waitForTimeout(30);
    await page.click(`[data-twscheme="${OTHER_SCHEME}"]`);
    await page.waitForTimeout(30);
    const text = await page.textContent("#tree");
    expect(text).toContain("No top concepts in this scheme match the current filter.");
    expect(text).not.toContain("has no top concepts");
  });
});

test.describe("Mappings: admin can add directly, or propose for review", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("with decide rights (the mock default), checking 'approve immediately' skips straight to approved", async ({ page }) => {
    await addSecondScheme(page);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "mappings");
    expect(await page.textContent("#tabbody [data-addmap]")).toContain("add");
    await page.click("#tabbody [data-addmap]");
    await A.waitModal(page, "Add a mapping");
    expect(await page.$eval("#mApproveNow", (b) => b.checked)).toBe(true);
    await A.pick(page, "mTarget", "Concept Four One");
    await A.modalOk(page);
    await page.waitForTimeout(80);
    const m = await page.evaluate(([c, t]) => mappingsOf(c).find((x) => x.target === t),
      [FORESTS, OTHER_CONCEPT]);
    expect(m.status).toBe("approved");
  });

  test("without decide rights, the modal only proposes — no checkbox, status stays 'proposed'", async ({ page }) => {
    await page.evaluate(() => {
      window.__realCanDecideMappings = canDecideMappings;
      canDecideMappings = () => false;
    });
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "mappings");
    expect(await page.textContent("#tabbody [data-addmap]")).toContain("propose");
    await page.click("#tabbody [data-addmap]");
    await A.waitModal(page, "Propose a mapping");
    expect(await page.$("#mApproveNow")).toBeNull();
    await page.fill("#mTarget", "http://aims.fao.org/aos/agrovoc/c_424242");
    await A.modalOk(page);
    await page.waitForTimeout(60);
    const m = await page.evaluate((c) =>
      mappingsOf(c).find((x) => x.target === "http://aims.fao.org/aos/agrovoc/c_424242"), FORESTS);
    expect(m.status).toBe("proposed");
    await page.evaluate(() => { canDecideMappings = window.__realCanDecideMappings; });
  });

  test("the target field is a searchable picker over this graph's own concepts, not only a bare URI box", async ({ page }) => {
    await addSecondScheme(page);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "mappings");
    await page.click("#tabbody [data-addmap]");
    await A.waitModal(page, "Add a mapping");
    await A.pick(page, "mTarget", "Concept Four One");
    expect(await page.evaluate(() => pickerValue("mTarget"))).toBe(OTHER_CONCEPT);
  });

  test("the concept picker never truncates the label, only the mono IRI beside it", async ({ page }) => {
    await addSecondScheme(page);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "mappings");
    await page.click("#tabbody [data-addmap]");
    await A.waitModal(page, "Add a mapping");
    await page.click("#mTarget");
    await page.waitForTimeout(30);
    const style = await page.evaluate(() => {
      const t = document.querySelector("#mTarget_wrap .pick-opt .t");
      const s = document.querySelector("#mTarget_wrap .pick-opt .sub");
      return {
        tFlexShrink: t && getComputedStyle(t).flexShrink,
        subMinWidth: s && getComputedStyle(s).minWidth,
        subOverflow: s && getComputedStyle(s).overflow
      };
    });
    expect(style.tFlexShrink).toBe("0");
    expect(style.subMinWidth).toBe("0px");
    expect(style.subOverflow).toBe("hidden");
  });
});

test.describe("Existing mapping decisions: gated on the graph they actually write to", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });
  test.afterEach(async ({ page }) => { await page.evaluate(() => { State.mode = "mock"; Perms.reset(); }); });

  test("draft write with no separate approved-tier grant is still enough to decide a mapping", async ({ page }) => {
    // Everything an ordinary edit needs (the graph a mapping decision
    // actually writes to, plus the audit/session graphs every write also
    // touches) is granted — deliberately no grant naming the scheme's
    // separate approved-tier graph, which a decision never touches.
    const graphs = await page.evaluate(() =>
      [currentGraph(), G.audit(new Date().toISOString()), G.sessions]);
    await A.grantLivePerms(page, graphs);
    expect(await page.evaluate(() => canDecideMappings())).toBe(true);
  });

  test("a refusal on the graph in view is still honored", async ({ page }) => {
    const draftGraph = await page.evaluate(() => currentGraph());
    await page.evaluate((g) => {
      State.mode = "live"; State.db = "testdb";
      Perms.reset(); Perms.loaded = true; Perms.readable = true;
      Perms.entries = [{ action: "READ", type: "named-graph", resources: ["testdb", g] }];
    }, draftGraph);
    expect(await page.evaluate(() => canDecideMappings())).toBe(false);
  });
});

test.describe("Classes: creating one outright, not just typing a concept as one", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the + button is visible in Classes mode and opens New class", async ({ page }) => {
    await page.click('[data-tm="classes"]');
    expect(await page.$eval("#btnNewConcept", (e) => e.classList.contains("hidden"))).toBe(false);
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New class");
  });

  test("submitting New class asserts rdf:type owl:Class and an rdfs:label, and it shows up in the Classes tree", async ({ page }) => {
    await page.click('[data-tm="classes"]');
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New class");
    await page.fill("#mText", "Author");
    await A.modalOk(page);
    await page.waitForTimeout(30);
    const newIri = await page.evaluate(() =>
      State.store.match(currentGraph(), null, P("rdfs:label"), lit("Author", State.lang))
        .map((q) => q.s.v).find((s) => State.store.match(currentGraph(), iri(s), P("rdf:type"), P("owl:Class")).length));
    expect(newIri).toBeTruthy();
    expect(await page.textContent("#tree")).toContain("Author");
  });
});

test.describe("Data scope: registering an external scope, and the Triples tab reaching it", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  // Renamed "Data sources" -> "Data scope" (fifth pass) — "data sources" is
  // Stardog admin jargon, not a phrase this app's own users reach for.
  test("Data scope lists none registered by default, and mock mode explains federation needs a live server", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    // Stardog's own context shortcuts (seventh pass) are always available as
    // scope options, so "External sources" is no longer hidden outright with
    // zero *registered* sources — it explains why none of them, shortcuts
    // included, can be reached without a live server.
    expect(await page.textContent("#tabbody")).toContain("External sources");
    expect(await page.textContent("#tabbody")).toMatch(/only run against a live\s+server/);
    await page.evaluate(() => openDataSources());
    await A.waitModal(page, "Data scope");
    expect(await page.textContent("#modalRoot")).toContain("None yet");
  });

  test("a registered source's federated lookup runs over SPARQL SERVICE, and every row says which source it came from", async ({ page }) => {
    await page.evaluate(() => {
      State.config.externalSources = [{ iri: "urn:x", db: "content-catalog", graph: "urn:content:catalog", label: "Content Catalog" }];
      State.mode = "live";
      window.__realQuery = Backend.query;
      window.__calls = [];
      Backend.query = async (sparql, why) => {
        window.__calls.push(sparql);
        if (why.includes("outgoing")) {
          return { results: { bindings: [{ p: { type: "uri", value: "http://schema.org/about" }, o: { type: "uri", value: "http://example.org/doc/1" } }] } };
        }
        return { results: { bindings: [] } };
      };
    });
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    await page.click("#btnCheckExternal");
    await page.waitForTimeout(50);
    const text = await page.textContent("#tabbody");
    expect(text).toContain("Content Catalog");
    expect(text).toContain("doc/1");
    const calls = await page.evaluate(() => window.__calls);
    expect(calls.some((q) => /SERVICE <db:\/\/content-catalog>/.test(q) && /GRAPH <urn:content:catalog>/.test(q))).toBe(true);
    await page.evaluate(() => { Backend.query = window.__realQuery; State.mode = "mock"; });
  });
});

test.describe("URI templates: hovering a token highlights where it lands in the preview", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("hovering {domain} in the legend bolds every occurrence of it in the preview URIs", async ({ page }) => {
    await page.evaluate(() => openUriTemplates());
    await A.waitModal(page, "URI templates");
    await page.hover('#tTokens [data-tok="{domain}"]');
    await page.waitForTimeout(30);
    const hi = await page.$$eval('[data-tok="{domain}"].hi', (els) => els.length);
    expect(hi).toBeGreaterThan(1);   // the legend chip itself, plus at least one preview row
  });
});
