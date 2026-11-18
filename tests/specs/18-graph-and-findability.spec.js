const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");


const FORESTS = A.sdg("forests");
const RAINFOREST = A.sdg("tropical-rainforest");

const gnodes = (page) => page.$$eval("#tabbody .gnode", (els) => els.map((e) => ({
  iri: e.dataset.gnode || e.dataset.gcls || null,
  text: (e.querySelector("text")?.textContent || "").trim(),
  me: e.classList.contains("gn-me"),
  lane: ["gn-broader", "gn-narrower", "gn-rel", "gn-cls", "gn-map"].find((c) => e.classList.contains(c)) || null
})));

/**
 * First-level context, drawn. Deliberately one step: a whole-vocabulary graph
 * of 17,066 terms is a hairball, and what a person wants when looking at a
 * term is what sits around it.
 */
test.describe("The graph of what is around a concept", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await A.reveal(page, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "graph");
  });

  test("the concept is at the centre and its neighbours are around it", async ({ page }) => {
    const n = await gnodes(page);
    expect(n.find((x) => x.me).text).toContain("Forests");
    const iris = n.map((x) => x.iri);
    expect(iris).toContain(A.sdg("natural-resources"));   // its parent
    expect(iris).toContain(RAINFOREST);                    // one of its children
    expect(n.filter((x) => x.lane === "gn-broader" || x.lane === "gn-narrower").length).toBeGreaterThan(1);
  });

  test("every drawn node has a line to the centre", async ({ page }) => {
    const spokes = (await gnodes(page)).filter((x) => !x.me).length;
    expect(await page.$$eval("#tabbody .graph line.ge", (e) => e.length)).toBe(spokes);
  });

  test("clicking a neighbour re-centres on it, without leaving the graph", async ({ page }) => {
    await page.click(`#tabbody [data-gnode="${A.cssEscape(RAINFOREST)}"]`);
    await page.waitForTimeout(150);
    expect(await A.selected(page)).toBe(RAINFOREST);
    expect((await gnodes(page)).find((x) => x.me).text).toContain("Tropical rainforest");
    expect(await page.$("#tabbody .graph")).not.toBeNull();
  });

  test("a class is drawn as its own kind of link, and goes to that class", async ({ page }) => {
    const CLS = "https://schema.org/Person";
    await page.evaluate((x) => {
      State.store.add(currentGraph(), iri(x.c), P("rdf:type"), iri(x.cls));
      renderDetail();
    }, { c: FORESTS, cls: CLS });
    expect((await gnodes(page)).find((x) => x.iri === CLS).lane).toBe("gn-cls");
    await page.click(`#tabbody [data-gcls="${A.cssEscape(CLS)}"]`);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => State.treeMode)).toBe("classes");
  });

  test("a mapping is drawn, and is not something to click through to", async ({ page }) => {
    await A.reveal(page, RAINFOREST);
    await A.clickRow(page, RAINFOREST);          // the mapped one in this fixture
    await A.selectTab(page, "graph");
    const maps = (await gnodes(page)).filter((x) => x.lane === "gn-map");
    expect(maps.length).toBeGreaterThan(0);
    expect(maps.every((m) => m.iri === null)).toBe(true);   // external — nothing here to open
  });

  test("a lane with more than it can draw says how many it left out", async ({ page }) => {
    await page.evaluate((parent) => {
      for (let i = 0; i < 12; i++) {
        const c = `https://taxonomy.example.org/id/imported/kid-${i}`;
        State.store.add(currentGraph(), iri(c), P("rdf:type"), P("skos:Concept"));
        State.store.add(currentGraph(), iri(c), P("skos:prefLabel"), lit("Kid " + i, "en"));
        State.store.add(currentGraph(), iri(c), P("skos:broader"), iri(parent));
      }
      renderDetail();
    }, FORESTS);
    const body = (await page.textContent("#tabbody")).replace(/\s+/g, " ");
    expect(body).toMatch(/Narrower: showing 6 of \d+/);
    expect(await page.$$eval("#tabbody .gnode.gn-narrower", (e) => e.length)).toBeLessThan(20);
  });

  test("a concept with nothing around it says so rather than drawing an empty box", async ({ page }) => {
    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Quite alone", broader: null });
    await A.selectTab(page, "graph");
    expect(await page.textContent("#tabbody")).toMatch(/Nothing links to this concept yet/);
    expect(await page.$("#tabbody .graph")).toBeNull();
  });
});

/**
 * "Which terms have no definition / no mapping / no class" is the question a
 * taxonomist asks before a work session. This filter used to answer it for
 * exactly one thing: a preferred label in one language.
 */
