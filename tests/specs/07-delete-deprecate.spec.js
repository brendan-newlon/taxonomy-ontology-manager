const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const SKOS = "http://www.w3.org/2004/02/skos/core#";
const MANGROVE = A.sdg("manglar");
const FORESTS = A.sdg("bosques");
const RAINFOREST = A.sdg("bosque-tropical-humedo");

const lifecycle = (page, c) => page.evaluate((x) => lifecycle(x), c);

test.describe("Deprecating and deleting (FR-1.5, FR-10.3)", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the Delete key on a selected concept opens the deprecate flow", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await page.focus("#tree");
    await page.keyboard.press("Delete");
    await A.waitModal(page, "Deprecate concept");
    expect(await A.modalText(page)).toMatch(/never deletes/i);
    await A.modalCancel(page);
  });

  test("the deprecate preview counts what will be affected", async ({ page }) => {
    await A.reveal(page, FORESTS);
    await A.rightClick(page, FORESTS);
    await A.clickMenu(page, "dep");
    await A.waitModal(page, "Deprecate concept");
    const txt = await A.modalText(page);
    expect(txt).toMatch(/Narrower concepts/);
    expect(txt).toMatch(/Incoming statements/);
    expect(txt).toMatch(/Mappings out/);
    await A.modalCancel(page);
  });

  test("a deprecated concept keeps its URI and stays in the tree, marked", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.rightClick(page, MANGROVE);
    await A.clickMenu(page, "dep");
    await A.waitModal(page, "Deprecate concept");
    await page.fill("#mWhy", "superseded by a broader term");
    await A.modalOk(page);

    expect(await lifecycle(page, MANGROVE)).toBe("deprecated");
    expect(await A.allConcepts(page)).toContain(MANGROVE);
    await A.reveal(page, MANGROVE);
    const row = await A.treeRow(page, MANGROVE);
    expect(row).toBeTruthy();
    expect(row.flags).toContain("dep");
    expect(await A.broaderOf(page, MANGROVE)).toEqual([FORESTS]);   // hierarchy untouched
  });

  test("deprecation records the rationale as an audit event", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.rightClick(page, MANGROVE);
    await A.clickMenu(page, "dep");
    await A.waitModal(page);
    await page.fill("#mWhy", "duplicate of Forests");
    await A.modalOk(page);
    const audit = (await A.logs(page, "audit")).map((e) => e.msg + " " + (e.code || "")).join("\n");
    expect(audit).toMatch(/DeprecateConcept/);
    expect(audit).toMatch(/duplicate of Forests/);
  });

  test("cancelling deprecation writes nothing", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    const before = await A.quadCount(page);
    await A.rightClick(page, MANGROVE);
    await A.clickMenu(page, "dep");
    await A.waitModal(page);
    await A.modalCancel(page);
    expect(await A.quadCount(page)).toBe(before);
    expect(await lifecycle(page, MANGROVE)).not.toBe("deprecated");
  });

  test("deleting a relation removes both directions and nothing else", async ({ page }) => {
    await A.reveal(page, RAINFOREST);
    await A.clickRow(page, RAINFOREST);
    await A.selectTab(page, "relations");
    const before = await A.quadCount(page);
    await A.removeRelation(page, "broader", FORESTS);

    expect(await A.broaderOf(page, RAINFOREST)).toEqual([]);
    expect(await A.narrowerOf(page, FORESTS)).not.toContain(RAINFOREST);
    /* Both directions go, and the concept that has just lost its last parent
       says it is a top concept -- which is how every other path in the app
       records one. Net: two statements out, one in. */
    const scheme = await page.evaluate(() => schemeIri());
    expect(await A.hasTriple(page, RAINFOREST, "skos:topConceptOf", scheme)).toBe(true);
    expect(await A.quadCount(page)).toBe(before - 1);
    expect(await A.allConcepts(page)).toContain(RAINFOREST);
    expect(await A.topConcepts(page)).toContain(RAINFOREST);
  });

  test("deleting a mapping removes only that mapping", async ({ page }) => {
    await A.reveal(page, RAINFOREST);
    await A.clickRow(page, RAINFOREST);
    await A.selectTab(page, "mappings");
    const target = "http://aims.fao.org/aos/agrovoc/c_7797";
    await page.click(`#tabbody [data-delmap="exactMatch"][data-t="${A.cssEscape(target)}"]`);
    await page.waitForTimeout(80);
    const t = await A.triplesOf(page, RAINFOREST);
    expect(t.some(([p, o]) => p === SKOS + "exactMatch" && o === target)).toBe(false);
    expect(t.some(([p]) => p === SKOS + "closeMatch")).toBe(true);
    expect((await A.logs(page, "audit")).map((e) => e.msg).join("\n")).toMatch(/RemoveMapping/);
  });

  test("deleting a note removes only that note", async ({ page }) => {
    await A.reveal(page, RAINFOREST);
    await A.clickRow(page, RAINFOREST);
    await A.selectTab(page, "notes");
    const scopeBefore = await page.evaluate((c) => noteValues(c, "scopeNote").length, RAINFOREST);
    const defBefore = await page.evaluate((c) => noteValues(c, "definition").length, RAINFOREST);
    expect(scopeBefore).toBeGreaterThan(0);
    await page.click('#tabbody [data-delnote="scopeNote"]');
    await page.waitForTimeout(80);
    expect(await page.evaluate((c) => noteValues(c, "scopeNote").length, RAINFOREST)).toBe(scopeBefore - 1);
    expect(await page.evaluate((c) => noteValues(c, "definition").length, RAINFOREST)).toBe(defBefore);
  });
});
