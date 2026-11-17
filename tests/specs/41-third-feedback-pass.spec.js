const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const FORESTS = A.sdg("bosques");
const OTHER_SCHEME = "https://example.org/another-scheme-3";
const OTHER_CONCEPT = "https://example.org/another-scheme-3/concept/one";

/**
 * Coverage for the third feedback pass: the per-concept change log's actor
 * name (a second, separate bug from the one 40-second-feedback-pass.spec.js
 * already covers for the global change log), hover-to-copy generalised to
 * every instance IRI, the Triples tab's rdf:type fix, the Usage tab's class
 * cross-reference, clicking a scheme in the tree, and the expand/collapse-all
 * button becoming mode-aware.
 */

test.describe("The per-concept change log shows who really did it", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("historyOf() resolves the actor's rdfs:label, not the bare IRI tail", async ({ page }) => {
    await page.evaluate((subj) => {
      // The actor's rdfs:label lives in the same audit graph as the event
      // itself (see auditEvent()'s own T.push(... rdfs:label ...)) -- not in
      // the vocabulary graph, which is the mistake this fixture is guarding
      // against repeating in a test.
      const ag = G.audit();
      const who = iri("https://taxonomy.example.org/id/user/alex-rivera-example-org");
      State.store.add(ag, who, P("rdfs:label"), lit("alex.rivera@example.org"));
      const ev = iri(mintDerivedIri("audit", subj, "test-event"));
      State.store.add(ag, ev, P("rdf:type"), P("tax:AuditEvent"));
      State.store.add(ag, ev, P("prov:startedAtTime"), lit("2026-09-04T12:00:00Z"));
      State.store.add(ag, ev, P("prov:wasAssociatedWith"), who);
      State.store.add(ag, ev, P("tax:subject"), iri(subj));
      State.store.add(ag, ev, P("tax:action"), P("tax:AddProperty"));
    }, FORESTS);
    const h = await page.evaluate((subj) => historyOf(subj), FORESTS);
    expect(h[0].whoLabel).toBe("alex.rivera@example.org");
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "history");
    expect(await page.textContent("#tabbody")).toContain("alex.rivera@example.org");
    expect(await page.textContent("#tabbody")).not.toContain("alex-rivera-example-org");
  });

  test("resolveActorLabel() is the one place both the global and per-concept logs read from", async ({ page }) => {
    const fnBodies = await page.evaluate(() => [
      historyOf.toString().includes("resolveActorLabel"),
      allAuditEvents.toString().includes("resolveActorLabel")
    ]);
    expect(fnBodies).toEqual([true, true]);
  });
});

test.describe("Hover-to-copy works on any instance IRI, not just the header", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a related concept's IRI in the Relations tab has its own copy chip", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "relations");
    const chip = await page.$(".iri-chip");
    expect(chip).not.toBeNull();
    const btn = await page.$(".iri-chip .iri-copy-btn");
    expect(await btn.evaluate((b) => getComputedStyle(b).opacity)).toBe("0");
  });

  test("clicking any chip's copy button copies its own data-iri, via one delegated handler", async ({ page }) => {
    const c = await A.allConcepts(page).then((cs) => cs[1]);
    await A.clickRow(page, c);
    await A.selectTab(page, "metadata");
    const target = await page.evaluate(() => {
      const chip = document.querySelector("#tabbody .iri-chip");
      return chip ? chip.dataset.iri : null;
    });
    if (target) {
      await page.click("#tabbody .iri-chip .iri-copy-btn");
      expect(await page.evaluate(() => window.__clipboard)).toBe(target);
    }
  });
});

