const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const SKOS = "http://www.w3.org/2004/02/skos/core#";

/**
 * "Load as you browse" over a vocabulary large enough to need it.
 *
 * The demo data is deliberately small, so until now nothing in the suite could
 * reach this strategy at all — TESTING §5 listed two of its bugs as untestable
 * for exactly that reason. Both are asserted here.
 *
 * The vocabulary is built to shape rather than borrowed: 600 top concepts (so
 * the 500-row page has something past it), 40 of them with children (so a
 * branch has to be fetched when it is opened), and one chain four deep.
 */
const BIG = { roots: 600, branches: 12, perBranch: 8, depth: 4 };
const ns = A.EX + "big/concept/";
const root = (n) => `${ns}root-${String(n).padStart(4, "0")}`;
const kid = (n, k) => `${root(n)}-kid-${String(k).padStart(4, "0")}`;

async function bootBig(page) {
  await A.boot(page, { scheme: "plant-conservation" });
  const scheme = await page.evaluate(() => schemeIri());
  const { text } = A.bigSchemeTriples({ ...BIG, scheme });
  await A.importText(page, text, "ntriples");
  await A.useWindowedLoading(page);
}

test.describe("Load as you browse", () => {
  test.slow();
  test.beforeEach(async ({ page }) => { await bootBig(page); });

  test("the tree opens from a skeleton, one page of roots at a time", async ({ page }) => {
    const L = await A.loadState(page);
    expect(L.windowed).toBe(true);
    expect(L.tops).toBe(500);              // one page, not all 600+
    expect(L.rootsTruncated).toBe(true);
    expect(L.rootTotal).toBeGreaterThanOrEqual(600);
    // and the count in the pane head is the scheme's, not what happens to be read
    expect(await page.textContent("#treeCount")).toContain(L.concepts.toLocaleString());
  });

  test("a page that stops short says what it is a page of", async ({ page }) => {
    const notice = await page.textContent("#tree");
    expect(notice.replace(/\s+/g, " ")).toMatch(/Showing 500 of [\d,]+ top concepts/);
    await page.click("#btnMoreRoots");
    await page.waitForFunction(() => !document.getElementById("btnMoreRoots"), null, { timeout: 20_000 });
    const L = await A.loadState(page);
    expect(L.tops).toBe(L.rootTotal);
    expect(L.rootsTruncated).toBe(false);
  });

  test("a branch is read when it is opened, not before", async ({ page }) => {
    /* The first level of every root comes with the skeleton -- that is the
       point of the pre-load -- so the branch that proves this is a level
       below it, where nothing has been fetched. */
    const parent = kid(0, 0);
    await A.toggle(page, root(0));
    expect((await A.loadState(page)).childrenOf).not.toContain(parent);
    expect((await A.treeRow(page, parent)).leaf).toBe(false);   // a twist, without having fetched
    await A.toggle(page, parent);
    await page.waitForFunction((x) => State.load.childrenOf.has(x), parent, { timeout: 20_000 });
    expect((await A.treeChildren(page, parent)).map((k) => k.iri)).toEqual([ns + "deep-1"]);
  });

  test("a windowed read logs the same SPARQL as any other", async ({ page }) => {
    const rdf = (await A.logs(page)).filter((e) => e.channel === "rdf").map((e) => e.code || "").join(" | ");
    expect(rdf).toMatch(/SELECT \?c \(COUNT\(DISTINCT \?kid\) AS \?kids\)/);
    expect(rdf).toMatch(/LIMIT 500 OFFSET 0/);
  });

  test("selecting a concept fills the detail pane", async ({ page }) => {
    await A.clickRow(page, root(3));
    await page.waitForFunction((c) => State.load.detail.has(c), root(3), { timeout: 20_000 });
    expect(await page.textContent("#detailHead")).toMatch(/Root 0003/);
  });

  test("search reaches a concept no branch has opened", async ({ page }) => {
    await page.fill("#qSearch", "Kid 0005.0003");
    await page.waitForTimeout(600);
    const rows = await A.treeRows(page);
    expect(rows.map((r) => r.iri)).toContain(kid(5, 3));
  });
});

