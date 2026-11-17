const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const FORESTS = A.sdg("bosques");
const TAG_PRED = "http://example.org/vocab#tag";

/**
 * Coverage for the eighth feedback pass: a graph-view arrow direction fix,
 * per-predicate windowing on the Triples tab, the external-sources scope
 * picker moved to the top of the tab, a confirmation step before a single
 * statement is removed, a class/scheme tab bar that stays put across a
 * refresh, and three new tour stops.
 */

test.describe("Graph view: rdf:type arrow points at the class, not the instance", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("CLASS_GRAPH_LANES' instances lane is reversed, like its subclasses sibling", async ({ page }) => {
    const lanes = await page.evaluate(() => CLASS_GRAPH_LANES.map((l) => ({ key: l.key, reverse: !!l.reverse })));
    expect(lanes.find((l) => l.key === "instances").reverse).toBe(true);
    expect(lanes.find((l) => l.key === "subclasses").reverse).toBe(true);
    expect(lanes.find((l) => l.key === "superclasses").reverse).toBe(false);
  });

  test("the rendered instances-lane edge's arrowhead end sits at the class's own center", async ({ page }) => {
    const cls = "https://example.org/vocab/ArrowClass";
    await page.evaluate(({ cls, c }) => {
      const g = currentGraph();
      State.store.add(g, iri(cls), P("rdf:type"), P("owl:Class"));
      State.store.add(g, iri(cls), P("rdfs:label"), lit("Arrow Class", "en"));
      State.store.add(g, iri(c), P("rdf:type"), iri(cls));
      viewClass(cls); renderTree(); renderDetail(); renderCtx();
    }, { cls, c: FORESTS });
    await A.selectTab(page, "graph");
    const centers = await page.evaluate(() => ({ cx: GRAPH_W / 2, cy: GRAPH_H / 2 }));
    const edge = await page.$eval(".graph .ge.gn-rel", (l) => ({
      x1: Number(l.getAttribute("x1")), y1: Number(l.getAttribute("y1")),
      x2: Number(l.getAttribute("x2")), y2: Number(l.getAttribute("y2"))
    }));
    // x2,y2 is always where marker-end (the arrowhead) lands (see tabGraph());
    // both ends are trimmed to their own node's border (gnEdgeStop()), not the
    // exact center, so the real assertion is "closer to the class's own
    // center than the other end is" rather than an exact coordinate match.
    const distToCenter = (x, y) => Math.hypot(x - centers.cx, y - centers.cy);
    expect(distToCenter(edge.x2, edge.y2)).toBeLessThan(distToCenter(edge.x1, edge.y1));
  });
});

test.describe("Triples tab: grouped and windowed per predicate", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await page.evaluate(({ c, pred }) => {
      const g = currentGraph();
      for (let i = 0; i < 8; i++) State.store.add(g, iri(c), iri(pred), lit(`tag${i}`, null, null));
    }, { c: FORESTS, pred: TAG_PRED });
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
  });

  const shownIdxsFor = (page, pred) => page.evaluate((p) =>
    [...document.querySelectorAll("[data-deltripleout]")]
      .map((b) => Number(b.dataset.deltripleout))
      .filter((i) => TRIPLES_OUT[i].p.v === p), pred);

  test("only 5 of 8 same-predicate rows show at first, with show-more/show-all", async ({ page }) => {
    expect(await shownIdxsFor(page, TAG_PRED)).toHaveLength(5);
    const buttons = await page.$$eval(
      `[data-growtriple="out"][data-growpred="${TAG_PRED}"]`, (bs) => bs.map((b) => b.textContent));
    expect(buttons.some((t) => /Show 50 more/.test(t))).toBe(true);
    expect(buttons.some((t) => /Show all/.test(t))).toBe(true);
    // Nothing is actually missing -- every row still lives in TRIPLES_OUT.
    const total = await page.evaluate((p) => TRIPLES_OUT.filter((q) => q.p.v === p).length, TAG_PRED);
    expect(total).toBe(8);
  });

  test("Show all reveals every row in the group", async ({ page }) => {
    await page.click(`[data-growtriple="out"][data-growpred="${TAG_PRED}"][data-growwant="100000"]`);
    await page.waitForTimeout(60);
    expect(await shownIdxsFor(page, TAG_PRED)).toHaveLength(8);
    // The group is now exhausted -- no further show-more/show-all for it.
    expect(await page.$(`[data-growtriple="out"][data-growpred="${TAG_PRED}"]`)).toBeNull();
  });

  test("editing a windowed row changes exactly that value, not some other row in the group", async ({ page }) => {
    const before = await page.evaluate((p) =>
      TRIPLES_OUT.findIndex((q) => q.p.v === p && q.o.v === "tag2"), TAG_PRED);
    await page.click(`#tabbody [data-edittripleout="${before}"]`);
    await A.waitModal(page, "Change this value");
    await page.fill("#mPropVal", "tag2-edited");
    await A.modalOk(page);
    const values = await page.evaluate(({ c, p }) =>
      State.store.match(currentGraph(), iri(c), iri(p), null).map((q) => q.o.v).sort(),
      { c: FORESTS, p: TAG_PRED });
    expect(values).toEqual(["tag0", "tag1", "tag2-edited", "tag3", "tag4", "tag5", "tag6", "tag7"].sort());
  });
});

