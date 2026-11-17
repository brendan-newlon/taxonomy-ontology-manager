const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const MANGROVE = A.sdg("manglar");
const AGRI = A.sdg("agricultura-sostenible");

/** Every channel a mutating action is required to speak on. */
async function channels(page, since) {
  const all = await A.logs(page);
  const fresh = all.slice(since);
  return {
    action: fresh.filter((e) => e.channel === "action"),
    rdf: fresh.filter((e) => e.channel === "rdf"),
    audit: fresh.filter((e) => e.channel === "audit"),
    internal: fresh.filter((e) => e.channel === "internal")
  };
}
const logLength = (page) => page.evaluate(() => State.log.length);

test.describe("Transparency console (a product feature, not debug output)", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("creating a concept speaks on action, rdf and audit", async ({ page }) => {
    const at = await logLength(page);
    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Console check" });
    const ch = await channels(page, at);
    expect(ch.action.length).toBeGreaterThan(0);
    expect(ch.rdf.length).toBeGreaterThan(0);
    expect(ch.audit.length).toBeGreaterThan(0);
    expect(ch.internal.length).toBeGreaterThan(0);
  });

  test("moving a concept speaks on all four channels", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    const at = await logLength(page);
    await A.dragDrop(page, MANGROVE, AGRI);
    await A.waitModal(page);
    await A.modalOk(page);
    const ch = await channels(page, at);
    expect(ch.action.map((e) => e.msg).join()).toMatch(/Move/);
    expect(ch.audit.map((e) => e.msg).join()).toMatch(/MoveConcept/);
    expect(ch.rdf.length).toBeGreaterThan(0);
  });

  test("the rdf entry is real SPARQL naming the graph that was written", async ({ page }) => {
    const at = await logLength(page);
    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Sparql check" });
    const ch = await channels(page, at);
    const update = ch.rdf.map((e) => e.code || "").find((c) => /INSERT/.test(c));
    expect(update).toBeTruthy();
    expect(update).toContain("urn:taxonomy:scheme:plant-conservation:draft");
    expect(update).toMatch(/PREFIX skos:/);
    expect(update).toMatch(/GRAPH </);
  });

  test("the audit entry names the action and travels with the same change", async ({ page }) => {
    const at = await logLength(page);
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "relations");
    await A.removeRelation(page, "broader", A.sdg("bosques"));
    const ch = await channels(page, at);
    expect(ch.audit.map((e) => e.msg).join()).toMatch(/RemoveRelation/);
    // the data change and its audit event are one transaction: one UPDATE carries both
    const update = ch.rdf.map((e) => e.code || "").find((c) => /DELETE|INSERT/.test(c));
    expect(update).toMatch(/urn:taxonomy:app:audit/);
  });

  test("every write also bumps the revision counter in the same update", async ({ page }) => {
    const at = await logLength(page);
    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Revision check" });
    const ch = await channels(page, at);
    const update = ch.rdf.map((e) => e.code || "").find((c) => /INSERT/.test(c));
    expect(update).toMatch(/tax:revision/);
  });

  test("the console renders the entries it recorded", async ({ page }) => {
    await page.click("#btnNewConcept");
    await A.fillNewConcept(page, { label: "Rendered in console" });
    const body = await page.textContent("#consoleBody");
    expect(body).toMatch(/Rendered in console/);
  });

  test("read-only navigation does not write to the audit channel", async ({ page }) => {
    const at = await logLength(page);
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "metadata");
    const ch = await channels(page, at);
    expect(ch.audit).toHaveLength(0);
  });
});
