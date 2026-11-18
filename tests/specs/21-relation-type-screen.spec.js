const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const MANGROVE = A.sdg("mangrove");
const FRESHWATER = A.sdg("freshwater");
const EXV = "https://example.org/vocab#";
const ISO = "http://purl.org/iso25964/skos-thes#";

/**
 * The screen for relation types.
 *
 * The registry, its writer and its reader had all existed for a while with
 * nothing calling them — a vocabulary could have its own predicates
 * discovered and never turned on, because there was no way for a person to
 * reach the function that would do it.
 */
const open = async (page) => {
  await page.evaluate(() => openRelationTypes());
  await A.waitModal(page, "Relation types");
};
const body = async (page) => (await page.textContent("#modalRoot .modal-body")).replace(/\s+/g, " ");

test.describe("Relation types", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("it is reachable from the menu", async ({ page }) => {
    await page.click("#btnMenu");
    await page.waitForSelector(".menu");
    expect(await page.textContent(".menu")).toContain("Relation types");
    await page.click('.menu [data-k="reltypes"]');
    await A.waitModal(page, "Relation types");
  });

  test("the SKOS three are listed as standard and cannot be dropped", async ({ page }) => {
    await open(page);
    const t = await body(page);
    expect(t).toContain("Broader");
    expect(t).toContain("Narrower");
    expect(t).toContain("Related");
    expect(await page.$$eval("#modalRoot [data-rtdrop]", (e) => e.length)).toBe(0);
  });

  test("it says how many links each type actually carries", async ({ page }) => {
    const n = await page.evaluate(() =>
      State.store.match(currentGraph(), null, P("skos:broader"), null).length);
    expect(n).toBeGreaterThan(0);
    await open(page);
    expect(await body(page)).toContain(n.toLocaleString());
  });

  test("a predicate in the data is offered, and listing it makes it a type", async ({ page }) => {
    await page.evaluate((x) => {
      State.store.add(currentGraph(), iri(x.a), iri(x.p), iri(x.b));
    }, { a: MANGROVE, b: FRESHWATER, p: EXV + "growsIn" });

    await open(page);
    expect(await body(page)).toContain("growsIn");
    await page.click(`#modalRoot [data-rtadd="${A.cssEscape(EXV + "growsIn")}"]`);
    await A.waitModal(page, "List this relation type");
    await page.fill("#mRtLabel", "Grows in");
    await A.modalOk(page);
    await page.waitForTimeout(120);

    const types = await A.relTypes(page);
    expect(types.map((t) => t.iri)).toContain(EXV + "growsIn");
    expect(types.find((t) => t.iri === EXV + "growsIn").label).toBe("Grows in");
  });

  test("the standard thesaurus relations go in as a pair, each naming the other", async ({ page }) => {
    await open(page);
    expect(await body(page)).toContain("Broader (generic)");
    await page.click('#modalRoot [data-rtcat="generic"]');
    await page.waitForTimeout(250);

    const types = await A.relTypes(page);
    const btg = types.find((t) => t.iri === ISO + "broaderGeneric");
    const ntg = types.find((t) => t.iri === ISO + "narrowerGeneric");
    expect(btg).toBeTruthy();
    expect(ntg).toBeTruthy();
    expect(btg.inverse).toBe(ISO + "narrowerGeneric");
    expect(ntg.inverse).toBe(ISO + "broaderGeneric");
    expect(btg.hierarchical).toBe(true);
  });

  test("a pair already listed is not offered again", async ({ page }) => {
    await open(page);
    await page.click('#modalRoot [data-rtcat="generic"]');
    await page.waitForTimeout(250);
    await open(page);
    expect(await page.$('#modalRoot [data-rtcat="generic"]')).toBeNull();
  });

  test("a type defined by hand is written with the shape that was chosen", async ({ page }) => {
    await page.evaluate(() => openNewRelationType({}));
    await A.waitModal(page, "Define a relation type");
    await page.fill("#mRtLabel", "Similar to");
    await page.fill("#mRtIri", EXV + "similarTo");
    await page.selectOption("#mRtShape", "symmetric");
    await A.modalOk(page);
    await page.waitForTimeout(200);

    const t = (await A.relTypes(page)).find((x) => x.iri === EXV + "similarTo");
    expect(t).toBeTruthy();
    expect(t.symmetric).toBe(true);
    expect(t.inverse).toBeFalsy();
  });

  test("a paired type writes both halves", async ({ page }) => {
    await page.evaluate(() => openNewRelationType({}));
    await A.waitModal(page, "Define a relation type");
    await page.fill("#mRtLabel", "Causes");
    await page.fill("#mRtIri", EXV + "causes");
    await page.selectOption("#mRtShape", "paired");
    await page.fill("#mRtInv", EXV + "causedBy");
    await A.modalOk(page);
    await page.waitForTimeout(250);

    const types = await A.relTypes(page);
    expect(types.find((t) => t.iri === EXV + "causes").inverse).toBe(EXV + "causedBy");
    expect(types.find((t) => t.iri === EXV + "causedBy").inverse).toBe(EXV + "causes");
  });

  test("the other direction only asks for a URI when the shape needs one", async ({ page }) => {
    await page.evaluate(() => openNewRelationType({}));
    await A.waitModal(page, "Define a relation type");
    expect(await page.$eval("#mRtInvRow", (e) => e.classList.contains("hidden"))).toBe(true);
    await page.selectOption("#mRtShape", "paired");
    expect(await page.$eval("#mRtInvRow", (e) => e.classList.contains("hidden"))).toBe(false);
  });

  test("something that is not a URI is refused", async ({ page }) => {
    await page.evaluate(() => openNewRelationType({}));
    await A.waitModal(page, "Define a relation type");
    await page.fill("#mRtLabel", "Nope");
    await page.fill("#mRtIri", "not a uri");
    await page.click("#mOk");
    await page.waitForTimeout(80);
    expect(await page.$("#modalRoot .modal")).not.toBeNull();
    expect(await A.toasts(page)).toMatch(/not a URI/i);
  });

  test("a type already listed cannot be listed twice", async ({ page }) => {
    await A.registerRelType(page, { iri: EXV + "causes", label: "Causes" });
    await page.evaluate(() => openNewRelationType({}));
    await A.waitModal(page, "Define a relation type");
    await page.fill("#mRtLabel", "Causes again");
    await page.fill("#mRtIri", EXV + "causes");
    await page.click("#mOk");
    await page.waitForTimeout(80);
    expect(await A.toasts(page)).toMatch(/already listed/i);
  });

  test("the button is off until the dialog can do something", async ({ page }) => {
    await page.evaluate(() => openNewRelationType({}));
    await A.waitModal(page, "Define a relation type");
    expect(await A.okDisabled(page)).toBe(true);
    await page.fill("#mRtLabel", "Causes");
    expect(await A.okDisabled(page)).toBe(true);
    await page.fill("#mRtIri", EXV + "causes");
    expect(await A.okDisabled(page)).toBe(false);
  });

  test("stopping listing a type leaves the relations themselves alone", async ({ page }) => {
    await A.registerRelType(page, { iri: EXV + "growsIn", label: "Grows in" });
    await page.evaluate((x) => {
      State.store.add(currentGraph(), iri(x.a), iri(x.p), iri(x.b));
    }, { a: MANGROVE, b: FRESHWATER, p: EXV + "growsIn" });

    await open(page);
    await page.click(`#modalRoot [data-rtdrop="${A.cssEscape(EXV + "growsIn")}"]`);
    await page.waitForTimeout(250);

    expect((await A.relTypes(page)).map((t) => t.iri)).not.toContain(EXV + "growsIn");
    expect(await page.evaluate((x) =>
      State.store.match(currentGraph(), iri(x.a), iri(x.p), iri(x.b)).length,
      { a: MANGROVE, b: FRESHWATER, p: EXV + "growsIn" })).toBe(1);
  });

  test("with no permission to write, it reads but offers nothing to change", async ({ page }) => {
    await page.evaluate(() => { canEditHere = () => false; });
    await open(page);
    expect(await body(page)).toContain("Broader");
    expect(await page.$("#modalRoot [data-rtcat]")).toBeNull();
    expect(await page.$("#btnRtNew")).toBeNull();
  });
});
