const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const FORESTS = A.sdg("bosques");

/**
 * Coverage for the fifth feedback pass: Data scope (renamed, live-validated
 * db/graph pickers, a per-check scope picker shared by Triples/Relations/
 * Usage, session-only one-off scopes), a local usage-count badge in the
 * hierarchy, an explicitly-run cross-database Usage report, a class getting
 * its own real detail view (the "newly created Class can't be opened" bug),
 * creating an instance of a class, the Tag dialog's search actually working,
 * and a destination-graph picker on every "New X" creation modal.
 */

async function grantLiveDbAndGraphs(page, { dbs, graphsByDb }) {
  await page.evaluate(({ dbs, graphsByDb }) => {
    window.__realRequest = Backend.request;
    window.__realQueryOn = Backend.queryOn;
    Backend.request = async (opts) => {
      if (opts.path === "/admin/databases") return { json: async () => ({ databases: dbs }) };
      throw new Error("unexpected path " + opts.path);
    };
    Backend.queryOn = async (db) => {
      const gs = graphsByDb[db] || [];
      return { results: { bindings: gs.map((g) => ({ g: { value: g.g }, n: { value: String(g.n) } })) } };
    };
  }, { dbs, graphsByDb });
}

async function restoreLive(page) {
  await page.evaluate(() => {
    if (window.__realRequest) Backend.request = window.__realRequest;
    if (window.__realQueryOn) Backend.queryOn = window.__realQueryOn;
    if (window.__realQuery) Backend.query = window.__realQuery;
    State.mode = "mock";
  });
}

test.describe("Data scope: live-validated database/graph pickers", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });
  test.afterEach(async ({ page }) => { await restoreLive(page); });

  test("a database the server doesn't list is flagged, but Add still works", async ({ page }) => {
    await page.evaluate(() => { State.mode = "live"; });
    await grantLiveDbAndGraphs(page, { dbs: ["content-catalog"], graphsByDb: {} });
    await page.evaluate(() => openDataSources());
    await A.waitModal(page, "Data scope");
    await page.fill("#dsDb", "made-up-db");
    await page.waitForTimeout(400);
    expect(await page.$eval("#dsDbField", (el) => el.classList.contains("invalid"))).toBe(true);
    expect(await page.textContent("#dsDbWarn")).toMatch(/No database named "made-up-db" was found/);
    expect(await page.$eval("#btnDsAdd", (b) => b.disabled)).toBe(false);
  });

  test("choosing a database populates its graph picker", async ({ page }) => {
    await page.evaluate(() => { State.mode = "live"; });
    await grantLiveDbAndGraphs(page, {
      dbs: ["content-catalog"],
      graphsByDb: { "content-catalog": [{ g: "urn:content:catalog", n: 4821 }] }
    });
    await page.evaluate(() => openDataSources());
    await A.waitModal(page, "Data scope");
    await page.fill("#dsDb", "content-catalog");
    await page.waitForTimeout(400);
    await page.click("#dsGraph");
    await page.waitForTimeout(30);
    const rows = await page.$$eval("#dsGraph_wrap .pick-opt", (els) => els.map((e) => e.textContent));
    expect(rows.join(" ")).toMatch(/urn:content:catalog/);
  });
});

