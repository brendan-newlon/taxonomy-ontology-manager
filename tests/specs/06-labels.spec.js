const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const FORESTS = A.sdg("bosques");
const AQUIFER = A.sdg("acuifero");

const labelsOf = (page, c, kind) => page.evaluate(
  ([x, k]) => xlLabels(x, k).map((r) => r.lang + ":" + r.text), [c, kind]);

test.describe("Labels and languages (FR-3)", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a translation is a second label on the same concept, never a second concept", async ({ page }) => {
    const before = (await A.allConcepts(page)).length;
    await A.reveal(page, AQUIFER);
    await A.clickRow(page, AQUIFER);
    await A.selectTab(page, "labels");
    await page.click('#tabbody [data-addlabel="prefLabel"]');
    await A.waitModal(page, "Add prefLabel");
    await A.pick(page, "mLang", "fr — French");
    await page.fill("#mText", "Aquifère");
    await A.modalOk(page);

    expect(await labelsOf(page, AQUIFER, "prefLabel")).toContain("fr:Aquifère");
    expect((await A.allConcepts(page)).length).toBe(before);
  });

  test("the tree re-labels itself when the display language changes", async ({ page }) => {
    await A.reveal(page, FORESTS);
    expect((await A.treeRow(page, FORESTS)).label).toContain("Forests");
    await page.click("#selLang");
    await page.click('.menu [data-k="es"]');
    await page.waitForTimeout(80);
    expect((await A.treeRow(page, FORESTS)).label).toContain("Bosques");
  });

  test("an alternative label is added without touching the preferred one", async ({ page }) => {
    await A.reveal(page, AQUIFER);
    await A.clickRow(page, AQUIFER);
    await A.selectTab(page, "labels");
    const prefBefore = await labelsOf(page, AQUIFER, "prefLabel");
    await page.click('#tabbody [data-addlabel="altLabel"]');
    await A.waitModal(page, "Add altLabel");
    await page.fill("#mText", "Groundwater body");
    await A.modalOk(page);

    expect(await labelsOf(page, AQUIFER, "altLabel")).toContain("en:Groundwater body");
    expect(await labelsOf(page, AQUIFER, "prefLabel")).toEqual(prefBefore);
  });

  test("deleting a label removes both the XL resource and the plain shortcut", async ({ page }) => {
    await A.reveal(page, AQUIFER);
    await A.clickRow(page, AQUIFER);
    await A.selectTab(page, "labels");
    await page.click('#tabbody [data-addlabel="altLabel"]');
    await A.waitModal(page, "Add altLabel");
    await page.fill("#mText", "Temporary alt");
    await A.modalOk(page);

    const li = await page.evaluate(
      (c) => xlLabels(c, "altLabel").find((x) => x.text === "Temporary alt").labelIri, AQUIFER);
    await page.click(`#tabbody [data-dellabel="${A.cssEscape(li)}"]`);
    await page.waitForTimeout(80);

    expect(await labelsOf(page, AQUIFER, "altLabel")).not.toContain("en:Temporary alt");
    const plain = await A.triplesOf(page, AQUIFER);
    expect(plain.some(([, o]) => o === "Temporary alt@en")).toBe(false);
    expect(await A.triplesOf(page, li)).toHaveLength(0);
  });

  test("a second preferred label in a language that already has one is reported, not silently kept", async ({ page }) => {
    await A.reveal(page, AQUIFER);
    await A.clickRow(page, AQUIFER);
    await A.selectTab(page, "labels");
    await page.click('#tabbody [data-addlabel="prefLabel"]');
    await A.waitModal(page, "Add prefLabel");
    await page.fill("#mText", "Second English preferred label");
    await A.modalOk(page);

    // the dialog asks before allowing it …
    expect((await page.evaluate(() => window.__confirms)).join(" ")).toMatch(/already has a preferred label/i);
    // … and validation records it
    const found = await A.issues(page);
    expect(found.some((i) => i.concept === AQUIFER && /preferred label|uniqueLang|one per language/i.test(i.text))).toBe(true);
  });

  test("adding a label logs an action and an audit event", async ({ page }) => {
    await A.reveal(page, AQUIFER);
    await A.clickRow(page, AQUIFER);
    await A.selectTab(page, "labels");
    await page.click('#tabbody [data-addlabel="altLabel"]');
    await A.waitModal(page);
    await page.fill("#mText", "Logged alt");
    await A.modalOk(page);
    expect((await A.logs(page, "audit")).map((e) => e.msg).join("\n")).toMatch(/AddLabel/);
  });

  test("renaming never changes the URI", async ({ page }) => {
    await A.reveal(page, FORESTS);
    await A.clickRow(page, FORESTS);
    await page.keyboard.press("F2");
    await page.waitForSelector("#tree input.rename");
    await page.fill("#tree input.rename", "Completely different name");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(80);
    expect(await A.allConcepts(page)).toContain(FORESTS);
    expect(await A.selected(page)).toBe(FORESTS);
  });
});
