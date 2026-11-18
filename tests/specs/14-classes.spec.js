const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const SKOS = "http://www.w3.org/2004/02/skos/core#";
const SC = "https://schema.org/";
const AG = "https://knowledge.example.org/ontologies/agents/";
const EX = "https://taxonomy.example.org/id/imported/";

const PERSON = SC + "Person";
const ORG = SC + "Organization";
const ORGUNIT = AG + "OrgUnit";
const MANGROVE = A.sdg("mangrove");

/**
 * Shaped like the reference export's entity registers: concepts that are also
 * instances of an ontology class, multi-typed, with the classes appearing in
 * `rdf:type` and **nowhere else** — no rdfs:label, no rdfs:subClassOf, no
 * rdfs:domain, no owl:* (DATASET §3, §4). Multi-typing is the normal shape
 * there: 10,473 subjects carry two types, 2,178 carry four.
 */
const ENTITIES = (() => {
  const out = [];
  const concept = (id, label) => {
    out.push(`<${EX}${id}> <${RDF}type> <${SKOS}Concept> .`);
    out.push(`<${EX}${id}> <${SKOS}prefLabel> "${label}"@en .`);
  };
  for (let i = 1; i <= 3; i++) { concept(`author-${i}`, `Author ${i}`); out.push(`<${EX}author-${i}> <${RDF}type> <${PERSON}> .`); }
  concept("inst-1", "Institution one");
  out.push(`<${EX}inst-1> <${RDF}type> <${ORG}> .`, `<${EX}inst-1> <${RDF}type> <${ORGUNIT}> .`);
  return out.join("\n");
})();

/* Deliberately does NOT set the class decisions: a class carried by concepts
   is suggested for keeping, and this import relies on that suggestion. */
async function importEntities(page) {
  await page.evaluate(() => openImportDialog());
  await A.waitModal(page, "Import");
  await page.fill("#iPaste", ENTITIES);
  await page.selectOption("#iFormat", "ntriples");
  await A.modalOk(page);
  await A.waitModal(page, "Import profile");
  await A.modalOk(page);
  await A.waitModal(page, "Import preview");
  await page.click("#mOk");
  await page.waitForFunction(() => !document.querySelector("#modalRoot .modal"), null, { timeout: 30_000 });
  await page.waitForTimeout(60);
}

const classes = (page) => page.evaluate(() => allClasses());
const classesOf = (page, c) => page.evaluate((x) => conceptClasses(x), c);
const treeMode = (page) => page.evaluate(() => State.treeMode);

