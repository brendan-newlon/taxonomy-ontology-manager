const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const FORESTS = A.sdg("forests");
const ORCID = "https://example.org/ns/agents#orcid";

/**
 * Editing the properties this app has no dedicated section for.
 *
 * They were shown and not editable, which is fine for a curiosity and wrong
 * for a vocabulary where a large share of the concepts are people and
 * institutions whose identifiers live in exactly these statements. Fixing a
 * wrong ORCID or a wrong country code meant leaving the app.
 *
 * This used to be a "Other properties" section on the Metadata tab. That
 * section is gone (seventh feedback pass) — the Triples tab shows every
 * first-degree statement unconditionally now (see manageTabFor(),
 * CLAUDE.md's "never misrepresent the data"), so it's the only place left
 * that offers this same +Add/edit/delete affordance, and these tests moved
 * with it rather than being duplicated.
 */
test.describe("Other properties", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await A.reveal(page, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
  });

  const rows = (page) => page.$$eval("#tabbody [data-deltripleout]", (e) => e.length);
  const values = (page) => page.evaluate((c) =>
    State.store.match(currentGraph(), iri(c), iri("https://example.org/ns/agents#orcid"), null)
      .map((q) => `${q.o.v}${q.o.lang ? "@" + q.o.lang : ""}`), FORESTS);

  const addProp = async (page, { prop, value, kind, lang }) => {
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    await page.fill("#mProp", prop);
    await page.fill("#mPropVal", value);
    if (kind) await page.selectOption("#mPropKind", kind);
    if (lang !== undefined) await page.fill("#mPropLang", lang);
    await A.modalOk(page);
  };

  test("a property can be added, and shows up in the section that lists them", async ({ page }) => {
    const before = await rows(page);
    await addProp(page, { prop: ORCID, value: "0000-0002-1825-0097", lang: "" });
    expect(await values(page)).toEqual(["0000-0002-1825-0097"]);
    await A.selectTab(page, "triples");
    expect(await rows(page)).toBe(before + 1);
    expect(await page.textContent("#tabbody")).toContain("0000-0002-1825-0097");
  });

  test("changing one replaces the old statement rather than adding a second", async ({ page }) => {
    await addProp(page, { prop: ORCID, value: "0000-0002-1825-0097", lang: "" });
    await A.selectTab(page, "triples");
    const i = await page.evaluate((p) => TRIPLES_OUT.findIndex((q) => q.p.v === p), ORCID);
    await page.click(`#tabbody [data-edittripleout="${i}"]`);
    await A.waitModal(page, "Change this value");
    await page.fill("#mPropVal", "0000-0001-5109-3700");
    await A.modalOk(page);
    expect(await values(page)).toEqual(["0000-0001-5109-3700"]);
  });

  test("removing one takes exactly that statement away", async ({ page }) => {
    await addProp(page, { prop: ORCID, value: "0000-0002-1825-0097", lang: "" });
    await A.selectTab(page, "triples");
    const before = await rows(page);
    const i = await page.evaluate((p) => TRIPLES_OUT.findIndex((q) => q.p.v === p), ORCID);
    await page.click(`#tabbody [data-deltripleout="${i}"]`);
    await A.waitModal(page, "Remove this statement?");
    await A.modalOk(page);
    expect(await values(page)).toEqual([]);
    await A.selectTab(page, "triples");
    expect(await rows(page)).toBe(before - 1);
  });

  test("a value can be a link to something else rather than text", async ({ page }) => {
    await addProp(page, { prop: ORCID, value: "https://orcid.org/0000-0002-1825-0097", kind: "iri" });
    const o = await page.evaluate((c) =>
      State.store.match(currentGraph(), iri(c), iri("https://example.org/ns/agents#orcid"), null)[0].o,
      FORESTS);
    expect(o.t).toBe("iri");
    expect(o.lang).toBeFalsy();
  });

  test("a language is optional, and kept when given", async ({ page }) => {
    await addProp(page, { prop: ORCID, value: "Bosques tropicales", lang: "es" });
    expect(await values(page)).toEqual(["Bosques tropicales@es"]);
  });

  test("a property that already has its own editor is refused", async ({ page }) => {
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    await page.fill("#mProp", "http://www.w3.org/2004/02/skos/core#prefLabel");
    await page.fill("#mPropVal", "A second label editor");
    await page.click("#mOk");
    await page.waitForTimeout(80);
    expect(await page.$("#modalRoot .modal")).not.toBeNull();      // still open — nothing was written
    expect(await A.toasts(page)).toMatch(/own place in this app/i);
  });

  test("something that is not a URI is refused as a property", async ({ page }) => {
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    await page.fill("#mProp", "just some words");
    await page.fill("#mPropVal", "x");
    await page.click("#mOk");
    await page.waitForTimeout(80);
    expect(await page.$("#modalRoot .modal")).not.toBeNull();
    expect(await A.toasts(page)).toMatch(/not a URI/i);
  });

  test("the button is off until there is something to write", async ({ page }) => {
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    expect(await A.okDisabled(page)).toBe(true);
    await page.fill("#mProp", ORCID);
    expect(await A.okDisabled(page)).toBe(true);
    await page.fill("#mPropVal", "0000-0002-1825-0097");
    expect(await A.okDisabled(page)).toBe(false);
  });

  test("the picker offers the properties this vocabulary already uses", async ({ page }) => {
    await addProp(page, { prop: ORCID, value: "0000-0002-1825-0097", lang: "" });
    await A.selectTab(page, "triples");
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    await page.fill("#mProp", "orcid");
    await page.waitForTimeout(80);
    expect(await page.textContent("#mProp_list")).toContain("orcid");
  });

  test("the change is written as one guarded transaction, with its audit event", async ({ page }) => {
    const at = await page.evaluate(() => State.log.length);
    await addProp(page, { prop: ORCID, value: "0000-0002-1825-0097", lang: "" });
    const fresh = (await A.logs(page)).slice(at);
    expect(fresh.filter((e) => e.channel === "rdf").map((e) => e.code || "").join(" | "))
      .toContain("agents#orcid");
    expect(fresh.filter((e) => e.channel === "audit").map((e) => (e.msg || "") + (e.code || "")).join(" | "))
      .toMatch(/AddProperty/);
  });
});

test.describe("Other properties, without permission to write", () => {
  test("the buttons are not there at all", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await page.evaluate(() => { canEditHere = () => false; });
    await A.reveal(page, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    expect(await page.$("#btnAddTripleOut")).toBeNull();
    expect(await page.$("#tabbody [data-deltripleout]")).toBeNull();
  });
});