test.describe("Data scope: per-check scope picker shared by Triples/Relations/Usage", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });
  test.afterEach(async ({ page }) => { await restoreLive(page); });

  async function wireTwoSources(page) {
    await page.evaluate(() => {
      State.mode = "live";
      State.config.externalSources = [
        { iri: "urn:x:a", db: "content-catalog", graph: "urn:content:catalog", label: "Content Catalog" },
        { iri: "urn:x:b", db: "agent-registry", graph: null, label: "Agent Registry" }
      ];
      window.__realQuery = Backend.query;
      window.__calls = [];
      Backend.query = async (sparql, why) => {
        window.__calls.push(why);
        if (why.includes("Content Catalog") && why.includes("outgoing"))
          return { results: { bindings: [{ p: { type: "uri", value: "http://schema.org/about" }, o: { type: "uri", value: "http://example.org/doc/1" } }] } };
        if (why.includes("Agent Registry") && why.includes("incoming"))
          return { results: { bindings: [{ s: { type: "uri", value: "http://example.org/agent/42" }, p: { type: "uri", value: "http://schema.org/mentions" } }] } };
        return { results: { bindings: [] } };
      };
    });
  }

  test("checking a term federates every registered source by default, and Relations/Usage reuse the same cache", async ({ page }) => {
    await wireTwoSources(page);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    await page.click("#btnCheckExternal");
    await page.waitForTimeout(80);
    // Filtered to the federated scope-check calls -- tabUsage()'s own
    // pre-existing side-effect logging query ("concept usage") is unrelated
    // and must not be mistaken for a re-check.
    const scopeCalls = () => page.evaluate(() =>
      window.__calls.filter((w) => w.includes("Content Catalog") || w.includes("Agent Registry")).length);
    const callsAfterCheck = await scopeCalls();
    expect(callsAfterCheck).toBeGreaterThanOrEqual(4); // 2 sources x out/in
    expect(await page.textContent("#tabbody")).toContain("doc/1");

    await A.selectTab(page, "relations");
    await page.waitForTimeout(30);
    expect(await scopeCalls()).toBe(callsAfterCheck); // no re-query, just re-filtered
    expect(await page.textContent("#tabbody")).toContain("External sources — relations");

    await A.selectTab(page, "usage");
    await page.waitForTimeout(30);
    expect(await scopeCalls()).toBe(callsAfterCheck);
    const usageText = await page.textContent("#tabbody");
    expect(usageText).toContain("External usage");
    expect(usageText).toContain("agent/42");
    expect(usageText).not.toContain("doc/1"); // outgoing-only row, Usage shows incoming only
  });

  test("unchecking a scope and checking again only re-queries the scopes still ticked", async ({ page }) => {
    await wireTwoSources(page);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    await page.click("#btnCheckExternal");
    await page.waitForTimeout(80);
    await page.uncheck('[data-scopepick="urn:x:a"]');
    await page.waitForTimeout(30);
    await page.click("#btnCheckExternal");
    await page.waitForTimeout(80);
    const lastTwo = await page.evaluate(() => window.__calls.slice(-2));
    expect(lastTwo.every((w) => w.includes("Agent Registry"))).toBe(true);
    expect(await page.textContent("#tabbody")).not.toContain("doc/1");
  });

  test("a one-off scope is session-only, auto-selected, and removable", async ({ page }) => {
    await wireTwoSources(page);
    await grantLiveDbAndGraphs(page, { dbs: ["one-off-db"], graphsByDb: {} });
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    await page.click("#btnAddAdhocScope");
    await A.waitModal(page, "Add a one-off scope");
    await page.fill("#asDb", "one-off-db");
    await page.waitForTimeout(400);
    await A.modalOk(page);
    await page.waitForTimeout(30);
    const state = await page.evaluate(() => ({
      adhoc: State.adhocScopes.map((s) => s.db),
      externalSources: State.config.externalSources.length
    }));
    expect(state.adhoc).toContain("one-off-db");
    expect(state.externalSources).toBe(2); // never written to the registered list
    await page.click('[data-scopedrop="' + (await page.evaluate(() => State.adhocScopes[0].iri)) + '"]');
    await page.waitForTimeout(30);
    expect(await page.evaluate(() => State.adhocScopes.length)).toBe(0);
  });
});

test.describe("Hierarchy usage counts: local, cheap, opt-in", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("off by default; turning it on in Appearance shows a non-zero badge without any network call", async ({ page }) => {
    expect(await page.evaluate(() => State.ui.showUsageCounts)).toBe(false);
    await page.evaluate(() => {
      State.ui.showUsageCounts = true;
      renderTree();
    });
    await page.waitForTimeout(30);
    const badges = await page.$$eval(".tflag.usage", (els) => els.length);
    expect(badges).toBeGreaterThan(0);
  });

  test("the count matches localUsageCount()'s own local incoming-triple scan", async ({ page }) => {
    const n = await page.evaluate((c) => localUsageCount(c), FORESTS);
    expect(n).toBeGreaterThan(0); // bosques is broader of at least one narrower term in the demo data
  });
});

