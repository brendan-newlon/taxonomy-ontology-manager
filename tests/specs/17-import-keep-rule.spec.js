const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const EX = "https://taxonomy.example.org/id/imported/";
const AGENTS = "https://example.org/agents/";
const HIST = "https://example.org/history/";

/**
 * Shaped like the reference export: an author record that is a concept *and* a
 * schema.org Person carrying an ORCID, alongside a vendor's change-history
 * stub that is only ever itself. Both are foreign by namespace; only one of
 * them is part of the vocabulary.
 */
const MIXED = [
  `<${EX}author-9> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2004/02/skos/core#Concept> .`,
  `<${EX}author-9> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${AGENTS}Person> .`,
  `<${EX}author-9> <http://www.w3.org/2004/02/skos/core#prefLabel> "Vargas, Liliana"@en .`,
  `<${EX}author-9> <${AGENTS}orcid> "0000-0002-1825-0097" .`,
  `<${HIST}ev-1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${HIST}ChangeEvent> .`,
  `<${HIST}ev-1> <${HIST}performedBy> "someone" .`
].join("\n");

/** Stage the paste and stop on the profile, without applying anything. */
async function openProfile(page, { live } = {}) {
  if (live) await page.evaluate(() => { State.mode = "live"; });
  await page.evaluate(() => openImportDialog());
  await A.waitModal(page, "Import");
  await page.fill("#iPaste", MIXED);
  await page.selectOption("#iFormat", "ntriples");
  await A.modalOk(page);
  await A.waitModal(page, "Import profile");
}

const decisions = (page) => page.$$eval("#modalRoot [data-pd], #modalRoot [data-cd]",
  (els) => Object.fromEntries(els.map((e) => [e.dataset.pd || e.dataset.cd, e.value])));

test.describe("What an import suggests keeping", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("with nowhere to put it, what only bookkeeping carries is suggested for dropping", async ({ page }) => {
    await openProfile(page);
    const d = await decisions(page);
    expect(d[HIST + "ChangeEvent"]).toBe("drop");
    expect(d[HIST + "performedBy"]).toBe("drop");
    // ...and what a concept carries is not
    expect(d[AGENTS + "Person"]).toBe("keep");
    expect(d[AGENTS + "orcid"]).toBe("keep");
  });

  test("connected to a database, nothing is suggested for dropping", async ({ page }) => {
    await openProfile(page, { live: true });
    expect(Object.values(await decisions(page)).every((v) => v === "keep")).toBe(true);
    expect(await A.modalText(page)).toMatch(/Everything below starts at keep/);
  });

  test("Reset to suggested goes back to the rule, not an older copy of it", async ({ page }) => {
    await openProfile(page);
    await page.selectOption(`[data-pd="${A.cssEscape(AGENTS + "orcid")}"]`, "drop");
    await page.selectOption(`[data-cd="${A.cssEscape(HIST + "ChangeEvent")}"]`, "keep");
    await page.click("#impResetAll");
    const d = await decisions(page);
    expect(d[AGENTS + "orcid"]).toBe("keep");
    expect(d[HIST + "ChangeEvent"]).toBe("drop");
  });

  test("Reset to suggested keeps everything when there is a database holding it", async ({ page }) => {
    await openProfile(page, { live: true });
    await page.selectOption(`[data-pd="${A.cssEscape(AGENTS + "orcid")}"]`, "drop");
    await page.click("#impResetAll");
    expect(Object.values(await decisions(page)).every((v) => v === "keep")).toBe(true);
  });

  test("the suggestion is only ever a suggestion", async ({ page }) => {
    await openProfile(page, { live: true });
    await page.selectOption(`[data-cd="${A.cssEscape(HIST + "ChangeEvent")}"]`, "drop");
    expect((await decisions(page))[HIST + "ChangeEvent"]).toBe("drop");
  });
});
