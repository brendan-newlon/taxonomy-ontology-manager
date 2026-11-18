const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const SKOS = "http://www.w3.org/2004/02/skos/core#";
const XL = "http://www.w3.org/2008/05/skos-xl#";
const EX = "https://taxonomy.example.org/id/imported/";
const AUTHOR = EX + "author-1";
const MANGROVE = A.sdg("mangrove");

/**
 * Shaped like the reference export, which has **no SKOS-XL at all** — 67,587
 * plain `skos:prefLabel` and zero `skosxl:*` (DATASET §3). This is the ordinary
 * case for imported data, not an edge case.
 */
const PLAIN = [
  `<${AUTHOR}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${SKOS}Concept> .`,
  `<${AUTHOR}> <${SKOS}prefLabel> "Castilleja Vargas, Liliana"@en .`,
  `<${AUTHOR}> <${SKOS}prefLabel> "Castilleja Vargas, Liliana"@es .`,
  `<${AUTHOR}> <${SKOS}altLabel> "Castilleja, L."@en .`
].join("\n");

const prefInput = '#tabbody [data-kind="prefLabel"][data-edit^="plain:en"]';
const labelRows = (page, kind) =>
  page.$$eval(`#tabbody [data-edit][data-kind="${kind}"]`, (els) => els.map((e) => e.value));

async function openLabels(page, c) {
  await A.clickRow(page, c);
  await A.selectTab(page, "labels");
}

