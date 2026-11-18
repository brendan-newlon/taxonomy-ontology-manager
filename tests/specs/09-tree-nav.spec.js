const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const NATURAL = A.sdg("natural-resources");
const FORESTS = A.sdg("forests");
const MANGROVE = A.sdg("mangrove");
const RAINFOREST = A.sdg("tropical-rainforest");
const EROSION = A.sdg("soil-erosion");

test.describe("Tree navigation and discovery", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("expand-all then collapse-all is a strict latch", async ({ page }) => {
    await page.click("#btnExpandAll");
    await page.waitForTimeout(60);
    expect(await A.treeHas(page, MANGROVE)).toBe(true);

    await page.click("#btnExpandAll");
    await page.waitForTimeout(60);
    const rows = await A.treeRows(page);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });

  test("clicking a twist opens exactly one level", async ({ page }) => {
    await page.click("#btnExpandAll");
    await page.click("#btnExpandAll");            // everything closed
    await A.toggle(page, NATURAL);
    expect(await A.treeHas(page, FORESTS)).toBe(true);
    expect(await A.treeHas(page, MANGROVE)).toBe(false);
  });

  test("arrow keys move the selection and open or close a branch", async ({ page }) => {
    if (await A.isExpanded(page, NATURAL)) await A.toggle(page, NATURAL);
    await A.clickRow(page, NATURAL);
    await page.focus("#tree");

    await page.keyboard.press("ArrowRight");      // open
    await page.waitForTimeout(40);
    expect(await A.isExpanded(page, NATURAL)).toBe(true);

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(40);
    const rows = await A.treeRows(page);
    const i = rows.findIndex((r) => r.iri === NATURAL);
    expect(await A.selected(page)).toBe(rows[i + 1].iri);

    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(40);
    expect(await A.selected(page)).toBe(NATURAL);

    await page.keyboard.press("ArrowLeft");       // close
    await page.waitForTimeout(40);
    expect(await A.isExpanded(page, NATURAL)).toBe(false);
  });

  test("ArrowLeft on a closed concept goes to its parent", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await page.focus("#tree");
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(40);
    expect(await A.selected(page)).toBe(FORESTS);
  });

  test("selecting a concept from elsewhere reveals it in the tree", async ({ page }) => {
    // everything closed: the concept's row does not exist yet
    await page.click("#btnExpandAll");
    await page.click("#btnExpandAll");
    expect(await A.treeHas(page, RAINFOREST)).toBe(false);

    await page.evaluate((c) => selectConcept(c), RAINFOREST);
    await page.waitForTimeout(60);

    expect(await A.treeHas(page, RAINFOREST)).toBe(true);
    expect(await A.isExpanded(page, FORESTS)).toBe(true);
    expect(await A.isExpanded(page, NATURAL)).toBe(true);
    expect((await A.treeRow(page, RAINFOREST)).selected).toBe(true);
  });

  test("a search hit jumps to the concept and reveals it", async ({ page }) => {
    await page.click("#btnExpandAll");
    await page.click("#btnExpandAll");
    await page.fill("#qSearch", "Mangrove");
    await page.waitForTimeout(200);
    // search results replace the tree's contents; the hit is a row like any other
    await page.click(`#tree .trow[data-c="${A.cssEscape(MANGROVE)}"]`);
    await page.waitForTimeout(80);
    expect(await A.selected(page)).toBe(MANGROVE);
    expect(await A.treeHas(page, MANGROVE)).toBe(true);
  });

  test("a broader/narrower cycle is flagged and does not hang the tree", async ({ page }) => {
    // the demo data deliberately contains one: soil erosion ↔ land degradation
    const cyc = await page.evaluate(() => [...conceptsInCycle()]);
    expect(cyc.length).toBeGreaterThan(0);
    await A.reveal(page, EROSION);
    const row = await A.treeRow(page, EROSION);
    expect(row).toBeTruthy();
    expect(row.flags).toContain("cycle");
    // and the renderer terminated — we got here
    expect((await A.treeRows(page)).length).toBeGreaterThan(0);
  });

  test("a concept with no children renders as a leaf, one with children as an expander", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    expect((await A.treeRow(page, MANGROVE)).leaf).toBe(true);
    expect((await A.treeRow(page, FORESTS)).leaf).toBe(false);
  });

  test("a new child turns its parent from a leaf into an expander", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    expect((await A.treeRow(page, MANGROVE)).leaf).toBe(true);
    await A.rightClick(page, MANGROVE);
    await A.clickMenu(page, "child");
    await A.fillNewConcept(page, { label: "Red mangrove" });
    await A.reveal(page, MANGROVE);
    expect((await A.treeRow(page, MANGROVE)).leaf).toBe(false);
  });
});
