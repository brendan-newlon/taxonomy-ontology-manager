const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const PPT = "https://vendor.example.org/schema/history#";
const EV = "https://knowledgeProductsTaxonomy.example.org/historyEvent/";
const DCT = "http://purl.org/dc/terms/";
const SKOS = "http://www.w3.org/2004/02/skos/core#";
const TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const TERM = "https://taxonomy.example.org/id/imported/term-1";
const ASIDE = "urn:taxonomy:import:aside";

/**
 * Dropping a type, versus setting its subjects aside.
 *
 * "Drop this typing" removes one `rdf:type` triple. That is right for a term
 * that also happens to be typed something the vocabulary does not want, and
 * wrong for a file carrying a whole second population of subjects that are not
 * terms at all. The reference export is the worked example: a vendor change
 * log of 170,413 subjects, of which 2,177 also carry a `dct:title` and a
 * `dct:description` — so dropping their typing leaves those 2,177 behind as
 * untyped subjects, and 4,357 statements of them.
 *
 * The answer is not to delete them. A subject with no other properties *in
 * this file* may still be an identifier whose other half is held in another
 * system, and discarding it destroys a join nobody can reconstruct. They go
 * to the vocabulary's provenance graph: same database, out of the vocabulary,
 * exported with it, one query away.
 */
const FILE = [
  `<${EV}a1> <${TYPE}> <${PPT}NoteHistoryEvent> .`,
  `<${EV}a1> <${DCT}title> "Blacklisted" .`,
  `<${EV}a1> <${DCT}description> "Concept was blacklisted during validation." .`,
  `<${EV}a2> <${TYPE}> <${PPT}RelationAddRemoveHistoryEvent> .`,
  `<${TERM}> <${TYPE}> <${SKOS}Concept> .`,
  `<${TERM}> <${TYPE}> <${PPT}NoteHistoryEvent> .`,
  `<${TERM}> <${SKOS}prefLabel> "A real term"@en .`,
  `<${TERM}> <${DCT}title> "Kept, because this is a term" .`
].join("\n");

const decide = (page, quads, decisions) => page.evaluate((x) => {
  const rows = parseNTriples(x.text).filter((r) => r.s);
  return applyDecisions(rows, x.decisions)
    .map((q) => ({ t: `${q.s.v} ${q.p.v} ${q.o.v}`, aside: isAside(q) }));
}, { text: quads, decisions });

const HISTORY = "class:" + PPT + "NoteHistoryEvent";

