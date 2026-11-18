const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const FORESTS = A.sdg("forests");

/**
 * Coverage for the seventh feedback pass: the Triples tab excludes nothing
 * (a critical data-honesty fix), the Labels tab picks up plain rdfs:label,
 * "Other properties" is gone from every Metadata tab, this app's own
 * bookkeeping graphs are never a scope/write option, a cross-database write
 * gets a real change-log entry, a real permanent delete plus class
 * deprecation, right-click menus for Classes/Collections, an opt-in
 * hide-deprecated toggle, Stardog's context shortcuts as scope sources, a
 * reasoning on/off toggle, and a minimum graph-view edge length.
 */

async function restoreLive(page) {
  await page.evaluate(() => {
    if (window.__realRequest) Backend.request = window.__realRequest;
    if (window.__realQuery) Backend.query = window.__realQuery;
    if (window.__realUpdateOn) Backend.updateOn = window.__realUpdateOn;
    State.mode = "mock";
  });
}

async function rightClickCls(page, cls) {
  await page.evaluate((c) => {
    const row = document.querySelector(`.trow[data-cls="${CSS.escape(c)}"]`);
    if (!row) throw new Error("no class row for " + c);
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 5)
    }));
  }, cls);
  await page.waitForSelector(".menu.floating");
}

async function rightClickCol(page, col) {
  await page.evaluate((c) => {
    const row = document.querySelector(`.trow[data-col="${CSS.escape(c)}"]`);
    if (!row) throw new Error("no collection row for " + c);
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 5)
    }));
  }, col);
  await page.waitForSelector(".menu.floating");
}

test.describe("The Triples tab excludes nothing — the critical data-honesty fix", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a relation, a label and a note all show on the Triples tab, without edit buttons, routed to their own tab", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    const text = await page.textContent("#tabbody");
    expect(text).toContain("skos:broader");
    expect(text).toContain("skos:narrower");
    expect(text).toContain("skos:related");
    expect(text).toContain("skos:prefLabel");
    expect(text).toContain("skos:definition");
    // None of those rows carry an edit button -- they're managed elsewhere.
    const anyManagedHasEdit = await page.evaluate(() => {
      const managed = ["skos:broader", "skos:narrower", "skos:related", "skos:prefLabel", "skos:definition"]
        .map((c) => NS[c.split(":")[0]] + c.split(":")[1]);
      return TRIPLES_OUT.some((q, i) => managed.includes(q.p.v) &&
        document.querySelector(`[data-edittripleout="${i}"]`));
    });
    expect(anyManagedHasEdit).toBe(false);
  });

  test("every relation the graph view draws is also a real row on the Triples tab", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    const graphHasRelations = await page.evaluate((c) => {
      const lanes = graphNeighbourhood(c);
      return (lanes.broader || []).length + (lanes.narrower || []).length + (lanes.related || []).length > 0;
    }, FORESTS);
    await A.selectTab(page, "triples");
    const triplesHasRelations = await page.evaluate(() => {
      const preds = [NS.skos + "broader", NS.skos + "narrower", NS.skos + "related"];
      return TRIPLES_OUT.some((q) => preds.includes(q.p.v)) || TRIPLES_IN.some((q) => preds.includes(q.p.v));
    });
    expect(graphHasRelations).toBe(true);
    expect(triplesHasRelations).toBe(true);
  });

  test("manageTabFor() never routes anything for a class subject — nothing there has its own tab to go to", async ({ page }) => {
    const clsIri = await page.evaluate(() => {
      const g = currentGraph();
      const cls = iri("https://example.org/vocab/TestClass7");
      s = State.store;
      s.add(g, cls, P("rdf:type"), P("owl:Class"));
      s.add(g, cls, P("rdfs:label"), lit("Test Class Seven", "en"));
      return cls.v;
    });
    const routed = await page.evaluate((c) => manageTabFor(NS.rdfs + "label", c), clsIri);
    expect(routed).toBeNull();
  });
});

test.describe("Labels tab picks up plain rdfs:label too", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a plain rdfs:label triple shows in its own section, and can be deleted", async ({ page }) => {
    await page.evaluate((c) => {
      State.store.add(currentGraph(), iri(c), P("rdfs:label"), lit("A Plain Label", "en"));
    }, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "labels");
    expect(await page.textContent("#tabbody")).toContain("A Plain Label");
    const i = await page.evaluate(() => RDFS_LABEL_ROWS.findIndex((q) => q.o.v === "A Plain Label"));
    expect(i).toBeGreaterThanOrEqual(0);
    await page.click(`[data-delrdfslabel="${i}"]`);
    await A.waitModal(page, "Remove this statement?");
    await A.modalOk(page);
    const left = await page.evaluate((c) =>
      State.store.match(currentGraph(), iri(c), P("rdfs:label"), lit("A Plain Label", "en")).length, FORESTS);
    expect(left).toBe(0);
  });

  test("+ add opens a dedicated modal fixed to rdfs:label", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "labels");
    await page.click("#btnAddRdfsLabel");
    await A.waitModal(page, "Add a label");
    await page.fill("#mRdfsLabelText", "Freshly Added");
    await A.modalOk(page);
    await page.waitForTimeout(80);
    const found = await page.evaluate((c) =>
      State.store.match(currentGraph(), iri(c), P("rdfs:label"), null).some((q) => q.o.v === "Freshly Added"), FORESTS);
    expect(found).toBe(true);
  });
});