test.describe("Finding terms by what they do and do not have", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await page.evaluate(() => { State.ui.filterOpen = true; renderTreeFilterBar(); });
  });

  const setFilter = (page, mode, prop) => page.evaluate((x) => {
    State.treeFilter = { mode: x.mode, prop: x.prop, lang: State.lang };
    _subtreeCache.clear();
    renderTreeFilterBar(); renderTree();
  }, { mode, prop });

  const matching = (page) => page.evaluate(() => allConcepts().filter(matchesTreeFilter));

  test("the filter offers every kind of thing a term can carry", async ({ page }) => {
    const opts = await page.$$eval("#treeFilterExtra #lfProp option", (e) => e.map((o) => o.value));
    expect(opts).toEqual(expect.arrayContaining(
      ["pref", "alt", "def", "note", "broader", "narrower", "rel", "map", "class", "collection"]));
  });

  test("has and missing are exact complements, for every property", async ({ page }) => {
    const all = (await A.allConcepts(page)).length;
    for (const prop of ["def", "map", "rel", "class", "collection", "alt", "broader"]) {
      await setFilter(page, "has", prop);
      const has = (await matching(page)).length;
      await setFilter(page, "missing", prop);
      const missing = (await matching(page)).length;
      expect(has + missing, `${prop}: ${has} + ${missing} is not ${all}`).toBe(all);
    }
  });

  test("missing a definition finds the terms that have none", async ({ page }) => {
    await setFilter(page, "missing", "def");
    const found = await matching(page);
    expect(found.length).toBeGreaterThan(0);
    for (const c of found.slice(0, 25)) {
      expect(await page.evaluate((x) => noteValues(x, "definition").length, c)).toBe(0);
    }
    expect(found).not.toContain(FORESTS);           // Forests has one
  });

  test("having a mapping finds only the mapped terms", async ({ page }) => {
    await setFilter(page, "has", "map");
    const found = await matching(page);
    expect(found).toContain(RAINFOREST);
    for (const c of found) {
      expect(await page.evaluate((x) => mappingsOf(x).length, c)).toBeGreaterThan(0);
    }
  });

  test("the tree really narrows, and the count says by how much", async ({ page }) => {
    const before = (await A.treeRows(page)).length;
    await setFilter(page, "has", "map");
    expect((await A.treeRows(page)).length).toBeLessThan(before);
    expect(await page.textContent("#treeFilterBar")).toMatch(/\d+ of \d+/);
  });

  test("filtering says what it asked, on both channels", async ({ page }) => {
    const at = await page.evaluate(() => State.log.length);
    await page.evaluate(() => {
      State.treeFilter = { mode: "missing", prop: "map", lang: State.lang };
      _subtreeCache.clear(); logTreeFilter();
    });
    const fresh = (await A.logs(page)).slice(at);
    expect(fresh.filter((e) => e.channel === "action").map((e) => e.msg).join("\n"))
      .toMatch(/mapping to another vocabulary/i);
    const rdf = fresh.filter((e) => e.channel === "rdf").map((e) => e.code || "").join("\n");
    expect(rdf).toContain("FILTER NOT EXISTS");
    expect(rdf).toContain("skos:exactMatch");
  });

  test("the language case still works, and only it shows a language picker", async ({ page }) => {
    await setFilter(page, "missing", "pref");
    expect(await page.$("#treeFilterExtra #lfLang")).not.toBeNull();
    await setFilter(page, "missing", "def");
    expect(await page.$("#treeFilterExtra #lfLang")).toBeNull();
  });
});

/**
 * One vocabulary per graph. An imported export brings its source's own scheme
 * declarations along, and treating each of those as a vocabulary of this
 * database named one user's vocabulary after whichever source scheme sorted
 * first — and pointed every skos:topConceptOf the app wrote at that scheme.
 */
test.describe("What counts as a vocabulary in a database", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  const discover = (page, rows) => page.evaluate(async (bindings) => {
    const real = Backend.query;
    Backend.query = async () => ({ results: { bindings } });
    try { return await discoverLiveSchemes(); } finally { Backend.query = real; }
  }, rows);

  const b = (g, scheme, label) => ({
    g: { type: "uri", value: g }, scheme: { type: "uri", value: scheme },
    ...(label ? { label: { type: "literal", value: label, "xml:lang": "en" } } : {})
  });
  const OURS = "urn:taxonomy:scheme:acme:draft";
  const MINE = "https://taxonomy.example.org/id/acme/scheme";

  test("source schemes inside our graph do not become vocabularies of their own", async ({ page }) => {
    const found = await discover(page, [
      b(OURS, "http://vendor.example/thesauri/Operation-Type", "Operation Type"),
      b(OURS, "http://vendor.example/thesauri/IdBAuthors", "IdBAuthors"),
      b(OURS, MINE, "Acme terms")
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe("acme");
    expect(found[0].iri).toBe(MINE);                       // ours, not whichever sorted first
    expect(found[0].titles.en).toBe("Acme terms");
    expect(found[0].sources.map((x) => x.titles.en).sort())
      .toEqual(["IdBAuthors", "Operation Type"]);
  });

  test("draft and published are the same vocabulary, not two", async ({ page }) => {
    const found = await discover(page, [
      b(OURS, MINE, "Acme terms"),
      b("urn:taxonomy:scheme:acme:published", MINE, "Acme terms")
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].graphs.draft).toBe(OURS);
    expect(found[0].graphs.published).toBe("urn:taxonomy:scheme:acme:published");
  });

  test("with no declaration of ours, a single source scheme is the identity", async ({ page }) => {
    const found = await discover(page, [b(OURS, "http://vendor.example/t/Only", "Only one")]);
    expect(found[0].iri).toBe("http://vendor.example/t/Only");
    expect(found[0].titles.en).toBe("Only one");
    expect(found[0].sources).toEqual([]);
  });

  test("with several and none of ours, it does not pick one at random", async ({ page }) => {
    const found = await discover(page, [
      b(OURS, "http://vendor.example/t/A", "A"),
      b(OURS, "http://vendor.example/t/B", "B")
    ]);
    expect(found[0].iri).toBe(MINE);                       // what the app writes against
    expect(found[0].sources).toHaveLength(2);
  });

  test("graphs that are not ours are still one vocabulary each", async ({ page }) => {
    const found = await discover(page, [
      b("http://example.org/graph/one", "http://vendor.example/t/A", "A"),
      b("http://example.org/graph/one", "http://vendor.example/t/B", "B"),
      b("http://example.org/graph/two", "http://vendor.example/t/C", "C")
    ]);
    expect(found).toHaveLength(2);
  });
});