test.describe("Usage report: explicit, batched, and its results survive closing the dialog", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });
  test.afterEach(async ({ page }) => {
    await restoreLive(page);
    await page.evaluate(() => { USAGE_REPORT = null; renderUsageReportMinibarBtn(); });
  });

  test("the cost estimate reflects the chosen terms and scopes before anything runs", async ({ page }) => {
    await page.evaluate(() => {
      State.mode = "live";
      State.config.externalSources = [{ iri: "urn:x:a", db: "content-catalog", graph: null, label: "Content Catalog" }];
    });
    await page.evaluate(() => openUsageReport());
    await A.waitModal(page, "Usage report");
    const cost = await page.textContent("#urCost");
    expect(cost).toMatch(/× 1 scope/);
    // Stardog's own context shortcuts (seventh pass) are also `[data-urscope]`
    // checkboxes now, unchecked by default — target the one registered
    // source specifically rather than a bare multi-match uncheck.
    await page.uncheck('[data-urscope="urn:x:a"]');
    await page.waitForTimeout(30);
    expect(await page.textContent("#urCost")).toMatch(/Pick at least one scope/);
    expect(await page.$eval("#mOk", (b) => b.disabled)).toBe(true);
  });

  test("running a report for one term against one scope produces one counted row, and results reopen after Close", async ({ page }) => {
    await page.evaluate(() => {
      State.mode = "live";
      State.config.externalSources = [{ iri: "urn:x:a", db: "content-catalog", graph: null, label: "Content Catalog" }];
      window.__realQuery = Backend.query;
      Backend.query = async () => ({ results: { bindings: [
        { dir: { value: "out" }, n: { value: "3" } },
        { dir: { value: "in" }, n: { value: "7" } }
      ] } });
    });
    await page.evaluate(() => openUsageReport());
    await A.waitModal(page, "Usage report");
    await page.click("#urTerm");
    await page.fill("#urTerm", "Bosques");
    await page.waitForSelector("#urTerm_list .pick-opt");
    await page.click("#urTerm_list .pick-opt");
    await page.waitForTimeout(20);
    await A.modalOk(page);
    await page.waitForTimeout(150);
    const done = await page.evaluate(() => USAGE_REPORT && USAGE_REPORT.status);
    expect(done).toBe("done");
    expect(await page.evaluate(() => USAGE_REPORT.rows[0])).toMatchObject({ out: 3, in: 7 });
    // Reopen via the header mini-button and confirm the chart/table/CSV button are all there.
    expect(await page.$eval("#btnUsageReportMini", (b) => b.classList.contains("hidden"))).toBe(false);
    await page.click("#btnUsageReportMini");
    await A.waitModal(page, "Usage report");
    expect(await page.$("#modalRoot svg")).not.toBeNull();
    expect(await page.textContent("#modalRoot")).toContain("Download CSV");
  });

  test("'New report…' then Cancel keeps the completed report intact", async ({ page }) => {
    // Regression test: "New report..." used to overwrite USAGE_REPORT with
    // {status:"config"} immediately, and Cancel from that screen then set it
    // to null outright -- so backing out of "New report..." without running
    // anything discarded a completed report the user never asked to replace.
    await page.evaluate((term) => {
      USAGE_REPORT = { status: "done", terms: [term], scopes: [{ iri: "urn:x:a", db: "content-catalog", label: "Content Catalog" }],
        rows: [{ term, scope: { label: "Content Catalog" }, out: 1, in: 2, error: null }], at: new Date().toISOString() };
      renderUsageReportMinibarBtn();
    }, FORESTS);
    await page.evaluate(() => openUsageReport());
    await A.waitModal(page, "Usage report");
    await page.click("#btnUrNew");
    await page.waitForSelector("#urCost"); // only rendered by the config view, confirms the swap actually happened
    expect(await page.textContent("#modalRoot")).toContain("Before running");
    await A.modalCancel(page);
    await page.waitForTimeout(20);
    expect(await page.evaluate(() => USAGE_REPORT && USAGE_REPORT.status)).toBe("done");
    expect(await page.evaluate(() => USAGE_REPORT.rows.length)).toBe(1);
    expect(await page.$eval("#btnUsageReportMini", (b) => b.classList.contains("hidden"))).toBe(false);
  });
});