test.describe("Graph tab: rdf:type is named plainly, and direction is drawn", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the classes lane is labelled rdf:type, not 'Is a kind of'", async ({ page }) => {
    await page.evaluate((x) => {
      State.store.add(currentGraph(), iri(x), P("rdf:type"), iri("https://schema.org/Person"));
    }, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "graph");
    const text = await page.textContent("#tabbody");
    expect(text).toContain("rdf:type");
    expect(text).not.toContain("Is a kind of");
  });

  test("broader and narrower are visually distinct colors, not the same one", async ({ page }) => {
    await A.reveal(page, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "graph");
    const colors = await page.evaluate(() => {
      const of = (cls) => {
        const el = document.querySelector(`.graph line.${cls}`);
        return el ? getComputedStyle(el).stroke : null;
      };
      return { broader: of("gn-broader"), narrower: of("gn-narrower") };
    });
    expect(colors.broader).not.toBeNull();
    expect(colors.narrower).not.toBeNull();
    expect(colors.broader).not.toBe(colors.narrower);
  });

  test("every edge carries an arrowhead marker pointing from subject to object", async ({ page }) => {
    await A.reveal(page, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "graph");
    const lines = await page.$$eval("#tabbody .graph line", (els) => els.map((e) => ({
      markerEnd: e.getAttribute("marker-end"),
      cls: e.getAttribute("class"),
      x1: e.getAttribute("x1"), y1: e.getAttribute("y1"),
      x2: e.getAttribute("x2"), y2: e.getAttribute("y2")
    })));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => /^url\(#ga-/.test(l.markerEnd))).toBe(true);
    // A narrower edge's underlying triple is `outer skos:broader center`, so
    // it has to be drawn *toward* the center (390, 280 for this SVG's fixed
    // viewBox) -- otherwise the arrowhead would point the wrong way (see
    // GRAPH_LANES' `reverse` flag). It stops short of the exact center,
    // clipped to the center node's own box border (gnEdgeStop) so the
    // arrowhead lands in open space instead of under the opaque node rect
    // drawn on top of it -- so assert direction via the clip formula, not a
    // fixed point. A broader edge starts at the center instead (its source
    // end is never clipped, since the source node is drawn over it too).
    const narrower = lines.find((l) => l.cls.includes("gn-narrower"));
    const broader = lines.find((l) => l.cls.includes("gn-broader"));
    if (narrower) {
      const sx = parseFloat(narrower.x1), sy = parseFloat(narrower.y1);
      const dx = 390 - sx, dy = 280 - sy;
      const t = Math.min(dx !== 0 ? 82 / Math.abs(dx) : Infinity, dy !== 0 ? 16 / Math.abs(dy) : Infinity, 1);
      expect(parseFloat(narrower.x2)).toBeCloseTo(390 - dx * t, 1);
      expect(parseFloat(narrower.y2)).toBeCloseTo(280 - dy * t, 1);
      // Must actually be clipped -- landing exactly on the center would mean
      // the arrowhead is invisible under the node rect again.
      expect(narrower.x2 === "390.0" && narrower.y2 === "280.0").toBe(false);
    }
    if (broader) { expect(broader.x1).toBe("390.0"); expect(broader.y1).toBe("280.0"); }
  });
});

