const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const EX = "https://taxonomy.example.org/id/imported/";
const RENEW = EX + "renewable-energy";
const SOLAR = EX + "solar-power";
const WIND = EX + "wind-power";

/** A small, well-formed SKOS hierarchy: one root and two children. */
const TTL = `@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix ex:   <${EX}> .

ex:renewable-energy a skos:Concept ;
  skos:prefLabel "Renewable energy"@en .

ex:solar-power a skos:Concept ;
  skos:prefLabel "Solar power"@en ;
  skos:broader ex:renewable-energy .

ex:wind-power a skos:Concept ;
  skos:prefLabel "Wind power"@en ;
  skos:broader ex:renewable-energy .
`;

test.describe("Import (FR-12)", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("Turtle lands in the tree with its hierarchy intact", async ({ page }) => {
    const before = (await A.allConcepts(page)).length;
    await A.importText(page, TTL, "turtle");

    const all = await A.allConcepts(page);
    expect(all).toEqual(expect.arrayContaining([RENEW, SOLAR, WIND]));
    expect(all.length).toBe(before + 3);

    expect(await A.broaderOf(page, SOLAR)).toEqual([RENEW]);
    expect(await A.topConcepts(page)).toContain(RENEW);

    // and the user can see it without hunting
    expect(await A.treeHas(page, RENEW)).toBe(true);
    await A.toggle(page, RENEW);
    const kids = (await A.treeChildren(page, RENEW)).map((r) => r.iri);
    expect(kids).toEqual(expect.arrayContaining([SOLAR, WIND]));
  });

  test("the preview's count is what actually lands", async ({ page }) => {
    const before = await A.quadCount(page);
    await page.evaluate(() => openImportDialog());
    await A.waitModal(page, "Import");
    await page.fill("#iPaste", TTL);
    await page.selectOption("#iFormat", "turtle");
    await A.modalOk(page);
    await A.waitModal(page, "Import profile");
    await A.modalOk(page);
    await A.waitModal(page, "Import preview");
    const promised = Number((await page.textContent("#mOk")).replace(/[^0-9]/g, ""));
    await page.click("#mOk");
    await page.waitForFunction(() => !document.querySelector("#modalRoot .modal"), null, { timeout: 30_000 });
    expect(await A.quadCount(page)).toBe(before + promised);
  });

  test("importing does not disturb the concepts already there", async ({ page }) => {
    const rootsBefore = (await A.topConcepts(page)).slice().sort();
    const forestsKids = (await A.narrowerOf(page, A.sdg("bosques"))).slice().sort();
    await A.importText(page, TTL, "turtle");
    expect((await A.topConcepts(page)).sort()).toEqual(expect.arrayContaining(rootsBefore));
    expect((await A.narrowerOf(page, A.sdg("bosques"))).sort()).toEqual(forestsKids);
  });

  test("creating a concept after an import keeps the imported roots visible", async ({ page }) => {
    await A.importText(page, TTL, "turtle");
    const rootsBefore = (await A.treeRoots(page)).map((r) => r.iri);
    expect(rootsBefore).toContain(RENEW);

    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Post import term" });

    const rootsAfter = (await A.treeRoots(page)).map((r) => r.iri);
    expect(rootsAfter).toEqual(expect.arrayContaining(rootsBefore));
    expect(await A.conceptByLabel(page, "Post import term")).toBeTruthy();
  });

  test("re-running the same import adds nothing the second time", async ({ page }) => {
    await A.importText(page, TTL, "turtle");
    const after1 = await A.quadCount(page);
    await A.importText(page, TTL, "turtle");
    expect(await A.quadCount(page)).toBe(after1);
  });

  test("cancelling at the preview writes nothing", async ({ page }) => {
    const before = await A.quadCount(page);
    await page.evaluate(() => openImportDialog());
    await A.waitModal(page, "Import");
    await page.fill("#iPaste", TTL);
    await page.selectOption("#iFormat", "turtle");
    await A.modalOk(page);
    await A.waitModal(page, "Import profile");
    await A.modalOk(page);
    await A.waitModal(page, "Import preview");
    await A.modalCancel(page);
    expect(await A.quadCount(page)).toBe(before);
    expect(await A.allConcepts(page)).not.toContain(RENEW);
  });

  test("an empty import is refused rather than staged", async ({ page }) => {
    await page.evaluate(() => openImportDialog());
    await A.waitModal(page, "Import");
    await A.modalOk(page);
    expect((await A.alerts(page)).join(" ")).toMatch(/choose a file or paste/i);
    await A.modalCancel(page);
  });

  test("a malformed line is surfaced, not silently dropped", async ({ page }) => {
    const bad = TTL + "\nex:broken >>> not turtle at all <<< 42 .\n";
    await page.evaluate(() => openImportDialog());
    await A.waitModal(page, "Import");
    await page.fill("#iPaste", bad);
    await page.selectOption("#iFormat", "turtle");
    await A.modalOk(page);
    await A.waitModal(page, "Import profile");
    const errs = await page.evaluate(() => IMPORT.errors.length);
    expect(errs).toBeGreaterThan(0);
    expect(await A.modalText(page)).toMatch(/could not be read|error|line/i);
    await A.modalCancel(page);
  });

  test("N-Triples imports the same content as Turtle", async ({ page }) => {
    const nt = [
      `<${RENEW}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2004/02/skos/core#Concept> .`,
      `<${RENEW}> <http://www.w3.org/2004/02/skos/core#prefLabel> "Renewable energy"@en .`,
      `<${SOLAR}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2004/02/skos/core#Concept> .`,
      `<${SOLAR}> <http://www.w3.org/2004/02/skos/core#prefLabel> "Solar power"@en .`,
      `<${SOLAR}> <http://www.w3.org/2004/02/skos/core#broader> <${RENEW}> .`
    ].join("\n");
    await A.importText(page, nt, "ntriples");
    expect(await A.broaderOf(page, SOLAR)).toEqual([RENEW]);
    expect(await A.treeHas(page, RENEW)).toBe(true);
  });

  test("an import logs an action, the SPARQL and an audit event", async ({ page }) => {
    await A.importText(page, TTL, "turtle");
    expect((await A.logs(page, "audit")).map((e) => e.msg + " " + (e.code || "")).join("\n")).toMatch(/Import/i);
    // an import is written as a transaction add, not a SPARQL UPDATE — the rdf
    // channel carries the batch and names the graph it goes into
    const rdf = (await A.logs(page, "rdf")).map((e) => e.msg + " " + (e.code || "")).join("\n");
    expect(rdf).toMatch(/import batch/);
    expect(rdf).toContain("urn:taxonomy:scheme:plant-conservation:draft");
  });
});