test.describe("Ontology classes on a concept", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await importEntities(page);
  });

  test("classes in use are discovered with their counts, skos:Concept excluded", async ({ page }) => {
    const all = await classes(page);
    expect(all.map((x) => x.iri)).toEqual(expect.arrayContaining([PERSON, ORG, ORGUNIT]));
    expect(all.find((x) => x.iri === PERSON).n).toBe(3);
    // the type every concept has by construction is not "the class of" anything
    expect(all.map((x) => x.iri)).not.toContain(SKOS + "Concept");
    // biggest first — "which of these is the big one" is the first question
    expect(all[0].iri).toBe(PERSON);
  });

  test("a class with no label of its own is named by its local name", async ({ page }) => {
    const all = await classes(page);
    expect(all.find((x) => x.iri === ORGUNIT).label).toBe("OrgUnit");
    expect(all.find((x) => x.iri === PERSON).label).toBe("Person");
  });

  test("a declared rdfs:label wins over the local name", async ({ page }) => {
    await page.evaluate((cls) => {
      State.store.add(currentGraph(), iri(cls), P("rdfs:label"), lit("Organisational unit", "en"));
    }, ORGUNIT);
    expect((await classes(page)).find((x) => x.iri === ORGUNIT).label).toBe("Organisational unit");
  });

  test("the concept header says what kind of thing it is", async ({ page }) => {
    await A.clickRow(page, EX + "inst-1");
    const chips = await page.$$eval("#detailHead [data-gotocls]", (els) => els.map((e) => e.textContent.trim()));
    expect(chips).toEqual(["Organization", "OrgUnit"]);
  });

  test("a concept with no class beyond skos:Concept gets no chips", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    expect(await page.$$("#detailHead [data-gotocls]")).toHaveLength(0);
    await A.selectTab(page, "metadata");
    expect(await page.textContent("#tabbody")).toMatch(/Only a concept/);
  });

  test("Metadata lists the classes and no longer repeats them as Other properties", async ({ page }) => {
    await A.clickRow(page, EX + "inst-1");
    await A.selectTab(page, "metadata");
    const body = await page.textContent("#tabbody");
    expect(body).toMatch(/Classes/);
    expect(body).toMatch(/Organization/);
    // the same fact under a heading that says nothing has an editor for it
    const other = await page.$$eval(
      "#tabbody .section", (els) => {
        const s = els.find((e) => /Other properties/.test(e.textContent));
        return s ? s.textContent : "";
      });
    expect(other).not.toMatch(/schema\.org\/Organization/);
  });

  test("clicking a class shows everything of that kind", async ({ page }) => {
    await A.clickRow(page, EX + "author-1");
    await page.click("#detailHead [data-gotocls]");
    await page.waitForTimeout(120);

    expect(await treeMode(page)).toBe("classes");
    const rows = await page.$$eval("#tree [data-c]", (els) => els.map((e) => e.dataset.c));
    expect(rows).toEqual(expect.arrayContaining([EX + "author-1", EX + "author-2", EX + "author-3"]));
    expect(await page.textContent("#treeCount")).toMatch(/3 classes/);
  });

  test("and from there back into the hierarchy", async ({ page }) => {
    await A.clickRow(page, EX + "author-1");
    await page.click("#detailHead [data-gotocls]");
    await page.waitForTimeout(120);
    await page.click(`#tree [data-c="${A.cssEscape(EX + "author-2")}"]`);
    await page.waitForTimeout(120);
    expect(await A.selected(page)).toBe(EX + "author-2");
  });

  test("the Classes mode says so when it is showing only part of a class", async ({ page }) => {
    // 250 of a kind, past the 200 the mode renders
    await page.evaluate((cls) => {
      for (let i = 0; i < 250; i++) {
        const c = `https://taxonomy.example.org/id/imported/bulk-${String(i).padStart(3, "0")}`;
        State.store.add(currentGraph(), iri(c), P("rdf:type"), P("skos:Concept"));
        State.store.add(currentGraph(), iri(c), P("skos:prefLabel"), lit("Bulk " + String(i).padStart(3, "0"), "en"));
        State.store.add(currentGraph(), iri(c), P("rdf:type"), iri(cls));
      }
    }, PERSON);
    await page.evaluate((cls) => showClass(cls), PERSON);
    await page.waitForTimeout(150);
    const body = (await page.textContent("#tree")).replace(/\s+/g, " ");
    expect(body).toMatch(/The first 200 of 253, by name/);
  });

  test("the 200 it shows are the first 200 by name, not an arbitrary 200", async ({ page }) => {
    /* The cap is only defensible if the list has an order. Unsorted it was
       whatever order the statements were stored in, so the answer to "why
       those 200" was "no reason" and nothing past them could be reached. */
    await page.evaluate((cls) => {
      // added in reverse, so insertion order and name order disagree
      for (let i = 249; i >= 0; i--) {
        const c = `https://taxonomy.example.org/id/imported/bulk-${String(i).padStart(3, "0")}`;
        State.store.add(currentGraph(), iri(c), P("rdf:type"), P("skos:Concept"));
        State.store.add(currentGraph(), iri(c), P("skos:prefLabel"), lit("Bulk " + String(i).padStart(3, "0"), "en"));
        State.store.add(currentGraph(), iri(c), P("rdf:type"), iri(cls));
      }
    }, PERSON);
    await page.evaluate((cls) => showClass(cls), PERSON);
    await page.waitForTimeout(150);
    const labels = await page.$$eval("#tree .trow.inst .tlabel", (els) => els.map((e) => e.textContent.trim()));
    expect(labels.length).toBe(200);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(labels).toContain("Bulk 000");
    expect(labels).not.toContain("Bulk 249");
  });

  test("adding a class writes one rdf:type and shows it immediately", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "metadata");
    await page.click("#tabbody [data-addcls]");
    await A.waitModal(page, "Add a class");
    await A.pick(page, "mCls", "Organization");
    await A.modalOk(page);

    expect(await classesOf(page, MANGROVE)).toEqual([ORG]);
    expect(await A.triplesOf(page, MANGROVE)).toContainEqual([RDF + "type", ORG]);
    const chips = await page.$$eval("#detailHead [data-gotocls]", (els) => els.map((e) => e.textContent.trim()));
    expect(chips).toEqual(["Organization"]);
  });

  test("a class from outside the vocabulary keeps its own URI", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "metadata");
    await page.click("#tabbody [data-addcls]");
    await A.waitModal(page, "Add a class");
    await page.fill("#mCls", "https://schema.org/Place");
    await A.modalOk(page);
    expect(await classesOf(page, MANGROVE)).toEqual([SC + "Place"]);
  });

  test("the class dialog refuses something that is not a URI", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "metadata");
    await page.click("#tabbody [data-addcls]");
    await A.waitModal(page, "Add a class");
    await page.fill("#mCls", "just some words");
    await A.modalOk(page);
    expect((await A.alerts(page)).join(" ")).toMatch(/not a URI/i);
    expect(await A.modalOpen(page)).toBe(true);
    await A.modalCancel(page);
  });

  test("the dialog will not commit with nothing chosen", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await A.selectTab(page, "metadata");
    await page.click("#tabbody [data-addcls]");
    await A.waitModal(page, "Add a class");
    expect(await A.okDisabled(page)).toBe(true);
    await A.modalCancel(page);
  });

  test("removing a class takes that typing away and nothing else", async ({ page }) => {
    await A.clickRow(page, EX + "inst-1");
    await A.selectTab(page, "metadata");
    await page.click(`#tabbody [data-delcls="${A.cssEscape(ORGUNIT)}"]`);
    await page.waitForTimeout(150);

    expect(await classesOf(page, EX + "inst-1")).toEqual([ORG]);
    // still a concept, still labelled, still in the vocabulary
    expect(await A.allConcepts(page)).toContain(EX + "inst-1");
    expect(await page.evaluate((c) => labelText(c).plain, EX + "inst-1")).toBe("Institution one");
  });

  test("typing a concept speaks on the action, rdf and audit channels", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    const at = await page.evaluate(() => State.log.length);
    await page.evaluate(async ([c, cls]) => { await addConceptClass(c, cls); }, [MANGROVE, ORG]);
    await page.waitForTimeout(80);

    const fresh = (await A.logs(page)).slice(at);
    expect(fresh.filter((e) => e.channel === "audit")
      .map((e) => e.msg + " " + (e.code || "")).join("\n")).toMatch(/AddClass/);
    const update = fresh.filter((e) => e.channel === "rdf").map((e) => e.code || "")
      .find((c) => /INSERT/.test(c));
    expect(update).toContain(ORG);
  });

  test("the same class is not added twice", async ({ page }) => {
    await A.reveal(page, MANGROVE);
    await page.evaluate(async ([c, cls]) => { await addConceptClass(c, cls); await addConceptClass(c, cls); },
      [MANGROVE, ORG]);
    await page.waitForTimeout(80);
    expect(await classesOf(page, MANGROVE)).toEqual([ORG]);
  });
});