test.describe("A class opens into its own real detail view", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a newly created class opens immediately, with its own Metadata/Discussion/Graph/Triples/History tabs", async ({ page }) => {
    await page.click('[data-tm="classes"]');
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New class");
    await page.fill("#mText", "Fifth Pass Class");
    await A.modalOk(page);
    await page.waitForTimeout(60);
    const tabs = await page.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.dataset.tab));
    expect(tabs).toEqual(["metadata", "discussion", "graph", "triples", "history"]);
    expect(await page.textContent("#detailHead")).toContain("Fifth Pass Class");
    expect(await page.evaluate(() => State.selectedClass)).toBeTruthy();
  });

  /** plant-conservation's mock data has no classes of its own — mint one directly. */
  async function addAClass(page) {
    return page.evaluate(() => {
      const g = currentGraph();
      const clsIri = "https://example.org/cls/existing-class";
      State.store.add(g, iri(clsIri), P("rdf:type"), P("owl:Class"));
      State.store.add(g, iri(clsIri), P("rdfs:label"), lit("Existing Class", "en"));
      return clsIri;
    });
  }

  test("clicking an existing class row in the tree opens it the same way", async ({ page }) => {
    const clsIri = await addAClass(page);
    await page.click('[data-tm="classes"]');
    await page.waitForTimeout(30);
    await page.click(`[data-cls="${await page.evaluate((c) => CSS.escape(c), clsIri)}"]`);
    await page.waitForTimeout(30);
    expect(await page.evaluate(() => State.selectedClass)).toBe(clsIri);
    expect(await page.$$eval("#tabs [data-tab]", (els) => els.length)).toBe(5);
  });

  test("selecting a concept afterward clears the open class, so it doesn't keep winning renderDetail()'s precedence", async ({ page }) => {
    const clsIri = await addAClass(page);
    await page.evaluate((c) => { viewClass(c); renderDetail(); }, clsIri);
    await A.clickRow(page, FORESTS);
    expect(await page.evaluate(() => State.selectedClass)).toBeNull();
    expect(await page.evaluate(() => State.selected)).toBe(FORESTS);
  });
});

test.describe("Creating an instance of a class", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("mints a real skos:Concept dual-typed with the class, not a bare typed resource", async ({ page }) => {
    await page.evaluate(() => {
      const g = currentGraph();
      State.store.add(g, iri("https://example.org/cls/person"), P("rdf:type"), P("owl:Class"));
      State.store.add(g, iri("https://example.org/cls/person"), P("rdfs:label"), lit("Person", "en"));
    });
    await page.evaluate(() => { viewClass("https://example.org/cls/person"); renderDetail(); });
    await page.waitForTimeout(30);
    await page.click('[data-newinst="https://example.org/cls/person"]');
    await A.waitModal(page, "New Person");
    await page.fill("#mText", "Jane Doe");
    await A.modalOk(page);
    await page.waitForTimeout(60);
    const janeIri = await page.evaluate(() =>
      classInstances("https://example.org/cls/person")[0]);
    const info = await page.evaluate((c) => ({
      isConcept: State.store.match(currentGraph(), iri(c), P("rdf:type"), P("skos:Concept")).length > 0,
      isPerson: State.store.match(currentGraph(), iri(c), P("rdf:type"), iri("https://example.org/cls/person")).length > 0,
      topConceptOf: State.store.match(currentGraph(), iri(c), P("skos:topConceptOf"), null).length > 0,
      labelCount: xlLabels(c, "prefLabel").length
    }), janeIri);
    expect(info).toEqual({ isConcept: true, isPerson: true, topConceptOf: true, labelCount: 1 });
  });
});