test.describe("Metadata's old 'Other properties' catch-all is gone", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("no #btnAddProp anywhere — concept, scheme or class Metadata", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "metadata");
    expect(await page.$("#btnAddProp")).toBeNull();
    await page.evaluate(() => viewScheme(null));
    await page.waitForTimeout(30);
    expect(await page.$("#btnAddProp")).toBeNull();
  });
});

test.describe("This app's own graphs are never a write destination", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("commitToDestination() refuses a write aimed at the change log, even typed by hand", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const auditGraph = G.audit();
      const before = State.store.match(auditGraph, null, null, null).length;
      const ok = await commitToDestination({ graph: auditGraph }, {
        label: "test", guard: [], del: [], ins: [{ s: iri("urn:x"), p: P("rdf:type"), o: iri("urn:y") }]
      });
      const after = State.store.match(auditGraph, null, null, null).length;
      return { ok, before, after };
    });
    expect(result.ok).toBe(false);
    expect(result.after).toBe(result.before);
    expect(await A.toasts(page)).toMatch(/own graphs/i);
  });

  test("listGraphsInDb() never suggests an app-internal graph", async ({ page }) => {
    await page.evaluate(() => {
      State.mode = "live";
      window.__realRequest = Backend.request;
      Backend.request = async (opts) => ({
        json: async () => ({
          results: { bindings: [
            { g: { value: "urn:taxonomy:app:audit" }, n: { value: "5" } },
            { g: { value: "urn:taxonomy:scheme:plant-conservation:draft" }, n: { value: "10" } }
          ] }
        })
      });
      window.__realQueryOn = Backend.queryOn;
      Backend.queryOn = async () => ({ results: { bindings: [
        { g: { value: "urn:taxonomy:app:audit" }, n: { value: "5" } },
        { g: { value: "urn:taxonomy:scheme:plant-conservation:draft" }, n: { value: "10" } }
      ] } });
    });
    const graphs = await page.evaluate(() => listGraphsInDb("some-db"));
    expect(graphs.map((g) => g.g)).not.toContain("urn:taxonomy:app:audit");
    expect(graphs.map((g) => g.g)).toContain("urn:taxonomy:scheme:plant-conservation:draft");
    await restoreLive(page);
  });
});

test.describe("Cross-database writes get a real change-log entry", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });
  test.afterEach(async ({ page }) => { await restoreLive(page); });

  test("every audit event carries tax:targetDatabase, defaulting to State.db", async ({ page }) => {
    await page.evaluate((c) => {
      const C = iri(c);
      commit(mutation({
        label: "test", graph: currentGraph(), guard: [],
        del: [], ins: [{ s: C, p: P("dct:subject"), o: lit("test") }],
        audit: auditEvent({ action: "AddProperty", subject: c, property: P("dct:subject"), newValue: lit("test") })
      }));
    }, FORESTS);
    await page.waitForTimeout(50);
    const db = await page.evaluate(() =>
      allAuditEvents().find((e) => e.action === "AddProperty")?.targetDatabase);
    const expectedDb = await page.evaluate(() => State.db);
    expect(db).toBe(expectedDb);
  });
});

test.describe("A real, permanent delete, and deprecation for classes", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("deleteResourcePrompt() requires the confirmation checkbox, then removes every triple naming the resource", async ({ page }) => {
    const scratch = await page.evaluate(() => {
      const g = currentGraph();
      const c = iri("https://example.org/scratch/delete-me");
      State.store.add(g, c, P("rdf:type"), P("skos:Concept"));
      State.store.add(g, c, P("skos:prefLabel"), lit("Delete Me", "en"));
      return c.v;
    });
    await page.evaluate((c) => deleteResourcePrompt(c), scratch);
    await A.waitModal(page, "Delete this");
    expect(await A.okDisabled(page)).toBe(true);
    await page.check("#mConfirmDelete");
    expect(await A.okDisabled(page)).toBe(false);
    await A.modalOk(page);
    await page.waitForTimeout(80);
    const left = await page.evaluate((c) => State.store.match(currentGraph(), iri(c), null, null).length, scratch);
    expect(left).toBe(0);
  });

  test("deprecateClassPrompt() sets tax:lifecycleStatus without touching instances", async ({ page }) => {
    const cls = await page.evaluate(() => {
      const g = currentGraph();
      const c = iri("https://example.org/vocab/Retiree");
      State.store.add(g, c, P("rdf:type"), P("owl:Class"));
      State.store.add(g, c, P("rdfs:label"), lit("Retiree", "en"));
      return c.v;
    });
    await page.evaluate((c) => deprecateClassPrompt(c), cls);
    await A.waitModal(page, "Deprecate class");
    await A.modalOk(page);
    await page.waitForTimeout(80);
    expect(await page.evaluate((c) => lifecycle(c), cls)).toBe("deprecated");
  });
});