test.describe("What the import profile suggests for a class", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  async function openProfile(page, text) {
    await page.evaluate(() => openImportDialog());
    await A.waitModal(page, "Import");
    await page.fill("#iPaste", text);
    await page.selectOption("#iFormat", "ntriples");
    await A.modalOk(page);
    await A.waitModal(page, "Import profile");
    return page.$$eval("[data-cd]", (els) => els.map((e) => [e.dataset.cd, e.value]));
  }

  test("a class carried by concepts is suggested for keeping", async ({ page }) => {
    const got = Object.fromEntries(await openProfile(page, ENTITIES));
    expect(got[PERSON]).toBe("keep");
    expect(got[ORGUNIT]).toBe("keep");
    await A.modalCancel(page);
  });

  test("a class whose subjects are nothing else is still suggested for dropping", async ({ page }) => {
    // the shape the drop-by-default rule exists for: vendor history stubs that
    // are only ever themselves
    const PPT = "https://vendor.example.org/schema/history#";
    const stubs = [];
    for (let i = 0; i < 5; i++)
      stubs.push(`<urn:ev:${i}> <${RDF}type> <${PPT}LiteralAddRemoveHistoryEvent> .`);
    const got = Object.fromEntries(await openProfile(page, ENTITIES + "\n" + stubs.join("\n")));
    expect(got[PPT + "LiteralAddRemoveHistoryEvent"]).toBe("drop");
    expect(got[PERSON]).toBe("keep");   // and the useful ones are unaffected
    await A.modalCancel(page);
  });

  test("the profile shows which classes are carried by concepts", async ({ page }) => {
    await openProfile(page, ENTITIES);
    const body = await A.modalText(page);
    expect(body).toMatch(/On concepts/);
    await A.modalCancel(page);
  });
});