test.describe("Labels on plain-SKOS data (no SKOS-XL)", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await A.importText(page, PLAIN, "ntriples");
  });

  test("an imported concept's labels are visible, not 'None'", async ({ page }) => {
    await openLabels(page, AUTHOR);
    expect(await labelRows(page, "prefLabel")).toEqual(
      expect.arrayContaining(["Castilleja Vargas, Liliana"]));
    expect(await labelRows(page, "altLabel")).toEqual(["Castilleja, L."]);
    // the tree was already showing this label; the tab must agree with it
    expect(await page.evaluate((c) => labelText(c).plain, AUTHOR)).toBe("Castilleja Vargas, Liliana");
  });

  test("the translation matrix counts a plain label as coverage, not a gap", async ({ page }) => {
    await openLabels(page, AUTHOR);
    const body = await page.textContent("#tabbody");
    // en and es are present; a language with nothing is still reported as a gap
    expect(body).toMatch(/Castilleja Vargas, Liliana/);
    const gaps = await page.$$eval("#tabbody tr.gap td.lg", (els) => els.map((e) => e.textContent.trim()));
    expect(gaps.join(" ")).not.toMatch(/English|Spanish/);
  });

  test("editing a plain label rewrites that triple, and mints no XL resource", async ({ page }) => {
    await openLabels(page, AUTHOR);
    await page.fill(prefInput, "Castilleja Vargas, L.");
    await page.locator(prefInput).blur();
    await page.waitForTimeout(150);

    const triples = await A.triplesOf(page, AUTHOR);
    expect(triples).toContainEqual([SKOS + "prefLabel", "Castilleja Vargas, L.@en"]);
    expect(triples).not.toContainEqual([SKOS + "prefLabel", "Castilleja Vargas, Liliana@en"]);
    // converting a vocabulary to SKOS-XL is a decision, not a side effect of a rename
    expect(triples.some(([p]) => p.startsWith(XL))).toBe(false);
    // and the change is visible where the user is looking
    expect(await page.evaluate((c) => labelText(c).plain, AUTHOR)).toBe("Castilleja Vargas, L.");
  });

  test("deleting a plain alternative label removes it", async ({ page }) => {
    await openLabels(page, AUTHOR);
    await page.click('#tabbody [data-dellabel^="plain:"][data-kind="altLabel"]');
    await page.waitForTimeout(150);
    expect((await A.triplesOf(page, AUTHOR)).some(([p]) => p === SKOS + "altLabel")).toBe(false);
    await openLabels(page, AUTHOR);
    expect(await labelRows(page, "altLabel")).toEqual([]);
  });

  test("the last preferred label is protected here too", async ({ page }) => {
    // delete one of the two, then try the survivor
    await openLabels(page, AUTHOR);
    await page.click('#tabbody [data-dellabel^="plain:es"][data-kind="prefLabel"]');
    await page.waitForTimeout(150);
    await A.clearAlerts(page);

    await openLabels(page, AUTHOR);
    await page.click('#tabbody [data-dellabel^="plain:"][data-kind="prefLabel"]');
    await page.waitForTimeout(150);
    expect((await A.alerts(page)).join(" ")).toMatch(/at least one preferred label/i);
    expect((await A.triplesOf(page, AUTHOR)).filter(([p]) => p === SKOS + "prefLabel")).toHaveLength(1);
  });

  test("retagging a plain label moves the tag, not the concept", async ({ page }) => {
    await openLabels(page, AUTHOR);
    await page.click('#tabbody [data-retag^="plain:en"][data-kind="altLabel"]');
    await A.waitModal(page, "Change label language");
    await A.pick(page, "mLang", "Portuguese");
    await A.modalOk(page);

    const triples = await A.triplesOf(page, AUTHOR);
    expect(triples).toContainEqual([SKOS + "altLabel", "Castilleja, L.@pt"]);
    expect(triples).not.toContainEqual([SKOS + "altLabel", "Castilleja, L.@en"]);
    expect(await A.allConcepts(page)).toContain(AUTHOR);   // still one concept
  });

  test("a plain edit speaks on the rdf and audit channels", async ({ page }) => {
    await openLabels(page, AUTHOR);
    const at = await page.evaluate(() => State.log.length);
    await page.fill(prefInput, "Vargas, Liliana C.");
    await page.locator(prefInput).blur();
    await page.waitForTimeout(150);

    const fresh = (await A.logs(page)).slice(at);
    expect(fresh.filter((e) => e.channel === "audit")
      .map((e) => e.msg + " " + (e.code || "")).join("\n")).toMatch(/EditPrefLabel/);
    // mutations render predicates as full IRIs, not curies
    const rdf = fresh.filter((e) => e.channel === "rdf").map((e) => e.code || "").join("\n");
    expect(rdf).toContain(`<${SKOS}prefLabel>`);
    expect(rdf).toContain("Vargas, Liliana C.");
  });
});

test.describe("Labels where SKOS-XL is present", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a label carried by both XL and the plain shortcut is listed once", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await openLabels(page, MANGROVE);
    const rows = await labelRows(page, "prefLabel");
    expect(new Set(rows).size).toBe(rows.length);
    // the demo data is SKOS-XL with the plain shortcut materialised alongside
    const triples = await A.triplesOf(page, MANGROVE);
    expect(triples.some(([p]) => p === XL + "prefLabel")).toBe(true);
    expect(triples.filter(([p]) => p === SKOS + "prefLabel").length).toBe(rows.length);
  });

  test("a concept created in the app still round-trips through the tab", async ({ page }) => {
    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Coastal defence" });
    const c = await A.conceptByLabel(page, "Coastal defence");
    await openLabels(page, c);
    expect(await labelRows(page, "prefLabel")).toEqual(["Coastal defence"]);
  });

  test("a plain-only label alongside XL ones shows as well, not instead", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    // arrives the way a partial import does: one language never converted to XL
    await page.evaluate((c) => {
      State.store.add(currentGraph(), iri(c), P("skos:prefLabel"), lit("Palude di mangrovie", "it"));
    }, MANGROVE);
    await openLabels(page, MANGROVE);
    const rows = await labelRows(page, "prefLabel");
    expect(rows).toContain("Palude di mangrovie");
    expect(rows).toContain("Mangrove");
  });
});
