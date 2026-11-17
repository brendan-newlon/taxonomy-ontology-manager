const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const SKOS = "http://www.w3.org/2004/02/skos/core#";
const EXV = "https://example.org/vocab#";

const MANGROVE = A.sdg("manglar");
const FORESTS = A.sdg("bosques");
const AGRI = A.sdg("agricultura-sostenible");
const WATERSHED = A.sdg("cuenca-hidrografica");
const FRESHWATER = A.sdg("agua-dulce");

/** A paired type, the shape a vendor custom relation usually arrives in. */
const PART_OF = EXV + "partOf";
const HAS_PART = EXV + "hasPart";
/** A symmetric type — its own inverse, like skos:related. */
const SIMILAR = EXV + "similarTo";
/** A one-way type — nothing is written back. */
const CITES = EXV + "cites";

async function registerPair(page) {
  await A.registerRelType(page, { iri: PART_OF, label: "Part of", inverse: HAS_PART, hierarchical: true });
  await A.registerRelType(page, { iri: HAS_PART, label: "Has part", inverse: PART_OF });
}

test.describe("Custom relation types (FR-2.1 generalised)", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the three SKOS types are registered before anything is added", async ({ page }) => {
    const t = await A.relTypes(page);
    expect(t.map((x) => x.iri)).toEqual([SKOS + "broader", SKOS + "narrower", SKOS + "related"]);
    expect(t.every((x) => x.core)).toBe(true);
  });

  test("registering a type adds it, and nothing else changes", async ({ page }) => {
    await A.registerRelType(page, { iri: SIMILAR, label: "Similar to", symmetric: true });
    const t = await A.relTypes(page);
    const mine = t.find((x) => x.iri === SIMILAR);
    expect(mine).toBeTruthy();
    expect(mine.label).toBe("Similar to");
    expect(mine.symmetric).toBe(true);
    expect(mine.core).toBeFalsy();
    expect(t.filter((x) => x.core)).toHaveLength(3);
  });

  test("a registered type with no values does not clutter the tab", async ({ page }) => {
    await A.registerRelType(page, { iri: SIMILAR, label: "Similar to", symmetric: true });
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "relations");
    // the three SKOS types always render; a custom one earns its place
    expect(await A.relSections(page)).toEqual([SKOS + "broader", SKOS + "narrower", SKOS + "related"]);
  });

  test("a paired type writes both directions and both concepts show it", async ({ page }) => {
    await registerPair(page);
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "relations");
    await page.evaluate((c) => addRelationPrompt(c, "https://example.org/vocab#partOf"), MANGROVE);
    await A.waitModal(page);
    await A.pick(page, "mTarget", "Sustainable agriculture");
    await A.modalOk(page);

    expect(await A.relationsOf(page, MANGROVE, PART_OF)).toEqual([AGRI]);
    expect(await A.relationsOf(page, AGRI, HAS_PART)).toEqual([MANGROVE]);

    // and the user can see it without going looking
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "relations");
    expect(await A.relSections(page)).toContain(PART_OF);
    expect(await page.textContent("#tabbody")).toMatch(/Part of/);
  });

  test("a symmetric type writes the same predicate both ways", async ({ page }) => {
    await A.registerRelType(page, { iri: SIMILAR, label: "Similar to", symmetric: true });
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await page.evaluate((c) => addRelationPrompt(c, "https://example.org/vocab#similarTo"), MANGROVE);
    await A.waitModal(page);
    await A.pick(page, "mTarget", "Watershed");
    await A.modalOk(page);

    expect(await A.relationsOf(page, MANGROVE, SIMILAR)).toEqual([WATERSHED]);
    expect(await A.relationsOf(page, WATERSHED, SIMILAR)).toEqual([MANGROVE]);
  });

  test("a one-way type writes one direction only", async ({ page }) => {
    await A.registerRelType(page, { iri: CITES, label: "Cites" });
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await page.evaluate((c) => addRelationPrompt(c, "https://example.org/vocab#cites"), MANGROVE);
    await A.waitModal(page);
    await A.pick(page, "mTarget", "Watershed");
    await A.modalOk(page);

    expect(await A.relationsOf(page, MANGROVE, CITES)).toEqual([WATERSHED]);
    const back = await A.triplesOf(page, WATERSHED);
    expect(back.some(([p]) => p === CITES)).toBe(false);
  });

  test("removing a custom relation removes both directions", async ({ page }) => {
    await registerPair(page);
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await page.evaluate((c) => addRelationPrompt(c, "https://example.org/vocab#partOf"), MANGROVE);
    await A.waitModal(page);
    await A.pick(page, "mTarget", "Sustainable agriculture");
    await A.modalOk(page);

    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "relations");
    await A.removeRelation(page, PART_OF, AGRI);

    expect(await A.relationsOf(page, MANGROVE, PART_OF)).toEqual([]);
    expect(await A.relationsOf(page, AGRI, HAS_PART)).toEqual([]);
  });

  /* Finds the Triples-tab's outgoing row for the predicate whose short form
     contains `needle`, and whether it carries an edit button — a registered
     relation type still shows there (the Triples tab excludes no predicate,
     see CLAUDE.md), just without the buttons that would let a raw edit
     bypass deleteRelation()'s inverse handling (see manageTabFor()).
     Addressed by TRIPLES_OUT's own index, not scraped from a <tr>'s text --
     rows are grouped by predicate now (see tripleGroupsHtml()), so the
     predicate name lives on the group's own header, not inside each row. */
  const tripleRow = (page, needle) => page.evaluate((n) => {
    const idx = TRIPLES_OUT.findIndex((q) => short(q.p.v).includes(n));
    if (idx < 0) return null;
    return { hasEdit: !!document.querySelector(`[data-edittripleout="${idx}"]`) };
  }, needle);

  test("a custom relation shows on the Triples tab too, but not as something to edit there", async ({ page }) => {
    await A.registerRelType(page, { iri: SIMILAR, label: "Similar to", symmetric: true });
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await page.evaluate((c) => addRelationPrompt(c, "https://example.org/vocab#similarTo"), MANGROVE);
    await A.waitModal(page);
    await A.pick(page, "mTarget", "Watershed");
    await A.modalOk(page);

    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "triples");
    expect(await page.textContent("#tabbody")).toContain("similarTo");
    expect(await tripleRow(page, "similarTo")).toEqual({ hasEdit: false });
  });

  test("un-registering makes the relation a plain, editable Triples-tab row", async ({ page }) => {
    await A.registerRelType(page, { iri: SIMILAR, label: "Similar to", symmetric: true });
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await page.evaluate((c) => addRelationPrompt(c, "https://example.org/vocab#similarTo"), MANGROVE);
    await A.waitModal(page);
    await A.pick(page, "mTarget", "Watershed");
    await A.modalOk(page);

    await A.unregisterRelType(page, SIMILAR);
    expect((await A.relTypes(page)).map((t) => t.iri)).not.toContain(SIMILAR);
    // the data survives — forgetting a definition is not deleting content
    const triples = await A.triplesOf(page, MANGROVE);
    expect(triples.some(([p, o]) => p === SIMILAR && o === WATERSHED)).toBe(true);

    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "triples");
    expect(await page.textContent("#tabbody")).toContain("similarTo");
    expect(await tripleRow(page, "similarTo")).toEqual({ hasEdit: true });
  });

  test("the tab's relation count includes custom types", async ({ page }) => {
    await A.registerRelType(page, { iri: SIMILAR, label: "Similar to", symmetric: true });
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    const before = Number(await page.textContent('#tabs [data-tab="relations"] .count'));
    await page.evaluate((c) => addRelationPrompt(c, "https://example.org/vocab#similarTo"), MANGROVE);
    await A.waitModal(page);
    await A.pick(page, "mTarget", "Watershed");
    await A.modalOk(page);
    await A.clickRow(page, MANGROVE);
    expect(Number(await page.textContent('#tabs [data-tab="relations"] .count'))).toBe(before + 1);
  });

  test("the config graph can relabel a built-in without adding a fourth type", async ({ page }) => {
    await A.registerRelType(page, { iri: SKOS + "related", label: "See also", origin: "skos" });
    const t = await A.relTypes(page);
    expect(t).toHaveLength(3);
    expect(t.find((x) => x.iri === SKOS + "related").label).toBe("See also");
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "relations");
    expect(await page.textContent("#tabbody")).toMatch(/See also/);
  });

  test("registering speaks on the action, rdf and audit channels", async ({ page }) => {
    const at = await page.evaluate(() => State.log.length);
    await A.registerRelType(page, { iri: SIMILAR, label: "Similar to", symmetric: true });
    const fresh = (await A.logs(page)).slice(at);
    expect(fresh.filter((e) => e.channel === "audit")
      .map((e) => e.msg + " " + (e.code || "")).join("\n")).toMatch(/RegisterRelationType/);
    const update = fresh.filter((e) => e.channel === "rdf").map((e) => e.code || "")
      .find((c) => /INSERT/.test(c));
    expect(update).toContain("urn:taxonomy:app:config");
    expect(update).toContain(SIMILAR);
  });

  /* Keeping a concept-to-concept predicate on the way in and then having no
     way to see what it links is the same defect as dropping it, one step
     later: the statements are in the database and unreachable. So the import
     lists it, rather than leaving it a candidate for someone to notice. */
  test("keeping a link between terms on import lists it as a type there and then", async ({ page }) => {
    expect((await A.relTypes(page)).map((t) => t.iri)).not.toContain(EXV + "growsIn");

    await A.importText(page, [
      `<${MANGROVE}> <${EXV}growsIn> <${FRESHWATER}> .`,
      `<${FORESTS}> <${EXV}growsIn> <${FRESHWATER}> .`
    ].join("\n"), "ntriples", { keep: [EXV + "growsIn"] });

    expect((await A.relTypes(page)).map((t) => t.iri)).toContain(EXV + "growsIn");
    // so it is no longer something to discover — it is listed
    expect((await A.discoveredRelPredicates(page)).map((x) => x.iri)).not.toContain(EXV + "growsIn");
    // and the relations themselves are reachable from the concept
    expect(await A.relationsOf(page, MANGROVE, EXV + "growsIn")).toContain(FRESHWATER);
  });

  test("a link to something that is not a term here is not made a type", async ({ page }) => {
    await A.importText(page,
      `<${MANGROVE}> <${EXV}documentedIn> <https://elsewhere.example.org/paper/7> .`,
      "ntriples", { keep: [EXV + "documentedIn"] });
    expect((await A.relTypes(page)).map((t) => t.iri)).not.toContain(EXV + "documentedIn");
  });

  test("an unregistered concept-to-concept predicate is offered as a candidate", async ({ page }) => {
    // not everything arrives through the import dialog: a vocabulary read
    // straight out of a database never went through a keep/drop decision.
    await page.evaluate((x) => {
      State.store.add(currentGraph(), iri(x.a), iri(x.p), iri(x.b));
      State.store.add(currentGraph(), iri(x.c), iri(x.p), iri(x.b));
    }, { a: MANGROVE, b: FRESHWATER, c: FORESTS, p: EXV + "growsIn" });

    const hit = (await A.discoveredRelPredicates(page)).find((x) => x.iri === EXV + "growsIn");
    expect(hit).toBeTruthy();
    expect(hit.n).toBe(2);

    // and once registered it is no longer a candidate, it is a type
    await A.registerRelType(page, { iri: EXV + "growsIn", label: "Grows in" });
    expect((await A.discoveredRelPredicates(page)).map((x) => x.iri)).not.toContain(EXV + "growsIn");
    expect((await A.relTypes(page)).map((t) => t.iri)).toContain(EXV + "growsIn");
  });

  test("a custom relation pointing outside the scheme is a finding", async ({ page }) => {
    await A.registerRelType(page, { iri: CITES, label: "Cites" });
    await page.evaluate((c) => {
      State.store.add(currentGraph(), iri(c), iri("https://example.org/vocab#cites"),
        iri("https://elsewhere.example.org/thing/42"));
    }, MANGROVE);
    const found = await page.evaluate(() => runValidation()
      .filter((i) => i.rule === "relation-target").map((i) => ({ concept: i.concept, text: i.text })));
    expect(found).toHaveLength(1);
    expect(found[0].concept).toBe(MANGROVE);
    expect(found[0].text).toMatch(/not a concept in this scheme/);
  });

  test("a cycle in a hierarchical custom type is found, and does not flag the tree", async ({ page }) => {
    await registerPair(page);
    await page.evaluate(([a, b]) => {
      const p = iri("https://example.org/vocab#partOf");
      State.store.add(currentGraph(), iri(a), p, iri(b));
      State.store.add(currentGraph(), iri(b), p, iri(a));
    }, [MANGROVE, WATERSHED]);
    const rules = await page.evaluate(() => runValidation().map((i) => i.rule));
    expect(rules).toContain("cycle-custom");
    // the tree's cycle flag is about skos:broader; this loop is not in it
    const treeCycles = await page.evaluate(() => [...conceptsInCycle()]);
    expect(treeCycles).not.toContain(MANGROVE);
  });

  test("merging carries custom relations to the survivor", async ({ page }) => {
    await A.registerRelType(page, { iri: CITES, label: "Cites" });
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await page.evaluate((c) => addRelationPrompt(c, "https://example.org/vocab#cites"), MANGROVE);
    await A.waitModal(page);
    await A.pick(page, "mTarget", "Watershed");
    await A.modalOk(page);

    await page.evaluate((c) => mergePrompt(c), MANGROVE);
    await A.waitModal(page, "Merge");
    expect(await page.$("#mOther")).not.toBeNull();
    await A.pick(page, "mInto", "Forests");
    await page.fill("#mWhy", "same concept");
    await A.modalOk(page);

    expect(await A.relationsOf(page, FORESTS, CITES)).toEqual([WATERSHED]);
    expect(await A.relationsOf(page, MANGROVE, CITES)).toEqual([]);
  });

  test("an export carries the definitions of the types it uses", async ({ page }) => {
    await A.registerRelType(page, { iri: SIMILAR, label: "Similar to", symmetric: true });
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await page.evaluate((c) => addRelationPrompt(c, "https://example.org/vocab#similarTo"), MANGROVE);
    await A.waitModal(page);
    await A.pick(page, "mTarget", "Watershed");
    await A.modalOk(page);

    // the default scope: this scheme's graph, which does not include the config
    // graph the definition lives in
    const ttl = await page.evaluate(() => serializeTurtle(exportQuads("scheme", true, false), false));
    expect(ttl).toContain(SIMILAR);
    // not just the relation — the definition that makes it readable elsewhere
    expect(ttl).toMatch(/RelationType/);
    expect(ttl).toMatch(/Similar to/);
    expect(ttl).toMatch(/SymmetricProperty/);
  });

  test("an export does not carry definitions for types it never uses", async ({ page }) => {
    await A.registerRelType(page, { iri: CITES, label: "Cites" });
    const ttl = await page.evaluate(() => serializeTurtle(exportQuads("scheme", true, false), false));
    expect(ttl).not.toContain(CITES);
  });
});
