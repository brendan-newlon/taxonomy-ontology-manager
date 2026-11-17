const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const SKOS = "http://www.w3.org/2004/02/skos/core#";

const MANGROVE = A.sdg("manglar");
const FORESTS = A.sdg("bosques");
const FRESHWATER = A.sdg("agua-dulce");
const AGRI = A.sdg("agricultura-sostenible");
const WATERSHED = A.sdg("cuenca-hidrografica");

test.describe("Broader / narrower / related (FR-2.1, FR-2.2)", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("Add broader from the Relations tab moves the concept, visibly", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "relations");
    await A.addRelation(page, "broader");
    await A.pick(page, "mTarget", "Sustainable agriculture");
    await A.modalOk(page);

    expect(await A.broaderOf(page, MANGROVE)).toEqual(expect.arrayContaining([AGRI]));
    expect(await A.narrowerOf(page, AGRI)).toContain(MANGROVE);
    expect(await A.treeHas(page, MANGROVE)).toBe(true);
  });

  test("Add narrower makes the target a child, and opens the branch so it shows", async ({ page }) => {
    await A.clickRow(page, AGRI);
    if (await A.isExpanded(page, AGRI)) await A.toggle(page, AGRI);
    await A.selectTab(page, "relations");
    await A.addRelation(page, "narrower");
    await A.pick(page, "mTarget", "Watershed");
    await A.modalOk(page);

    expect(await A.narrowerOf(page, AGRI)).toContain(WATERSHED);
    expect(await A.broaderOf(page, WATERSHED)).toContain(AGRI);
    expect(await A.isExpanded(page, AGRI)).toBe(true);
    expect((await A.treeChildren(page, AGRI)).map((r) => r.iri)).toContain(WATERSHED);
  });

  test("Add related writes both directions and changes no hierarchy", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    const upsBefore = await A.broaderOf(page, MANGROVE);
    await A.selectTab(page, "relations");
    await A.addRelation(page, "related");
    await A.pick(page, "mTarget", "Watershed");
    await A.modalOk(page);

    expect(await A.relatedOf(page, MANGROVE)).toContain(WATERSHED);
    expect(await A.relatedOf(page, WATERSHED)).toContain(MANGROVE);
    expect(await A.broaderOf(page, MANGROVE)).toEqual(upsBefore);
  });

  test("removing the only broader returns the concept to the tree's roots", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "relations");
    await A.removeRelation(page, "broader", FORESTS);

    expect(await A.broaderOf(page, MANGROVE)).toEqual([]);
    expect(await A.narrowerOf(page, FORESTS)).not.toContain(MANGROVE);
    expect(await A.topConcepts(page)).toContain(MANGROVE);
    expect((await A.treeRoots(page)).map((r) => r.iri)).toContain(MANGROVE);
  });

  test("removing one of two parents leaves the other path intact", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.dragDrop(page, MANGROVE, FRESHWATER, { ctrl: true });
    await A.waitModal(page);
    await A.modalOk(page);
    expect(await A.broaderOf(page, MANGROVE)).toHaveLength(2);

    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "relations");
    await A.removeRelation(page, "broader", FRESHWATER);

    expect(await A.broaderOf(page, MANGROVE)).toEqual([FORESTS]);
    await A.reveal(page, MANGROVE);
    expect((await A.treeRow(page, MANGROVE)).flags).not.toContain("poly");
    expect(await A.treeHas(page, MANGROVE)).toBe(true);
  });

  test("polyhierarchy is flagged and the breadcrumb offers every path", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.dragDrop(page, MANGROVE, FRESHWATER, { ctrl: true });
    await A.waitModal(page);
    await A.modalOk(page);
    await A.reveal(page, MANGROVE);
    expect((await A.treeRow(page, MANGROVE)).flagText).toContain("2 parents");

    await A.clickRow(page, MANGROVE);
    const paths = await page.evaluate((c) => pathsTo(c).length, MANGROVE);
    expect(paths).toBe(2);
    expect(await page.textContent("#detailHead")).toMatch(/other path/i);
  });

  test("a relation added from the tab and one added by drag write the same triples", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.dragDrop(page, MANGROVE, AGRI);
    await A.waitModal(page);
    await A.modalOk(page);
    const byDrag = (await A.triplesOf(page, MANGROVE))
      .filter(([p]) => p === SKOS + "broader").map(([, o]) => o);

    await page.reload();
    await A.boot(page, { scheme: "plant-conservation" });
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "relations");
    await A.removeRelation(page, "broader", FORESTS);
    await A.addRelation(page, "broader");
    await A.pick(page, "mTarget", "Sustainable agriculture");
    await A.modalOk(page);
    const byTab = (await A.triplesOf(page, MANGROVE))
      .filter(([p]) => p === SKOS + "broader").map(([, o]) => o);

    expect(byTab).toEqual(byDrag);
  });

  test("adding a broader concept drops topConceptOf", async ({ page }) => {
    await A.clickRow(page, AGRI);
    expect((await A.triplesOf(page, AGRI)).map(([p]) => p)).toContain(SKOS + "topConceptOf");
    await A.selectTab(page, "relations");
    await A.addRelation(page, "broader");
    await A.pick(page, "mTarget", "Natural resources");
    await A.modalOk(page);
    expect((await A.triplesOf(page, AGRI)).map(([p]) => p)).not.toContain(SKOS + "topConceptOf");
  });

  test("the relation dialog will not commit with no target chosen", async ({ page }) => {
    await A.clickRow(page, AGRI);
    await A.selectTab(page, "relations");
    await A.addRelation(page, "broader");
    expect(await A.okDisabled(page)).toBe(true);
    await A.modalCancel(page);
  });

  test("removing a relation logs an audit event and writes both directions away", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "relations");
    await A.removeRelation(page, "broader", FORESTS);
    const audit = (await A.logs(page, "audit")).map((e) => e.msg + " " + (e.code || "")).join("\n");
    expect(audit).toMatch(/RemoveRelation/);
    const forests = await A.triplesOf(page, FORESTS);
    expect(forests.some(([p, o]) => p === SKOS + "narrower" && o === MANGROVE)).toBe(false);
  });
});