test.describe("Dropping a type, or setting its subjects aside", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("dropping the typing leaves the rest of the subject in the vocabulary", async ({ page }) => {
    const out = await decide(page, FILE, { [HISTORY]: "drop" });
    const a1 = out.filter((r) => r.t.startsWith(EV + "a1"));
    expect(a1).toHaveLength(2);                        // title + description, untyped
    expect(a1.every((r) => !r.aside)).toBe(true);
  });

  test("setting them aside keeps every statement, out of the vocabulary", async ({ page }) => {
    const out = await decide(page, FILE, { [HISTORY]: "aside" });
    const a1 = out.filter((r) => r.t.startsWith(EV + "a1"));
    expect(a1).toHaveLength(3);                        // nothing lost — the type as well
    expect(a1.every((r) => r.aside)).toBe(true);
    expect(a1.map((r) => r.t).join(" | ")).toContain("Blacklisted");
  });

  test("a subject that is also a term stays a term, with all of its statements", async ({ page }) => {
    const out = await decide(page, FILE, { [HISTORY]: "aside" });
    const term = out.filter((r) => r.t.startsWith(TERM));
    expect(term).toHaveLength(4);
    expect(term.every((r) => !r.aside)).toBe(true);
    expect(term.map((r) => r.t).join(" | ")).toContain("Kept, because this is a term");
  });

  test("a statement pointing at a moved subject moves with it", async ({ page }) => {
    const withRef = FILE + `\n<${TERM}> <${DCT}source> <${EV}a1> .`;
    const out = await decide(page, withRef, { [HISTORY]: "aside" });
    const ref = out.find((r) => r.t.includes(DCT + "source"));
    expect(ref).toBeTruthy();
    expect(ref.aside).toBe(true);                      // the link is kept, on the far side
    // and the vocabulary is left with nothing dangling
    expect(out.filter((r) => !r.aside).some((r) => r.t.includes(EV + "a1"))).toBe(false);
  });

  test("another type is untouched by the decision on this one", async ({ page }) => {
    const out = await decide(page, FILE, { [HISTORY]: "aside" });
    expect(out.map((r) => r.t).join(" | ")).toContain(PPT + "RelationAddRemoveHistoryEvent");
  });

  test("nothing is lost, whichever way the file is split", async ({ page }) => {
    for (const choice of ["keep", "aside"]) {
      const out = await decide(page, FILE, { [HISTORY]: choice });
      expect(out).toHaveLength(8);
    }
    // and dropping is still available, and still loses exactly the typing
    expect(await decide(page, FILE, { [HISTORY]: "drop" })).toHaveLength(6);
  });

  test("both profiles offer the same three choices", async ({ page }) => {
    await page.evaluate(() => openImportDialog());
    await A.waitModal(page, "Import");
    await page.fill("#iPaste", FILE);
    await page.selectOption("#iFormat", "ntriples");
    await A.modalOk(page);
    await A.waitModal(page, "Import profile");
    const opts = await page.$$eval("[data-cd]", (sels) =>
      sels[0] ? [...sels[0].options].map((o) => o.value) : []);
    expect(opts).toEqual(["keep", "drop", "aside"]);
  });

  test("the preview says how many are going where", async ({ page }) => {
    await page.evaluate(() => openImportDialog());
    await A.waitModal(page, "Import");
    await page.fill("#iPaste", FILE);
    await page.selectOption("#iFormat", "ntriples");
    await A.modalOk(page);
    await A.waitModal(page, "Import profile");
    await page.selectOption(`[data-cd="${A.cssEscape(PPT + "NoteHistoryEvent")}"]`, "aside");
    await A.modalOk(page);
    await A.waitModal(page, "Import preview");
    const body = (await A.modalText(page)).replace(/\s+/g, " ");
    expect(body).toMatch(/kept out of the vocabulary/i);
    expect(body).toContain("provenance");
  });

  test("they land in the provenance graph, and the vocabulary does not hold them", async ({ page }) => {
    await A.importText(page, FILE, "ntriples", { classes: { [PPT + "NoteHistoryEvent"]: "aside" } });
    const where = await page.evaluate((x) => {
      const prov = G.provenance(State.schemeId);
      return {
        inProvenance: State.store.match(prov, iri(x.ev), null, null).length,
        inVocabulary: State.store.match(currentGraph(), iri(x.ev), null, null).length,
        termInVocabulary: State.store.match(currentGraph(), iri(x.term), null, null).length
      };
    }, { ev: EV + "a1", term: TERM });
    expect(where.inProvenance).toBe(3);
    expect(where.inVocabulary).toBe(0);
    expect(where.termInVocabulary).toBeGreaterThan(0);
  });

  test("the server-side path moves them rather than deleting them", async ({ page }) => {
    const sent = await page.evaluate(async (cls) => {
      const seen = [];
      const real = Backend.request;
      Backend.request = async (o) => {
        seen.push(String((o.body && o.body.get && o.body.get("update")) || ""));
        return { ok: true, text: async () => "", json: async () => ({}) };
      };
      try {
        await applyServerImport({ graph: "urn:test:staging" },
          { ["class:" + cls]: "aside" }, "urn:test:target");
      } finally { Backend.request = real; }
      return seen;
    }, PPT + "NoteHistoryEvent");

    const moves = sent.filter((q) => q.includes("NoteHistoryEvent"));
    expect(moves).toHaveLength(2);
    moves.forEach((q) => {
      expect(q).toContain("INSERT");                                  // moved…
      expect(q).toContain(":provenance");                             // …to the provenance graph
      expect(q).toContain("FILTER NOT EXISTS { ?s a skos:Concept }"); // …never a term
    });
    expect(moves[0]).toContain("?x ?p ?s");        // references first
    expect(moves[1]).toContain("?s ?p ?o");        // then the subjects
  });

  test("an importer needs write access to the provenance graph, or it cannot land", async ({ page }) => {
    const g = await page.evaluate(() =>
      grantsForLevels(["import"], schemeGraphs(schemeById(State.schemeId))).map(needLabel));
    expect(g.some((x) => x.startsWith("WRITE") && x.includes(":provenance"))).toBe(true);
    expect(g.some((x) => x.startsWith("READ") && x.includes(":provenance"))).toBe(true);
  });
});