test.describe("Clicking a scheme in the tree opens its own overview", () => {
  async function addSecondScheme(page) {
    await page.evaluate(({ other, c1 }) => {
      const g = currentGraph();
      State.store.add(g, iri(other), P("rdf:type"), P("skos:ConceptScheme"));
      State.store.add(g, iri(other), P("skos:prefLabel"), lit("Another Scheme Three", "en"));
      State.store.add(g, iri(other), P("dct:description"), lit("A scheme for a click-through test.", "en"));
      State.store.add(g, iri(c1), P("rdf:type"), P("skos:Concept"));
      State.store.add(g, iri(c1), P("skos:prefLabel"), lit("Concept One", "en"));
      State.store.add(g, iri(c1), P("skos:inScheme"), iri(other));
      State.store.add(g, iri(c1), P("skos:topConceptOf"), iri(other));
    }, { other: OTHER_SCHEME, c1: OTHER_CONCEPT });
    await page.evaluate(async () => { await Data.schemesInGraph(true); renderTree(); });
  }

  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("clicking the scheme row shows its title, IRI and metadata in the detail pane, and its top concepts on the Graph tab", async ({ page }) => {
    await addSecondScheme(page);
    await A.clickRow(page, FORESTS); // select something first, so State.selected isn't already null
    await page.click(`[data-scheme="${OTHER_SCHEME}"]`);
    await page.waitForTimeout(30);
    const text = await page.textContent("#tabbody");
    expect(text).toContain("Another Scheme Three");
    expect(text).toContain(OTHER_SCHEME);
    expect(await page.evaluate(() => State.selected)).toBeNull();
    // dct:description has no dedicated row on Metadata (only Title/URI/Graph
    // do) — the Triples tab is where every other statement about a scheme
    // shows now (seventh feedback pass; Metadata's old "Other properties"
    // catch-all moved there, see CLAUDE.md's "never misrepresent the data").
    await page.click('[data-tab="triples"]');
    await page.waitForTimeout(30);
    expect(await page.textContent("#tabbody")).toContain("A scheme for a click-through test.");
    // A secondary scheme's own top concepts are on its Graph tab now, not a
    // "Top concepts" grid on Metadata -- that grid was the exact thing this
    // feedback pass removed as redundant with the tree one pane over.
    await page.click('[data-tab="graph"]');
    await page.waitForTimeout(30);
    expect(await page.textContent("#tabbody")).toContain("Concept One");
  });

  test("the breadcrumb's home crumb returns to the primary scheme's own overview", async ({ page }) => {
    await addSecondScheme(page);
    await page.click(`[data-scheme="${OTHER_SCHEME}"]`);
    await page.waitForTimeout(30);
    // The primary overview legitimately *mentions* other schemes by name (see
    // schemeOverview()'s "Also declares..." line) -- what proves we're back
    // on the primary overview, not the secondary one, is that the secondary
    // scheme's own description is gone and State.selectedScheme is cleared.
    await A.clickRow(page, FORESTS);
    await page.click('[data-crumb="__scheme"]');
    await page.waitForTimeout(30);
    expect(await page.evaluate(() => State.selectedScheme)).toBeNull();
    expect(await page.textContent("#tabbody")).not.toContain("A scheme for a click-through test.");
    expect(await page.textContent("#tabbody")).toContain("Plant Conservation and Sustainable Agriculture");
  });
});

test.describe("Expand/collapse all is mode-aware", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("hidden in Classes, shown in Hierarchy and Collections", async ({ page }) => {
    expect(await page.evaluate(() => document.getElementById("btnExpandAll").classList.contains("hidden"))).toBe(false);
    await page.click('[data-tm="classes"]');
    expect(await page.evaluate(() => document.getElementById("btnExpandAll").classList.contains("hidden"))).toBe(true);
    await page.click('[data-tm="collections"]');
    expect(await page.evaluate(() => document.getElementById("btnExpandAll").classList.contains("hidden"))).toBe(false);
  });

  test("in Collections mode, Expand all actually expands collections, not the concept tree", async ({ page }) => {
    await page.evaluate(() => {
      const g = currentGraph();
      ["a", "b"].forEach((s) => {
        State.store.add(g, iri("https://example.org/col/" + s), P("rdf:type"), P("skos:Collection"));
        State.store.add(g, iri("https://example.org/col/" + s), P("skos:prefLabel"), lit("Col " + s, "en"));
      });
      renderTree();
    });
    await page.click('[data-tm="collections"]');
    await page.click("#btnExpandAll");
    const expanded = await page.evaluate(() => [...State.expanded]);
    expect(expanded).toContain("https://example.org/col/a");
    expect(expanded).toContain("https://example.org/col/b");
  });

  test("the label reflects actual state rather than a toggle that can fall out of sync", async ({ page }) => {
    await page.click("#btnExpandAll");
    expect(await page.evaluate(() => document.getElementById("btnExpandAll").title)).toBe("Collapse all");
    await page.click('[data-tm="collections"]');
    // Collections were never touched by that Hierarchy-mode expand, so this
    // mode's own button must not claim "all expanded" just because the other
    // mode's flag was left on.
    expect(await page.evaluate(() => document.getElementById("btnExpandAll").title)).toBe("Expand all");
  });
});

