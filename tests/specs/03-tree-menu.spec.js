const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const FORESTS = A.sdg("bosques");
const NATURAL = A.sdg("recursos-naturales");
const MANGROVE = A.sdg("manglar");

test.describe("Right-click menu and inline rename (FR-2.4, FR-3)", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("right-clicking a row opens the menu and selects that row", async ({ page }) => {
    await A.rightClick(page, FORESTS);
    expect(await A.menuOpen(page)).toBe(true);
    expect(await A.selected(page)).toBe(FORESTS);
  });

  test("the menu carries the actions an editor needs", async ({ page }) => {
    await A.rightClick(page, FORESTS);
    const keys = await A.menuKeys(page);
    expect(keys).toEqual(expect.arrayContaining([
      "child", "sib", "rename", "translate", "broader",
      "merge", "split", "uri", "dep", "expand", "collapse", "copy"
    ]));
  });

  test("Expand whole branch opens every descendant, not just one level", async ({ page }) => {
    await A.rightClick(page, NATURAL);
    await A.clickMenu(page, "collapse");
    expect(await A.treeHas(page, MANGROVE)).toBe(false);

    await A.rightClick(page, NATURAL);
    await A.clickMenu(page, "expand");
    expect(await A.treeHas(page, FORESTS)).toBe(true);
    expect(await A.treeHas(page, MANGROVE)).toBe(true);   // two levels down
  });

  test("Collapse whole branch closes every descendant", async ({ page }) => {
    await A.rightClick(page, NATURAL);
    await A.clickMenu(page, "expand");
    await A.rightClick(page, NATURAL);
    await A.clickMenu(page, "collapse");
    expect(await A.isExpanded(page, NATURAL)).toBe(false);
    expect(await A.isExpanded(page, FORESTS)).toBe(false);
    expect(await A.treeHas(page, FORESTS)).toBe(false);
  });

  test("Copy URI copies the concept's URI and says so", async ({ page }) => {
    await A.rightClick(page, FORESTS);
    await A.clickMenu(page, "copy");
    expect(await page.evaluate(() => window.__clipboard)).toBe(FORESTS);
    expect((await A.logs(page, "action")).map((e) => e.msg).join("\n")).toMatch(/Copied URI/);
  });

  test("the menu closes on an outside click and leaves nothing behind", async ({ page }) => {
    await A.rightClick(page, FORESTS);
    await page.click("#treePaneTitle");
    await page.waitForTimeout(50);
    expect(await A.menuOpen(page)).toBe(false);
  });

  test("only one menu exists at a time", async ({ page }) => {
    await A.rightClick(page, FORESTS);
    await A.rightClick(page, NATURAL);
    expect(await page.$$eval(".menu.floating", (m) => m.length)).toBe(1);
  });

  test("inline rename updates the tree row and both label forms", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    await page.keyboard.press("F2");
    await page.waitForSelector("#tree input.rename");
    await page.fill("#tree input.rename", "Woodlands");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(80);

    expect((await A.treeRow(page, FORESTS)).label).toContain("Woodlands");
    const t = await A.triplesOf(page, FORESTS);
    expect(t.some(([p, o]) => p.endsWith("core#prefLabel") && o === "Woodlands@en")).toBe(true);
    const xl = await page.evaluate((c) => xlLabels(c, "prefLabel").find((x) => x.lang === "en").text, FORESTS);
    expect(xl).toBe("Woodlands");
  });

  test("Escape during an inline rename leaves the label alone", async ({ page }) => {
    await A.clickRow(page, FORESTS);
    await page.keyboard.press("F2");
    await page.waitForSelector("#tree input.rename");
    await page.fill("#tree input.rename", "Nope");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    expect((await A.treeRow(page, FORESTS)).label).toContain("Forests");
  });

  test("the rename menu item does the same thing as F2", async ({ page }) => {
    await A.rightClick(page, FORESTS);
    await A.clickMenu(page, "rename");
    await page.waitForSelector("#tree input.rename");
    await page.fill("#tree input.rename", "Renamed by menu");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(80);
    expect((await A.treeRow(page, FORESTS)).label).toContain("Renamed by menu");
  });
});
