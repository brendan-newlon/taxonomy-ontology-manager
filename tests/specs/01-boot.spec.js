const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

test.describe("Boot and orientation", () => {
  test("Sample data opens a workspace with a rendered tree", async ({ page }) => {
    await A.boot(page);
    await expect(page.locator("#app")).toHaveClass(/ready/);
    await expect(page.locator("#connect")).toBeHidden();
    const rows = await A.treeRows(page);
    expect(rows.length).toBeGreaterThan(0);
    expect(page.__errors).toEqual([]);
  });

  test("the tree's count is the number of concepts in the open scheme", async ({ page }) => {
    await A.boot(page);
    const shown = await page.textContent("#treeCount");
    const n = (await A.allConcepts(page)).length;
    expect(shown.replace(/[^0-9]/g, "")).toBe(String(n));
  });

  test("switching scheme re-renders the tree", async ({ page }) => {
    await A.boot(page);
    const before = (await A.treeRows(page)).map((r) => r.iri);
    await A.switchScheme(page, "plant-conservation");
    const after = (await A.treeRows(page)).map((r) => r.iri);
    expect(after).not.toEqual(before);
    expect(after.every((i) => !i || i.includes("plant-conservation"))).toBe(true);
  });

  test("the small demo scheme has the hierarchy the fixtures describe", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    expect(await A.broaderOf(page, A.sdg("bosques"))).toEqual([A.sdg("recursos-naturales")]);
    const kids = await A.narrowerOf(page, A.sdg("bosques"));
    expect(kids).toEqual(expect.arrayContaining([
      A.sdg("bosque-tropical-humedo"), A.sdg("bosque-seco-tropical"), A.sdg("manglar")
    ]));
  });
});