test.describe("The Triples tab shows rdf:type — the ground-truth rule", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("an rdf:type triple appears on the Triples tab even though Classes also shows it", async ({ page }) => {
    await page.evaluate((x) => {
      State.store.add(currentGraph(), iri(x), P("rdf:type"), iri("https://schema.org/Person"));
    }, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    const text = await page.textContent("#tabbody");
    expect(text).toContain("rdf:type");
  });

  test("Other properties still refuses to let rdf:type be added there — Classes owns that", async ({ page }) => {
    const excluded = await page.evaluate(() => {
      const rdfType = NS.rdf + "type";
      return excludedFromOtherProps().has(rdfType);
    });
    expect(excluded).toBe(true);
  });

  /* excludedFromTriplesTab() is gone (seventh feedback pass) — the Triples
     tab excludes nothing, ever (CLAUDE.md's "never misrepresent the data",
     tightened after a customer found skos:related/narrower edges in the
     graph view with no matching Triples-tab row). manageTabFor() replaces
     it with a *different* line: not what's displayed, but which displayed
     rows get a ✎/✕ versus a "this is edited from its own tab" note. */
  test("every predicate excludedFromOtherProps() knows about routes to its own tab on a concept, except rdf:type/dct:created/dct:creator", async ({ page }) => {
    const result = await page.evaluate((c) => {
      const managed = [...excludedFromOtherProps()];
      // These three stay plain, editable Triples-tab rows: rdf:type by long-
      // standing precedent, dct:created/dct:creator because no editor for
      // them exists anywhere else in the app (caught in code review — a
      // wrong one had no way to be fixed, the exact problem the deleted
      // "Other properties" section existed to solve).
      const noRoute = new Set([NS.rdf + "type", NS.dct + "created", NS.dct + "creator"]);
      return managed.filter((p) => !noRoute.has(p)).every((p) => manageTabFor(p, c) !== null)
        && [...noRoute].every((p) => manageTabFor(p, c) === null);
    }, FORESTS);
    expect(result).toBe(true);
  });

  test("a managed-elsewhere predicate still shows a row on the Triples tab, just without edit/delete buttons", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    const text = await page.textContent("#tabbody");
    // skos:inScheme is CONCEPT_META_PREDS -- always present on a real concept.
    expect(text).toContain("skos:inScheme");
    // The Triples tab groups rows by predicate (see tripleGroupsHtml()), so
    // the predicate name is on the group's own header now, not repeated
    // inside each <tr> -- addressed by TRIPLES_OUT's index instead, the same
    // way the global button wiring itself does.
    const hasButtonOnThatRow = await page.evaluate(() => {
      const idx = TRIPLES_OUT.findIndex((q) => q.p.v === NS.skos + "inScheme");
      if (idx < 0) return null;
      return !!(document.querySelector(`[data-edittripleout="${idx}"]`) || document.querySelector(`[data-deltripleout="${idx}"]`));
    });
    expect(hasButtonOnThatRow).toBe(false);
  });
});

test.describe("The Usage tab cross-references a concept's classes", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a concept with a non-trivial rdf:type shows it on Usage, linking to Metadata and Graph", async ({ page }) => {
    await page.evaluate((x) => {
      State.store.add(currentGraph(), iri(x), P("rdf:type"), iri("https://schema.org/Person"));
    }, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "usage");
    const text = await page.textContent("#tabbody");
    expect(text).toContain("Also carries rdf:type");
    expect(await page.$('#tabbody [data-goto-tab="metadata"]')).not.toBeNull();
    expect(await page.$('#tabbody [data-goto-tab="graph"]')).not.toBeNull();
  });

  test("a concept with no extra rdf:type shows no such note", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "usage");
    expect(await page.textContent("#tabbody")).not.toContain("Also carries rdf:type");
  });
});

test.describe("Top concepts and children are ordered, not incidental", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("top concepts render alphabetically by label", async ({ page }) => {
    const roots = await A.treeRoots(page);
    const labels = roots.map((r) => r.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  test("a branch's children render alphabetically by label", async ({ page }) => {
    await A.reveal(page, FORESTS);
    const kids = await A.treeChildren(page, FORESTS);
    const labels = kids.map((r) => r.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });
});
