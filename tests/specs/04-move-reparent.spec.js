const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const SKOS = "http://www.w3.org/2004/02/skos/core#";

const MANGROVE = A.sdg("mangrove");
const FORESTS = A.sdg("forests");
const NATURAL = A.sdg("natural-resources");
const FRESHWATER = A.sdg("freshwater");
const AGRI = A.sdg("sustainable-agriculture");
const AGROFOR = A.sdg("agroforestry");
const SHADE_COFFEE = A.sdg("shade-grown-coffee");

/** Make sure a concept's row is on screen by opening every ancestor. */
async function reveal(page, c) {
  await page.evaluate((x) => {
    const up = (y, seen) => broaderOf(y).forEach((b) => {
      if (seen.has(b)) return; seen.add(b); State.expanded.add(b); up(b, seen);
    });
    up(x, new Set());
    renderTree();
  }, c);
}

test.describe("Moving and re-parenting", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("dropping onto a COLLAPSED target still leaves the moved concept on screen", async ({ page }) => {
    await reveal(page, MANGROVE);
    expect(await A.treeHas(page, MANGROVE)).toBe(true);

    // the target is closed, which is the ordinary case in a big tree
    if (await A.isExpanded(page, AGRI)) await A.toggle(page, AGRI);
    expect(await A.isExpanded(page, AGRI)).toBe(false);

    await A.dragDrop(page, MANGROVE, AGRI);
    await A.waitModal(page, "Move concept");
    await A.modalOk(page);

    // the triples moved
    expect(await A.broaderOf(page, MANGROVE)).toEqual([AGRI]);
    expect(await A.narrowerOf(page, AGRI)).toContain(MANGROVE);
    expect(await A.narrowerOf(page, FORESTS)).not.toContain(MANGROVE);

    // and so did the row the user was watching
    expect(await A.treeHas(page, MANGROVE)).toBe(true);
    expect((await A.treeChildren(page, AGRI)).map((r) => r.iri)).toContain(MANGROVE);
  });

  test("a moved concept is selected and its new parent opened", async ({ page }) => {
    await reveal(page, MANGROVE);
    if (await A.isExpanded(page, FRESHWATER)) await A.toggle(page, FRESHWATER);

    await A.dragDrop(page, MANGROVE, FRESHWATER);
    await A.waitModal(page, "Move concept");
    await A.modalOk(page);

    expect(await A.isExpanded(page, FRESHWATER)).toBe(true);
    expect(await A.selected(page)).toBe(MANGROVE);
    expect((await A.treeRow(page, MANGROVE)).selected).toBe(true);
  });

  test("the old parent's inverse narrower is removed in the same transaction", async ({ page }) => {
    await reveal(page, MANGROVE);
    await A.dragDrop(page, MANGROVE, AGRI);
    await A.waitModal(page);
    await A.modalOk(page);

    const forestKids = await A.narrowerOf(page, FORESTS);
    expect(forestKids).not.toContain(MANGROVE);
    const trip = await A.triplesOf(page, FORESTS);
    expect(trip.filter(([p, o]) => p === SKOS + "narrower" && o === MANGROVE)).toHaveLength(0);
  });

  test("Ctrl-drop adds a second parent and keeps the first", async ({ page }) => {
    await reveal(page, MANGROVE);
    await A.dragDrop(page, MANGROVE, FRESHWATER, { ctrl: true });
    await A.waitModal(page, "Add a broader concept");
    await A.modalOk(page);

    const ups = await A.broaderOf(page, MANGROVE);
    expect(ups).toEqual(expect.arrayContaining([FORESTS, FRESHWATER]));
    expect(ups).toHaveLength(2);

    await reveal(page, MANGROVE);
    const row = await A.treeRow(page, MANGROVE);
    /* The mark says how many, in words: "poly" was shorthand for people who
       already knew what it meant. */
    expect(row.flags).toContain("parents");
    expect(row.flagText).toContain("2 parents");
  });

  test("moving a TOP concept under a parent drops its topConceptOf", async ({ page }) => {
    expect(await A.broaderOf(page, AGRI)).toEqual([]);
    const before = (await A.triplesOf(page, AGRI)).map(([p]) => p);
    expect(before).toContain(SKOS + "topConceptOf");

    await A.dragDrop(page, AGRI, NATURAL);
    await A.waitModal(page, "Move concept");
    await A.modalOk(page);

    const after = (await A.triplesOf(page, AGRI)).map(([p]) => p);
    expect(after).not.toContain(SKOS + "topConceptOf");
    expect(await A.broaderOf(page, AGRI)).toEqual([NATURAL]);
    expect(await A.topConcepts(page)).not.toContain(AGRI);
    expect(await A.treeHas(page, AGRI)).toBe(true);
  });

  test("dropping a concept onto its own descendant is refused and writes nothing", async ({ page }) => {
    await reveal(page, SHADE_COFFEE);
    const before = await A.quadCount(page);
    await A.clearAlerts(page);

    await A.dragDrop(page, AGROFOR, SHADE_COFFEE);   // parent onto its own child

    expect(await A.modalOpen(page)).toBe(false);
    expect((await A.alerts(page)).join(" ")).toMatch(/cycle|underneath itself/i);
    expect(await A.quadCount(page)).toBe(before);
    expect(await A.broaderOf(page, AGROFOR)).toEqual([AGRI]);
  });

  test("dropping a concept onto itself does nothing", async ({ page }) => {
    await reveal(page, MANGROVE);
    const before = await A.quadCount(page);
    await A.dragDrop(page, MANGROVE, MANGROVE);
    expect(await A.modalOpen(page)).toBe(false);
    expect(await A.quadCount(page)).toBe(before);
  });

  test("the move preview names the current parent, the new parent and the descendants carried", async ({ page }) => {
    await reveal(page, FORESTS);
    await A.dragDrop(page, FORESTS, AGRI);
    await A.waitModal(page, "Move concept");
    const txt = await A.modalText(page);
    expect(txt).toContain("Forests");
    expect(txt).toContain("Natural resources");        // current broader
    expect(txt).toContain("Sustainable agriculture");  // new broader
    expect(txt).toMatch(/Narrower carried along.*[1-9]/);
    await A.modalCancel(page);
  });

  test("cancelling the preview writes nothing", async ({ page }) => {
    await reveal(page, MANGROVE);
    const before = await A.quadCount(page);
    await A.dragDrop(page, MANGROVE, AGRI);
    await A.waitModal(page, "Move concept");
    await A.modalCancel(page);
    expect(await A.quadCount(page)).toBe(before);
    expect(await A.broaderOf(page, MANGROVE)).toEqual([FORESTS]);
  });

  test("a move logs an action, the SPARQL and a MoveConcept audit event", async ({ page }) => {
    await reveal(page, MANGROVE);
    await A.dragDrop(page, MANGROVE, AGRI);
    await A.waitModal(page);
    await A.modalOk(page);
    const audit = (await A.logs(page, "audit")).map((e) => e.msg + " " + (e.code || "")).join("\n");
    const rdf = (await A.logs(page, "rdf")).map((e) => e.msg + " " + (e.code || "")).join("\n");
    expect(audit).toMatch(/MoveConcept/);
    expect(rdf).toMatch(/DELETE|INSERT/);
  });

  test("a moved concept keeps its descendants, and they stay reachable", async ({ page }) => {
    await reveal(page, AGROFOR);
    await A.dragDrop(page, AGROFOR, FORESTS);
    await A.waitModal(page, "Move concept");
    await A.modalOk(page);

    expect(await A.broaderOf(page, AGROFOR)).toEqual([FORESTS]);
    expect(await A.narrowerOf(page, AGROFOR)).toContain(SHADE_COFFEE);
    expect(await A.treeHas(page, AGROFOR)).toBe(true);
    await A.toggle(page, AGROFOR);
    expect((await A.treeChildren(page, AGROFOR)).map((r) => r.iri)).toContain(SHADE_COFFEE);
  });
});