/**
 * The two bugs TESTING §5 recorded as out of reach. Both are the same shape:
 * the skeleton is a snapshot of the server's answer, and an edit made after it
 * was read has to be allowed to contradict it — otherwise the edit is accepted,
 * written, and then invisible, which reads as data loss.
 */
test.describe("An edit is allowed to contradict the skeleton", () => {
  test.slow();
  test.beforeEach(async ({ page }) => { await bootBig(page); });

  test("a concept made a top concept here shows up without reopening", async ({ page }) => {
    const c = kid(0, 0);
    const scheme = await page.evaluate(() => schemeIri());
    await A.toggle(page, root(0));
    await A.clickRow(page, c);
    await A.selectTab(page, "relations");
    // taking away its only parent is what makes it a top concept
    await A.removeRelation(page, "broader", root(0));
    expect(await A.hasTriple(page, c, "skos:topConceptOf", scheme)).toBe(true);
    expect(await A.topConcepts(page)).toContain(c);
    expect(await A.treeHas(page, c)).toBe(true);
  });

  test("a child added under a leaf gives it a way to be opened", async ({ page }) => {
    const leaf = root(100);            // one of the childless roots: count 0 in the skeleton
    expect((await A.treeRow(page, leaf)).leaf).toBe(true);

    await A.rightClick(page, leaf);
    await A.clickMenu(page, "child");
    await A.fillNewConcept(page, { label: "Added here" });
    const fresh = await A.conceptByLabel(page, "Added here");
    expect(await A.broaderOf(page, fresh)).toContain(leaf);

    expect(await page.evaluate((x) => Data.hasChildren(x), leaf)).toBe(true);
    expect((await A.treeRow(page, leaf)).leaf).toBe(false);
    expect((await A.treeChildren(page, leaf)).map((r) => r.iri)).toContain(fresh);
  });
});

/**
 * Windowed loading used to be live-only, which meant a strategy with two known
 * bugs had no test that could run at all. It answers from the store when there
 * is no server — same functions, same query strings, same rows.
 */
test.describe("The strategy runs the same code with or without a server", () => {
  test("the roots the store answers with are the roots the query asks for", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const full = await A.topConcepts(page);
    await A.useWindowedLoading(page);
    const windowed = await A.topConcepts(page);
    expect(new Set(windowed)).toEqual(new Set(full));
  });

  test("switching back to keeping it all open does not lose the vocabulary", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const before = await A.allConcepts(page);
    await A.useWindowedLoading(page);
    await page.evaluate(async () => { State.load.pref = "full"; await reopenCurrentScheme(); });
    await page.waitForSelector("#tree .trow");
    expect(new Set(await A.allConcepts(page))).toEqual(new Set(before));
  });
});

/**
 * A filter that runs over the loaded window and reports its answer as the
 * vocabulary's is worse than no filter: "1,204 terms have no definition" reads
 * as a fact about the vocabulary whichever part of it happens to be in memory.
 * Windowed mode asks the whole graph instead.
 *
 * Every assertion here is against the same filter run in `full` mode, where
 * the store holds everything and the in-memory answer is the true one. That
 * keeps the tests about the invariant — the two modes agree — rather than
 * about how many demo concepts happen to carry a definition.
 */