test.describe("Tag dialog: search actually searches, debounced", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });
  test.afterEach(async ({ page }) => { await restoreLive(page); });

  test("typing debounces the federated search, and picking a result creates a real tag", async ({ page }) => {
    // Deliberately stays in mock mode: Backend.query is fully replaced below
    // (so the mode check inside the real one never matters for the search),
    // and createTag()'s own commit() should go through mock mode's normal
    // local-store write path, not attempt a real network transaction with
    // no live connection configured.
    await page.evaluate(() => {
      window.__realQuery = Backend.query;
      window.__searchCalls = 0;
      Backend.query = async (sparql, why) => {
        if (why.includes("tag search")) {
          window.__searchCalls++;
          return { results: { bindings: [
            { target: { value: "http://example.org/pub/1" }, title: { value: "Climate Resilience" }, year: { value: "2024" } }
          ] } };
        }
        return { results: { bindings: [] } };
      };
    });
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "usage");
    await page.click('[data-tagnew="1"]');
    await A.waitModal(page, "Tag a resource");
    await page.fill("#tagSearch", "clim");
    expect(await page.evaluate(() => window.__searchCalls)).toBe(0); // debounced, nothing fired yet
    await page.waitForTimeout(450);
    expect(await page.evaluate(() => window.__searchCalls)).toBe(1);
    await page.click("#tagSearch_wrap .pick-opt");
    await page.waitForTimeout(80);
    const tags = await page.evaluate((c) => tagsForConcept(c), FORESTS);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ target: "http://example.org/pub/1", title: "Climate Resilience", method: expect.stringContaining("Manual") });
  });

  test("picking the same content item twice does not create a duplicate tag", async ({ page }) => {
    await page.evaluate(() => {
      window.__realQuery = Backend.query;
      Backend.query = async (sparql, why) => why.includes("tag search")
        ? { results: { bindings: [{ target: { value: "http://example.org/pub/1" }, title: { value: "Climate Resilience" } }] } }
        : { results: { bindings: [] } };
    });
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "usage");
    await page.click('[data-tagnew="1"]');
    await A.waitModal(page, "Tag a resource");
    for (let i = 0; i < 2; i++) {
      await page.fill("#tagSearch", "");
      await page.fill("#tagSearch", "clim");
      await page.waitForTimeout(400);
      await page.click("#tagSearch_wrap .pick-opt");
      await page.waitForTimeout(60);
    }
    expect(await page.evaluate((c) => tagsForConcept(c), FORESTS)).toHaveLength(1);
  });
});

