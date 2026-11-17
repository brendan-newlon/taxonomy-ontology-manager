const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const SKOS = "http://www.w3.org/2004/02/skos/core#";
const XL = "http://www.w3.org/2008/05/skos-xl#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const DCT = "http://purl.org/dc/terms/";

/** The concept the app just created, asserted to exist — a null here is the failure, not a skipped check. */
async function created(page, text) {
  const c = await A.conceptByLabel(page, text);
  expect(c, `no concept was created with the label "${text}"`).toBeTruthy();
  return c;
}

test.describe("Creating concepts (FR-1.3)", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the + button with nothing selected creates a visible top concept", async ({ page }) => {
    expect(await A.selected(page)).toBeNull();
    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Blue economy" });

    const c = await created(page, "Blue economy");
    expect(await A.broaderOf(page, c)).toEqual([]);
    expect(await A.topConcepts(page)).toContain(c);

    // the whole point: the user can see it
    expect(await A.treeHas(page, c)).toBe(true);
    expect((await A.treeRow(page, c)).depth).toBe(0);
  });

  test("the + button with a concept selected pre-fills that concept as broader", async ({ page }) => {
    await A.clickRow(page, A.sdg("recursos-naturales"));
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New concept");
    expect(await A.pickerValue(page, "mBroader")).toBe(A.sdg("recursos-naturales"));
    await page.fill("#mText", "Mineral resources");
    await A.modalOk(page);

    const c = await created(page, "Mineral resources");
    expect(await A.broaderOf(page, c)).toEqual([A.sdg("recursos-naturales")]);
    expect(await A.treeHas(page, c)).toBe(true);
  });

  test("right-click → New narrower concept puts the child under that concept, visibly", async ({ page }) => {
    const parent = A.sdg("agua-dulce");          // Freshwater
    // start from a collapsed parent — the child still has to end up on screen
    if (await A.isExpanded(page, parent)) await A.toggle(page, parent);

    await A.rightClick(page, parent);
    await A.clickMenu(page, "child");
    await A.fillNewConcept(page, { label: "Groundwater recharge" });

    const c = await created(page, "Groundwater recharge");
    expect(await A.broaderOf(page, c)).toEqual([parent]);
    expect(await A.narrowerOf(page, parent)).toContain(c);

    expect(await A.isExpanded(page, parent)).toBe(true);
    expect(await A.treeHas(page, c)).toBe(true);
    expect((await A.treeChildren(page, parent)).map((r) => r.iri)).toContain(c);
    expect(await A.selected(page)).toBe(c);
  });

  test("right-click → New sibling concept shares the parent", async ({ page }) => {
    const sib = A.sdg("manglar");                 // Mangrove, child of Forests
    await A.reveal(page, sib);
    await A.rightClick(page, sib);
    await A.clickMenu(page, "sib");
    await A.fillNewConcept(page, { label: "Cloud forest" });

    const c = await created(page, "Cloud forest");
    expect(await A.broaderOf(page, c)).toEqual([A.sdg("bosques")]);
    expect(await A.treeHas(page, c)).toBe(true);
  });

  test("a new sibling of a top concept is itself a top concept", async ({ page }) => {
    await A.rightClick(page, A.sdg("recursos-naturales"));
    await A.clickMenu(page, "sib");
    await A.fillNewConcept(page, { label: "Ocean governance" });

    const c = await created(page, "Ocean governance");
    expect(await A.broaderOf(page, c)).toEqual([]);
    expect((await A.treeRow(page, c)).depth).toBe(0);
  });

  test("clearing the pre-filled broader picker produces a top concept", async ({ page }) => {
    await A.rightClick(page, A.sdg("agua-dulce"));
    await A.clickMenu(page, "child");
    await A.fillNewConcept(page, { label: "Standalone term", broader: null });

    const c = await created(page, "Standalone term");
    expect(await A.broaderOf(page, c)).toEqual([]);
    expect((await A.treeRow(page, c)).depth).toBe(0);
  });

  test("a created concept carries the full set of triples, and exactly one placement", async ({ page }) => {
    await A.clickRow(page, A.sdg("bosques"));
    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Riparian forest" });

    const c = await created(page, "Riparian forest");
    const t = await A.triplesOf(page, c);
    const preds = t.map(([p]) => p);
    expect(preds).toContain(RDF + "type");
    expect(preds).toContain(SKOS + "inScheme");
    expect(preds).toContain(SKOS + "prefLabel");
    expect(preds).toContain(XL + "prefLabel");
    expect(preds).toContain(DCT + "created");
    expect(preds).toContain(SKOS + "broader");
    // a concept under a parent must not also claim to be a top concept
    expect(preds).not.toContain(SKOS + "topConceptOf");
    expect(await A.narrowerOf(page, A.sdg("bosques"))).toContain(c);
  });

  test("a top concept declares topConceptOf and has no broader", async ({ page }) => {
    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Circular economy hub" });
    const c = await created(page, "Circular economy hub");
    const preds = (await A.triplesOf(page, c)).map(([p]) => p);
    expect(preds).toContain(SKOS + "topConceptOf");
    expect(preds).not.toContain(SKOS + "broader");
  });

  test("an empty label leaves the create button disabled", async ({ page }) => {
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New concept");
    expect(await A.okDisabled(page)).toBe(true);
    await page.fill("#mText", "Something");
    expect(await A.okDisabled(page)).toBe(false);
    await page.fill("#mText", "  ");
    expect(await A.okDisabled(page)).toBe(true);
  });

  test("a label that mints an existing URI is refused, and nothing is written", async ({ page }) => {
    const before = await A.quadCount(page);
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New concept");
    await page.fill("#mText", "Bosques");           // slugifies onto the existing concept
    await A.modalOk(page);
    expect((await A.alerts(page)).join(" ")).toMatch(/collision|already/i);
    expect(await A.modalOpen(page)).toBe(true);     // the dialog stays open to be corrected
    await A.modalCancel(page);
    expect(await A.quadCount(page)).toBe(before);
  });

  test("cancelling the dialog writes nothing", async ({ page }) => {
    const before = await A.quadCount(page);
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New concept");
    await page.fill("#mText", "Never created");
    await A.modalCancel(page);
    expect(await A.quadCount(page)).toBe(before);
    expect(await A.conceptByLabel(page, "Never created")).toBeNull();
  });

  test("creating a concept logs an action, the SPARQL, and an audit event", async ({ page }) => {
    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Logged term" });
    const acts = (await A.logs(page, "action")).map((e) => e.msg).join("\n");
    const rdf = (await A.logs(page, "rdf")).map((e) => e.msg + " " + (e.code || "")).join("\n");
    const audit = (await A.logs(page, "audit")).map((e) => e.msg + " " + (e.code || "")).join("\n");
    expect(acts).toMatch(/Create concept "Logged term"/);
    expect(rdf).toMatch(/INSERT/);
    expect(audit).toMatch(/CreateConcept/);
  });

  test("adding a concept does not make the other roots disappear", async ({ page }) => {
    const rootsBefore = (await A.treeRoots(page)).map((r) => r.iri).sort();
    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Extra root" });
    const c = await created(page, "Extra root");
    const rootsAfter = (await A.treeRoots(page)).map((r) => r.iri).sort();
    expect(rootsAfter).toEqual(expect.arrayContaining(rootsBefore));
    expect(rootsAfter).toContain(c);
  });

  test("the same holds in the large imported-shaped scheme", async ({ page }) => {
    await A.switchScheme(page, "subject-facet");
    const rootsBefore = (await A.treeRoots(page)).length;
    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Zzz brand new subject" });
    const c = await created(page, "Zzz brand new subject");
    expect(await A.topConcepts(page)).toContain(c);
    expect(await A.treeRoots(page)).toHaveLength(rootsBefore + 1);
    expect(await A.treeHas(page, c)).toBe(true);
  });
});