test.describe("External sources: moved to the top of the tab", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the scope picker's own section comes before the Triples section in the tab body", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    const html = await page.$eval("#tabbody", (el) => el.innerHTML);
    const extAt = html.indexOf("External sources");
    const triplesAt = html.indexOf("<h3>Triples");
    expect(extAt).toBeGreaterThanOrEqual(0);
    expect(triplesAt).toBeGreaterThan(extAt);
  });
});

test.describe("Removing a single statement asks first", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("clicking the outgoing ✕ opens a confirmation, and Cancel leaves the statement alone", async ({ page }) => {
    await page.evaluate((c) => {
      State.store.add(currentGraph(), iri(c), iri("http://example.org/vocab#cancelMe"), lit("still here", null, null));
    }, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    const i = await page.evaluate(() => TRIPLES_OUT.findIndex((q) => q.p.v === "http://example.org/vocab#cancelMe"));
    await page.click(`#tabbody [data-deltripleout="${i}"]`);
    await A.waitModal(page, "Remove this statement?");
    await A.modalCancel(page);
    const still = await page.evaluate((c) =>
      State.store.match(currentGraph(), iri(c), iri("http://example.org/vocab#cancelMe"), null).length, FORESTS);
    expect(still).toBe(1);
  });

  test("confirming removes exactly that statement", async ({ page }) => {
    await page.evaluate((c) => {
      State.store.add(currentGraph(), iri(c), iri("http://example.org/vocab#removeMe"), lit("bye", null, null));
    }, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    const i = await page.evaluate(() => TRIPLES_OUT.findIndex((q) => q.p.v === "http://example.org/vocab#removeMe"));
    await page.click(`#tabbody [data-deltripleout="${i}"]`);
    await A.waitModal(page, "Remove this statement?");
    expect(await page.textContent("#modalRoot .modal")).toContain("removeMe");
    await A.modalOk(page);
    const left = await page.evaluate((c) =>
      State.store.match(currentGraph(), iri(c), iri("http://example.org/vocab#removeMe"), null).length, FORESTS);
    expect(left).toBe(0);
  });
});

test.describe("A class's own tab bar stays where it was left", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("deleting a Triples-tab row on a class does not bounce the class back to Metadata", async ({ page }) => {
    const cls = "https://example.org/vocab/StickyClass";
    await page.evaluate((c) => {
      const g = currentGraph();
      State.store.add(g, iri(c), P("rdf:type"), P("owl:Class"));
      State.store.add(g, iri(c), P("rdfs:label"), lit("Sticky Class", "en"));
      State.store.add(g, iri(c), iri("http://example.org/vocab#note"), lit("delete me", null, null));
      viewClass(c); renderTree(); renderDetail(); renderCtx();
    }, cls);
    await A.selectTab(page, "triples");
    expect(await page.evaluate(() => State.classTab)).toBe("triples");

    const i = await page.evaluate(() => TRIPLES_OUT.findIndex((q) => q.p.v === "http://example.org/vocab#note"));
    await page.click(`#tabbody [data-deltripleout="${i}"]`);
    await A.waitModal(page, "Remove this statement?");
    await A.modalOk(page);

    expect(await page.evaluate(() => State.classTab)).toBe("triples");
    expect(await page.evaluate(() => document.querySelector(".tab.on")?.textContent)).toMatch(/Triples/);
  });
});