test.describe("Right-click menus for Classes and Collections", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a class row's menu offers New instance, Deprecate, Delete, Copy URI", async ({ page }) => {
    const cls = await page.evaluate(() => {
      const g = currentGraph();
      const c = iri("https://example.org/vocab/MenuClass");
      State.store.add(g, c, P("rdf:type"), P("owl:Class"));
      State.store.add(g, c, P("rdfs:label"), lit("Menu Class", "en"));
      return c.v;
    });
    await page.evaluate(() => { State.treeMode = "classes"; renderTree(); });
    await rightClickCls(page, cls);
    const keys = await A.menuKeys(page);
    expect(keys).toEqual(expect.arrayContaining(["newinst", "dep", "del", "copy"]));
  });

  test("a collection row's menu offers Delete and Copy URI only", async ({ page }) => {
    const col = await page.evaluate(() => {
      const g = currentGraph();
      const c = iri("https://example.org/vocab/MenuCollection");
      State.store.add(g, c, P("rdf:type"), P("skos:Collection"));
      State.store.add(g, c, P("skos:prefLabel"), lit("Menu Collection", "en"));
      return c.v;
    });
    await page.evaluate(() => { State.treeMode = "collections"; renderTree(); });
    await rightClickCol(page, col);
    const keys = await A.menuKeys(page);
    expect(keys).toEqual(["del", "copy"]);
  });

  test("the concept tree's own menu now offers Delete too", async ({ page }) => {
    await A.rightClick(page, FORESTS);
    const keys = await A.menuKeys(page);
    expect(keys).toContain("del");
  });
});

test.describe("Hide deprecated — opt-in, composes with other filters", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("off by default; turning it on hides a deprecated leaf concept from the tree", async ({ page }) => {
    // A leaf (no children of its own) under FORESTS: subtreeMatches()'s own
    // ancestor-passthrough logic (built for search filters, so a matching
    // descendant's path stays reachable) means a *parent* with non-deprecated
    // children keeps showing regardless of this toggle -- deliberately, so
    // hiding deprecated things never orphans something that isn't. A childless
    // leaf has no such passthrough reason to stay, which is what this checks.
    const leaf = await page.evaluate((parent) => {
      const g = currentGraph();
      const c = iri("https://example.org/scratch/deprecated-leaf");
      State.store.add(g, c, P("rdf:type"), P("skos:Concept"));
      State.store.add(g, c, P("skos:prefLabel"), lit("Deprecated Leaf", "en"));
      State.store.add(g, c, P("skos:broader"), iri(parent));
      State.store.add(g, c, P("tax:lifecycleStatus"), lit("deprecated"));
      State.expanded.add(parent);
      renderTree();
      return c.v;
    }, FORESTS);
    expect(await A.treeHas(page, leaf)).toBe(true);
    expect(await A.treeHas(page, FORESTS)).toBe(true);
    await page.evaluate(() => { State.ui.hideDeprecated = true; renderTree(); });
    expect(await A.treeHas(page, leaf)).toBe(false);
    expect(await A.treeHas(page, FORESTS)).toBe(true); // an unrelated, non-deprecated row is unaffected
    await page.evaluate(() => { State.ui.hideDeprecated = false; renderTree(); });
    expect(await A.treeHas(page, leaf)).toBe(true);
  });
});

test.describe("Stardog context shortcuts as scope sources", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the four shortcuts are always listed, and unchecked by default even before anything else is touched", async ({ page }) => {
    const sources = await page.evaluate(() => allScopeSources().map((s) => s.iri));
    ["urn:taxonomy:context:local", "urn:taxonomy:context:virtual",
      "urn:taxonomy:context:all", "urn:taxonomy:context:named"].forEach((iri) => {
      expect(sources).toContain(iri);
    });
    const active = await page.evaluate(() => activeScopeSources().map((s) => s.iri));
    expect(active).not.toContain("urn:taxonomy:context:all");
  });

  test("checking one explicitly makes it active", async ({ page }) => {
    await page.evaluate(() => { State.scopeSelection = new Set(["urn:taxonomy:context:local"]); });
    const active = await page.evaluate(() => activeScopeSources().map((s) => s.iri));
    expect(active).toEqual(["urn:taxonomy:context:local"]);
  });
});