test.describe("What the import profile suggests for a property", () => {
  const AGENTS_ORCID = AG + "orcid";
  const PPT = "https://vendor.example.org/schema/history#";

  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  async function openProfile(page, text) {
    await page.evaluate(() => openImportDialog());
    await A.waitModal(page, "Import");
    await page.fill("#iPaste", text);
    await page.selectOption("#iFormat", "ntriples");
    await A.modalOk(page);
    await A.waitModal(page, "Import profile");
    return page.$$eval("[data-pd]", (els) => els.map((e) => [e.dataset.pd, e.value]));
  }

  /* Every foreign predicate in the reference export sits on a concept, and all
     of it used to be suggested for dropping — ~1,400 statements of real
     content lost by default on the one operation whose job is not to lose any. */
  test("a property carried by concepts is suggested for keeping", async ({ page }) => {
    const doc = ENTITIES + "\n" + `<${EX}author-1> <${AGENTS_ORCID}> <https://orcid.org/0000-0002-1825-0097> .`;
    const got = Object.fromEntries(await openProfile(page, doc));
    expect(got[AGENTS_ORCID]).toBe("keep");
    await A.modalCancel(page);
  });

  test("a property only on non-concept subjects is still suggested for dropping", async ({ page }) => {
    const doc = ENTITIES + "\n" + [
      `<urn:ev:1> <${RDF}type> <${PPT}LiteralAddRemoveHistoryEvent> .`,
      `<urn:ev:1> <${PPT}oldValue> "was" .`
    ].join("\n");
    const got = Object.fromEntries(await openProfile(page, doc));
    expect(got[PPT + "oldValue"]).toBe("drop");
    await A.modalCancel(page);
  });

  test("Reset to suggested restores the suggestion, not the old namespace rule", async ({ page }) => {
    const doc = ENTITIES + "\n" + `<${EX}author-1> <${AGENTS_ORCID}> <https://orcid.org/0000-0002-1825-0097> .`;
    await openProfile(page, doc);
    await page.selectOption(`[data-pd="${A.cssEscape(AGENTS_ORCID)}"]`, "drop");
    await page.click("#impResetAll");
    await page.waitForTimeout(60);
    expect(await page.$eval(`[data-pd="${A.cssEscape(AGENTS_ORCID)}"]`, (e) => e.value)).toBe("keep");
    await A.modalCancel(page);
  });
});