test.describe("Guided tour: three new stops", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the Triples tab, SPARQL console and Usage report all appear as tour stops", async ({ page }) => {
    const titles = await page.evaluate(() => WORKSPACE_TOUR_STEPS.map((s) => s.title));
    expect(titles.some((t) => /raw RDF/.test(t))).toBe(true);
    expect(titles.some((t) => /SPARQL query/i.test(t))).toBe(true);
    expect(titles.some((t) => /Usage report/.test(t))).toBe(true);
  });

  test("opening the SPARQL console in mock mode shows no error toast (a real, fixed bug)", async ({ page }) => {
    await page.evaluate(() => openSparqlConsole());
    await page.waitForSelector("#sqText");
    await page.waitForTimeout(60);
    const errorToasts = await page.$$eval("#toasts .toast.error", (els) => els.length);
    expect(errorToasts).toBe(0);
    await A.modalCancel(page);
  });

  test("stepping to the SPARQL-query and usage-report tour stops opens the real panels", async ({ page }) => {
    await page.evaluate(() => startTour());
    const idxSparql = await page.evaluate(() => WORKSPACE_TOUR_STEPS.findIndex((s) => /SPARQL query/i.test(s.title)));
    await page.evaluate((i) => tourGoto(i), idxSparql);
    await page.waitForSelector("#sqText");
    expect(await page.textContent("#tourBubble")).toMatch(/SPARQL/);

    const idxUsage = await page.evaluate(() => WORKSPACE_TOUR_STEPS.findIndex((s) => /Usage report/.test(s.title)));
    await page.evaluate((i) => tourGoto(i), idxUsage);
    await page.waitForSelector("#modalRoot .modal");
    expect(await page.textContent("#modalRoot .modal-head h2")).toBe("Usage report");
    await page.evaluate(() => tourEnd());
  });

  test("the SPARQL console's own 'Refresh list' button shows no error toast in mock mode either", async ({ page }) => {
    await page.evaluate(() => openSparqlConsole());
    await page.waitForSelector("#sqText");
    await page.click("#sqRefresh");
    await page.waitForTimeout(60);
    const errorToasts = await page.$$eval("#toasts .toast.error", (els) => els.length);
    expect(errorToasts).toBe(0);
    await A.modalCancel(page);
  });
});

/* Code-review findings (this same pass): the predicate-completeness flag was
   first written backwards -- a predicate CONFIRMED to have more rows than
   shown stopped offering "show more" and dropped its "+", while one
   CONFIRMED complete kept both forever. Three independent review angles
   caught it; these tests pin the fixed behavior down by overriding
   Data.ask() itself for just the "load more <predicate>" query these
   buttons trigger — mock mode's own local answers can never actually
   report "there's more than what's loaded" (the whole store IS the answer
   in that mode), and switching the whole session to State.mode="live" to
   get a controllable backend drags in every OTHER live-mode-only query
   this app sends (permission checks, the bulk concept load, etc.) with no
   way to answer any of them, which just hangs the test instead of
   testing anything. Overriding Data.ask() only for this one query, and
   delegating every other call to the real Data.ask() unchanged, tests the
   fix without disturbing anything else. */