test.describe("Reasoning toggle", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });
  test.afterEach(async ({ page }) => { await restoreLive(page); });

  test("clicking the header toggle flips State.reasoningEnabled, and Backend.query() sends infer=true when on", async ({ page }) => {
    // Top-level State, not State.ui -- it changes query semantics, not
    // layout, so it must not silently survive a reload (caught in code
    // review — see ARCHITECTURE.md's "Reasoning" settled decision).
    expect(await page.evaluate(() => State.reasoningEnabled)).toBe(false);
    await page.click("#btnReasoningToggle");
    expect(await page.evaluate(() => State.reasoningEnabled)).toBe(true);

    await page.evaluate(() => {
      State.mode = "live";
      window.__realRequest = Backend.request;
      window.__lastParams = null;
      Backend.request = async (opts) => {
        window.__lastParams = Object.fromEntries(new URLSearchParams(opts.body));
        return { json: async () => ({ results: { bindings: [] } }) };
      };
    });
    await page.evaluate(() => Backend.query("SELECT * WHERE { ?s ?p ?o }", "test"));
    const params = await page.evaluate(() => window.__lastParams);
    expect(params.infer).toBe("true");

    await page.click("#btnReasoningToggle");
    await page.evaluate(() => Backend.query("SELECT * WHERE { ?s ?p ?o }", "test"));
    const params2 = await page.evaluate(() => window.__lastParams);
    expect(params2.infer).toBeUndefined();
  });

  test("the gear icon opens a read-only info panel, never a picker with an Apply", async ({ page }) => {
    await page.click("#btnReasoningGear");
    await A.waitModal(page, "Reasoning");
    const text = await page.textContent("#modalRoot");
    expect(text).toMatch(/is currently (on|off)/);
    expect(await page.$("#modalRoot select")).toBeNull(); // no functioning schema picker
  });
});

test.describe("Graph view: a minimum visible edge length", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("every edge's rendered length is at least GN_MIN_EDGE", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "graph");
    const lengths = await page.$$eval(".graph .ge", (lines) => lines.map((l) => {
      const x1 = Number(l.getAttribute("x1")), y1 = Number(l.getAttribute("y1"));
      const x2 = Number(l.getAttribute("x2")), y2 = Number(l.getAttribute("y2"));
      return Math.hypot(x2 - x1, y2 - y1);
    }));
    const minEdge = await page.evaluate(() => GN_MIN_EDGE);
    expect(lengths.length).toBeGreaterThan(0);
    lengths.forEach((len) => expect(len).toBeGreaterThanOrEqual(minEdge - 1)); // -1: sub-pixel rounding in toFixed(1)
  });
});

test.describe("Usage report: select-all/none, bulk-add terms, and explicit include/exclude", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => { USAGE_REPORT = null; renderUsageReportMinibarBtn(); });
  });

  test("Scheme All/None check and uncheck every scheme checkbox", async ({ page }) => {
    await page.evaluate(() => openUsageReport());
    await A.waitModal(page, "Usage report");
    await page.click("#urSchemeNone");
    expect(await page.$$eval("[data-urscheme]:checked", (e) => e.length)).toBe(0);
    await page.click("#urSchemeAll");
    const total = await page.$$eval("[data-urscheme]", (e) => e.length);
    expect(await page.$$eval("[data-urscheme]:checked", (e) => e.length)).toBe(total);
  });

  test("+ add every term in the checked scheme(s) bulk-populates the chip list", async ({ page }) => {
    await page.evaluate(() => openUsageReport());
    await A.waitModal(page, "Usage report");
    await page.click("#btnUrAddAllTerms");
    const chips = await page.$$eval("#urTermChips [data-urterm]", (e) => e.length);
    expect(chips).toBeGreaterThan(0);
    expect(await page.$("#urTermModeRow")).not.toBeNull();
    expect(await page.$eval("#urTermModeRow", (el) => el.classList.contains("hidden"))).toBe(false);
  });

  test("exclude mode runs every term in scope except the picked ones", async ({ page }) => {
    await page.evaluate(() => openUsageReport());
    await A.waitModal(page, "Usage report");
    const label = await page.evaluate((c) => labelText(c).plain, FORESTS);
    await A.pick(page, "urTerm", label);
    await page.check('input[name="urTermMode"][value="exclude"]');
    const { terms } = await page.evaluate(() => readUsageReportForm());
    expect(terms).not.toContain(FORESTS);
  });
});
