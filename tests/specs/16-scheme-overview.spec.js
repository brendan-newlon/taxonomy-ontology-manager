const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const MANGROVE = A.sdg("mangrove");

const onOverview = (page) => page.evaluate(() =>
  State.selected === null && !!document.querySelector("#tabbody .ov"));
const crumbs = (page) =>
  page.$$eval("#detailHead .crumbs .cr", (els) => els.map((e) => ({
    text: e.textContent.trim(), home: e.classList.contains("home"),
    current: e.classList.contains("cur"), crumb: e.dataset.crumb || null
  })));

/**
 * The overview is what the centre pane holds with nothing selected: how big
 * the vocabulary is, what its branches are, and what to do first. Selecting a
 * concept replaces it, so there has to be a way back — it was reachable only
 * through a breadcrumb styled exactly like the ancestors beside it, which for
 * a top concept was a single dim word with nothing either side of it.
 */
test.describe("Getting back to the scheme overview", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the workspace opens on it", async ({ page }) => {
    expect(await onOverview(page)).toBe(true);
    const body = await page.textContent("#tabbody");
    expect(body).toMatch(/concepts/);
    expect(body).toMatch(/Start here/i);
  });

  test("the trail reads as a trail, ending in the concept itself", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    const c = await crumbs(page);
    expect(c[0].home).toBe(true);
    expect(c[0].crumb).toBe("__scheme");
    expect(c[c.length - 1].current).toBe(true);
    expect(c[c.length - 1].crumb).toBe(null);          // where you are is not a link
    expect(c.length).toBeGreaterThan(1);
  });

  test("a top concept has the same way back", async ({ page }) => {
    const top = (await A.treeRoots(page))[0].iri;
    await A.clickRow(page, top);
    const c = await crumbs(page);
    expect(c.map((x) => x.home)).toContain(true);
    expect(c.length).toBe(2);                          // scheme > this concept
  });

  test("clicking the scheme crumb goes back to it", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    expect(await onOverview(page)).toBe(false);
    await page.click('#detailHead .crumbs [data-crumb="__scheme"]');
    expect(await onOverview(page)).toBe(true);
  });

  test("Escape goes back to it too", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await page.keyboard.press("Escape");
    expect(await onOverview(page)).toBe(true);
  });

  test("Escape clears a search before it leaves the concept", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await page.fill("#qSearch", "mang");
    await page.waitForTimeout(250);
    await page.keyboard.press("Escape");
    expect(await page.inputValue("#qSearch")).toBe("");
    expect(await onOverview(page)).toBe(false);        // still on the concept
    await page.keyboard.press("Escape");
    expect(await onOverview(page)).toBe(true);
  });

  test("the way back survives a scheme with nothing above the concept", async ({ page }) => {
    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Standalone term", broader: null });
    await page.click('#detailHead .crumbs [data-crumb="__scheme"]');
    expect(await onOverview(page)).toBe(true);
  });

  test("Escape while typing in a field does not throw the user out", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "labels");
    const input = '#tabbody [data-edit][data-kind="prefLabel"]';
    await page.click(input);
    await page.keyboard.press("Escape");
    expect(await onOverview(page)).toBe(false);
  });
});