test.describe("Windowed mode: per-predicate completeness is tracked correctly, not inverted", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a predicate the server confirms has more never loses its + or its show-more control", async ({ page }) => {
    const pred = "http://example.org/vocab#huge";
    await page.evaluate(({ c, pred }) => {
      const g = currentGraph();
      State.store.add(g, iri(c), iri(pred), lit("v0", null, null));
      State.load.mode = "windowed";
      State.load.truncated.add(c);
      const realAsk = Data.ask.bind(Data);
      // A server that always has at least as many rows as the LIMIT asked for.
      Data.ask = (sparql, why, local) => (why || "").startsWith("load more " + pred)
        ? Promise.resolve({ results: { bindings: Array.from(
            { length: Number((sparql.match(/LIMIT (\d+)/) || [])[1] || 0) },
            (_, i) => ({ o: { type: "literal", value: "v" + i } })) } })
        : realAsk(sparql, why, local);
    }, { c: FORESTS, pred });
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    // "Show 50 more", not "Show all" -- the mock returns exactly one row past
    // whatever LIMIT it's asked for, so asking for 100,000 would render
    // 100,001 real <tr> elements into the page for no reason this test needs.
    await page.click(`[data-growtriple="out"][data-growpred="${pred}"][data-growwant="51"]`);
    await page.waitForTimeout(80);
    const complete = await page.evaluate((k) => State.load.predComplete.has(k), `${FORESTS} out ${pred}`);
    expect(complete).toBe(false);
    expect(await page.$(`[data-growtriple="out"][data-growpred="${pred}"]`)).not.toBeNull();
    const countText = await page.evaluate((p) => {
      const btn = document.querySelector(`[data-growpred="${p}"]`);
      return btn?.closest("div[style*='margin-bottom']")?.querySelector(".pill")?.textContent;
    }, pred);
    expect(countText).toMatch(/\+$/);
  });

  test("a predicate the server confirms is complete stops showing + and its show-more control", async ({ page }) => {
    const pred = "http://example.org/vocab#small";
    await page.evaluate(({ c, pred }) => {
      const g = currentGraph();
      State.store.add(g, iri(c), iri(pred), lit("only-one", null, null));
      State.load.mode = "windowed";
      State.load.truncated.add(c);
      const realAsk = Data.ask.bind(Data);
      // A server that only ever has the one row this concept already carries.
      Data.ask = (sparql, why, local) => (why || "").startsWith("load more " + pred)
        ? Promise.resolve({ results: { bindings: [{ o: { type: "literal", value: "only-one" } }] } })
        : realAsk(sparql, why, local);
    }, { c: FORESTS, pred });
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    await page.click(`[data-growtriple="out"][data-growpred="${pred}"][data-growwant="100000"]`);
    await page.waitForTimeout(80);
    const complete = await page.evaluate((k) => State.load.predComplete.has(k), `${FORESTS} out ${pred}`);
    expect(complete).toBe(true);
    expect(await page.$(`[data-growtriple="out"][data-growpred="${pred}"]`)).toBeNull();
  });

  test("a truncated subject's Triples tab discloses that a whole property might not be loaded at all", async ({ page }) => {
    await page.evaluate((c) => { State.load.mode = "windowed"; State.load.truncated.add(c); }, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    expect(await page.textContent("#tabbody")).toContain("more statements than fit in one load");
  });
});

/* Code-review finding (this same pass): the Discussion "go to" handler set
   the scheme/class tab field directly but never the matching *Touched flag
   the rest of this pass's viewClass()/viewScheme() fix depends on -- so the
   jump worked once, then silently reverted to Metadata the next time
   anything refreshed that same scheme/class's view. */
test.describe("Discussion 'go to' keeps a scheme's Discussion tab sticky afterward", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("jumping to a scheme's discussion thread sets schemeTabTouched, not just schemeTab", async ({ page }) => {
    const scheme = await page.evaluate(() => schemeIri());
    await page.evaluate((s) => Discussion.start({ concept: s, text: "About this vocabulary" }), scheme);
    await page.evaluate(() => openDiscussions());
    await A.waitModal(page, "Discussions");
    await page.click(`[data-dgo="${scheme}"]`);
    await page.waitForTimeout(60);
    expect(await page.evaluate(() => State.schemeTab)).toBe("discussion");
    expect(await page.evaluate(() => State.schemeTabTouched)).toBe(true);

    // The exact refresh a successful edit's own goToSubject() performs on
    // the scheme it just touched -- must not bounce back to Metadata.
    await page.evaluate((s) => { viewScheme(s); renderDetail(); }, scheme);
    expect(await page.evaluate(() => State.schemeTab)).toBe("discussion");
  });
});