test.describe("Destination picker: where a new creation actually gets written", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("collapsed by default — a plain New concept still lands in currentGraph()", async ({ page }) => {
    await page.evaluate(() => newConceptPrompt(""));
    await A.waitModal(page, "New concept");
    expect(await page.$eval("#dstBody", (el) => el.classList.contains("hidden"))).toBe(true);
    await page.fill("#mText", "Plain Concept");
    await A.modalOk(page);
    await page.waitForTimeout(60);
    const g = await page.evaluate(() => currentGraph());
    expect(await page.evaluate(({ g }) =>
      State.store.match(g, null, P("skos:prefLabel"), lit("Plain Concept", State.lang)).length, { g })).toBe(1);
  });

  test("choosing a different graph in this database writes there instead, still guarded and audited with the right targetGraph", async ({ page }) => {
    const otherGraph = await page.evaluate(() => State.store.graphs().find((g) => g !== currentGraph() && g.includes("scheme")));
    await page.evaluate(() => newCollectionPrompt());
    await A.waitModal(page, "New collection");
    await page.fill("#mText", "Elsewhere Collection");
    await page.check("#dstToggle");
    await page.fill("#dstGraph", otherGraph);
    await A.modalOk(page);
    await page.waitForTimeout(60);
    const info = await page.evaluate(({ g }) => ({
      inOther: State.store.match(g, null, P("skos:prefLabel"), lit("Elsewhere Collection", State.lang)).length,
      inCurrent: State.store.match(currentGraph(), null, P("skos:prefLabel"), lit("Elsewhere Collection", State.lang)).length,
      auditTargetGraph: allAuditEvents().find((e) => e.action === "CreateCollection" && e.newValue === "Elsewhere Collection")?.targetGraph
    }), { g: otherGraph });
    expect(info.inOther).toBe(1);
    expect(info.inCurrent).toBe(0);
    expect(info.auditTargetGraph).toBe(otherGraph);
  });

  test("a same-database different-graph write does not navigate to a pane built from data it can't see", async ({ page }) => {
    // Regression test: the destination-truthy check used to be `dest && dest.db`
    // (cross-database only), so a same-database-different-graph write fell
    // through to selectConcept(newIri) anyway -- opening a concept pane whose
    // every reader queries currentGraph(), where none of its data landed.
    const otherGraph = await page.evaluate(() => State.store.graphs().find((g) => g !== currentGraph() && g.includes("scheme")));
    const before = await page.evaluate(() => State.selected);
    await page.evaluate(() => newConceptPrompt(""));
    await A.waitModal(page, "New concept");
    await page.fill("#mText", "Elsewhere Concept");
    await page.check("#dstToggle");
    await page.fill("#dstGraph", otherGraph);
    await A.modalOk(page);
    await page.waitForTimeout(60);
    expect(await page.evaluate(() => State.selected)).toBe(before);
    expect(await page.textContent("#toasts")).toContain("Concept created in");
  });

  test("checking 'save elsewhere' but leaving the field blank disables OK instead of silently falling back to currentGraph()", async ({ page }) => {
    await page.evaluate(() => newCollectionPrompt());
    await A.waitModal(page, "New collection");
    await page.fill("#mText", "Should Not Save");
    expect(await page.$eval("#mOk", (b) => b.disabled)).toBe(false);
    await page.check("#dstToggle");
    await page.waitForTimeout(20);
    expect(await page.$eval("#mOk", (b) => b.disabled)).toBe(true);
    await page.fill("#dstGraph", await page.evaluate(() => currentGraph()));
    await page.waitForTimeout(20);
    expect(await page.$eval("#mOk", (b) => b.disabled)).toBe(false);
  });

  test("a different database entirely goes through an unguarded update and never touches local state", async ({ page }) => {
    await page.evaluate(() => {
      State.mode = "live";
      window.__realRequest = Backend.request;
      window.__realQueryOn = Backend.queryOn;
      window.__realUpdateOn = Backend.updateOn;
      window.__updateCalls = [];
      Backend.request = async (opts) => opts.path === "/admin/databases"
        ? { json: async () => ({ databases: ["other-db"] }) } : (() => { throw new Error("unexpected"); })();
      Backend.queryOn = async () => ({ results: { bindings: [{ g: { value: "urn:other:graph" }, n: { value: "1" } }] } });
      Backend.updateOn = async (db, sparql, why) => { window.__updateCalls.push({ db, sparql, why }); return { applied: true }; };
    });
    await page.evaluate(() => newClassPrompt());
    await A.waitModal(page, "New class");
    await page.fill("#mText", "Remote Class");
    await page.check("#dstToggle");
    await page.check("#dstOtherDb");
    await page.waitForTimeout(30);
    await page.fill("#dstDb", "other-db");
    await page.waitForTimeout(400);
    await page.fill("#dstDbGraph", "urn:other:graph");
    await page.waitForTimeout(30);
    await A.modalOk(page);
    await page.waitForTimeout(80);
    const calls = await page.evaluate(() => window.__updateCalls);
    const thisDb = await page.evaluate(() => State.db);
    const dataCalls = calls.filter((c) => c.db === "other-db");
    // The change log still gets an entry for a cross-database write (seventh
    // feedback pass — see commitToDestination()'s doc comment on invariant 5):
    // a second, best-effort update against *this* database's own audit graph,
    // separate from the data write since two databases can't share one
    // transaction over HTTP.
    const auditCalls = calls.filter((c) => c.db === thisDb);
    expect(dataCalls.length).toBeGreaterThan(0);
    expect(dataCalls.some((c) => /INSERT DATA/.test(c.sparql) && c.sparql.includes("urn:other:graph"))).toBe(true);
    expect(auditCalls.length).toBe(1);
    expect(auditCalls[0].sparql).toContain("taxonomy/vocab#AuditEvent");
    expect(auditCalls[0].sparql).toContain('"other-db"');
    // Nothing local changed — this concept was never in currentGraph() to begin with.
    expect(await page.evaluate(() =>
      State.store.match(currentGraph(), null, P("rdfs:label"), lit("Remote Class", State.lang)).length)).toBe(0);
    await page.evaluate(() => {
      Backend.request = window.__realRequest; Backend.queryOn = window.__realQueryOn; Backend.updateOn = window.__realUpdateOn;
      State.mode = "mock";
    });
  });
});