test.describe("Filtering asks the vocabulary, not the window", () => {
  test.slow();

  const setFilter = (page, mode, prop) => page.evaluate((x) => {
    State.treeFilter = { mode: x.mode, prop: x.prop, lang: State.lang };
    _subtreeCache.clear();
    renderTreeFilterBar(); renderTree();
  }, { mode, prop });

  const settle = async (page) => {
    await page.waitForFunction(() => !State.filterScan.running && !!State.filterScan.key);
    await page.waitForTimeout(80);
  };

  /** How many concepts match, answered while the whole graph is in memory. */
  const truthFor = async (page, mode, prop) => {
    await setFilter(page, mode, prop);
    return page.evaluate(() => allConcepts().filter(matchesTreeFilter).length);
  };

  /* With no server the store *is* the whole vocabulary, so the gap between
     what is held and what exists cannot be staged offline — see TESTING §5.
     What is asserted here is the thing that closes it: windowed mode asks a
     counting query and reports its answer, instead of counting what it holds.
     The number has to agree with the same filter run over the whole graph. */
  test("the count comes from asking the vocabulary, and agrees with the whole truth", async ({ page }) => {
    await bootBig(page);
    await page.evaluate(async () => { State.load.pref = "full"; await reopenCurrentScheme(); });
    const truth = await truthFor(page, "missing", "def");
    await setFilter(page, "all", "def");

    await A.useWindowedLoading(page);
    const at = await page.evaluate(() => State.log.length);
    await setFilter(page, "missing", "def");
    await settle(page);

    const scan = await page.evaluate(() => ({ total: State.filterScan.total, read: State.filterScan.iris.length }));
    expect(scan.total).toBe(truth);
    expect(scan.read).toBeLessThan(scan.total);           // a page of it, not all of it

    // it asked, rather than counting the window
    const why = (await A.logs(page)).slice(at).map((e) => e.msg || "").join(" | ");
    expect(why).toMatch(/how many/);

    const bar = (await page.textContent("#treeFilterBar")).replace(/\s+/g, " ");
    expect(bar).toContain(`${truth.toLocaleString()} of`);
  });

  test("the results are a list of terms, paged, and say what they are a page of", async ({ page }) => {
    await bootBig(page);
    await setFilter(page, "missing", "def");
    await settle(page);
    const total = await page.evaluate(() => State.filterScan.total);
    expect(total).toBeGreaterThan(500);                   // there is a second page to ask for

    expect(await page.$$eval("#tree .trow", (e) => e.length)).toBe(500);
    expect((await page.textContent("#tree")).replace(/\s+/g, " ")).toMatch(/Showing 500 of [\d,]+/);

    await page.click("#btnMoreFiltered");
    await settle(page);
    expect(await page.$$eval("#tree .trow", (e) => e.length)).toBe(Math.min(1000, total));
  });

  test("a filter nothing matches says so instead of showing an unfiltered tree", async ({ page }) => {
    await bootBig(page);
    // built to be empty: no generated or demo concept is typed with this class
    await page.evaluate(() => {
      State.treeFilter = { mode: "has", prop: "class", lang: State.lang };
      TREE_FILTER_PROPS.find((x) => x.key === "class").sparql = () => `?c a <urn:test:nothing-is-this>`;
      TREE_FILTER_PROPS.find((x) => x.key === "class").scan = () => false;
      _subtreeCache.clear(); renderTreeFilterBar(); renderTree();
    });
    await settle(page);
    expect(await page.evaluate(() => State.filterScan.total)).toBe(0);
    expect(await page.$$eval("#tree .trow", (e) => e.length)).toBe(0);
    expect(await page.textContent("#tree")).toMatch(/No term has a class/);
  });

  test("a result row opens the term it names", async ({ page }) => {
    await bootBig(page);
    await setFilter(page, "missing", "def");
    await settle(page);
    const first = await page.$eval("#tree .trow", (e) => e.dataset.c);
    await page.click(`#tree [data-c="${A.cssEscape(first)}"]`);
    await page.waitForTimeout(150);
    expect(await A.selected(page)).toBe(first);
  });

  test("the query it sends is the one the console shows", async ({ page }) => {
    await bootBig(page);
    const at = await page.evaluate(() => State.log.length);
    await setFilter(page, "missing", "map");
    await settle(page);
    const rdf = (await A.logs(page)).slice(at).filter((e) => e.channel === "rdf")
      .map((e) => e.code || "").join(" | ");
    expect(rdf).toContain("FILTER NOT EXISTS");
    expect(rdf).toContain("skos:exactMatch");
    expect(rdf).toMatch(/ORDER BY \?l \?c/);
  });

  test("clearing the filter puts the hierarchy back", async ({ page }) => {
    await bootBig(page);
    const before = await A.treeRoots(page);
    await setFilter(page, "missing", "def");
    await settle(page);
    await setFilter(page, "all", "def");
    expect(await A.treeRoots(page)).toEqual(before);
  });
});
