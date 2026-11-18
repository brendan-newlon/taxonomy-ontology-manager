const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const FORESTS = A.sdg("forests");
const ORCID = "https://example.org/ns/agents#orcid";

/**
 * Customer feedback (2026-09-04): the Metadata tab's "In scheme" row showed
 * the app's own open-scheme placeholder rather than what the concept's real
 * skos:inScheme triples say — a real vocabulary can, and often does, declare
 * more than one scheme in one graph. See ARCHITECTURE.md §14 and
 * APP-ONTOLOGY.md for the framing.
 */
test.describe("Metadata reads the concept's real data, not the app's open scheme", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
  });

  test("In scheme / Top concept of show the concept's actual skos:inScheme, even when it differs from the open scheme", async ({ page }) => {
    // Select the concept and open Metadata *before* reassigning its scheme —
    // the reassignment makes the graph multi-scheme, and a top concept's own
    // tree row can move into a not-yet-expanded scheme group as a result
    // (the multi-scheme tree feature working as designed); re-rendering only
    // the detail pane afterward, not the tree, keeps this test about the
    // Metadata row and not about tree visibility.
    await A.reveal(page, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "metadata");
    await page.evaluate((c) => {
      const g = currentGraph();
      const other = iri("https://example.org/a-different-scheme");
      State.store.add(g, other, P("rdf:type"), P("skos:ConceptScheme"));
      State.store.add(g, other, P("skos:prefLabel"), lit("A Different Scheme", "en"));
      State.store.match(g, iri(c), P("skos:inScheme"), null)
        .forEach((q) => State.store.remove(g, q.s, q.p, q.o));
      State.store.add(g, iri(c), P("skos:inScheme"), other);
      State.load.schemesInGraph = null; State.load.schemesInGraphOf = null;
      renderDetail();
    }, FORESTS);
    const text = await page.textContent("#tabbody");
    expect(text).toContain("A Different Scheme");
    expect(text).not.toContain("plant-conservation/scheme");
  });
});

test.describe("Object editor is RDF-native: Literal or IRI, with an exclusive optional datatype/language", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await A.reveal(page, FORESTS);
    await A.clickRow(page, FORESTS);
    // This editor's own "+ Add" used to live on the Metadata tab's "Other
    // properties" section; that section is gone (seventh feedback pass —
    // the Triples tab shows everything now, so it's the only +Add left).
    await A.selectTab(page, "triples");
  });

  const valueOf = (page) => page.evaluate((c) =>
    State.store.match(currentGraph(), iri(c), iri("https://example.org/ns/agents#orcid"), null)[0].o, FORESTS);

  test("the kind selector says Literal / IRI, not text / a link to something else", async ({ page }) => {
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    const opts = await page.$$eval("#mPropKind option", (els) => els.map((e) => e.textContent.trim()));
    expect(opts).toEqual(["Literal", "IRI"]);
  });

  test("leaving datatype at its default still writes a plain untyped literal", async ({ page }) => {
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    await page.fill("#mProp", ORCID);
    await page.fill("#mPropVal", "0000-0002-1825-0097");
    await A.modalOk(page);
    const o = await valueOf(page);
    expect(o.dt).toBeFalsy();
  });

  test("choosing a datatype from the picker writes the full xsd IRI", async ({ page }) => {
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    await page.fill("#mProp", ORCID);
    await page.fill("#mPropVal", "42");
    await A.pick(page, "mPropDt", "xsd:integer");
    await A.modalOk(page);
    const o = await valueOf(page);
    expect(o.dt).toBe("http://www.w3.org/2001/XMLSchema#integer");
  });

  test("typing a datatype curie without picking it still resolves to the full IRI", async ({ page }) => {
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    await page.fill("#mProp", ORCID);
    await page.fill("#mPropVal", "42");
    await page.fill("#mPropDt", "xsd:integer");
    await A.modalOk(page);
    const o = await valueOf(page);
    expect(o.dt).toBe("http://www.w3.org/2001/XMLSchema#integer");
  });

  test("picking a datatype disables the language field", async ({ page }) => {
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    await A.pick(page, "mPropDt", "xsd:integer");
    await page.waitForTimeout(40);
    expect(await page.$eval("#mPropLang", (el) => el.disabled)).toBe(true);
  });

  test("picking a language disables the datatype field", async ({ page }) => {
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    await page.fill("#mPropLang", "es");
    await page.waitForTimeout(40);
    expect(await page.$eval("#mPropDt", (el) => el.disabled)).toBe(true);
  });

  test("switching to language after a datatype was picked clears it, once the datatype field is cleared", async ({ page }) => {
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    await A.pick(page, "mPropDt", "xsd:integer");
    await page.fill("#mPropDt", "");
    await page.waitForTimeout(40);
    expect(await page.$eval("#mPropLang", (el) => el.disabled)).toBe(false);
    await page.fill("#mPropLang", "es");
    await page.waitForTimeout(40);
    expect(await page.$eval("#mPropDt", (el) => el.value)).toBe("");
    expect(await page.$eval("#mPropDt", (el) => el.disabled)).toBe(true);
  });
});

test.describe("Triples tab: raw-RDF code view", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await A.reveal(page, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
  });

  test("toggling the code view seeds a textarea, and toggling off restores the tables", async ({ page }) => {
    expect(await page.$("#tripleRawText")).toBeNull();
    await page.click("#btnTripleRawToggle");
    expect(await page.$("#tripleRawText")).not.toBeNull();
    await page.click("#btnTripleRawToggle");
    expect(await page.$("#tripleRawText")).toBeNull();
    expect(await page.$("#tripleDirSeg")).not.toBeNull();
  });

  test("editing the raw text and saving writes exactly the diff", async ({ page }) => {
    await page.click("#btnTripleRawToggle");
    // Appended, not replaced: the seed now includes every first-degree
    // statement (labels, notes, relations included — see CLAUDE.md), so
    // wiping the whole buffer would diff as removing all of them, which
    // saveRawTriples() refuses (those predicates have their own tab). A
    // real edit here adds or changes one line and leaves the rest alone.
    const before = await page.$eval("#tripleRawText", (el) => el.value);
    await page.fill("#tripleRawText", `${before}\n<${FORESTS}> <${ORCID}> "hello" .`);
    await page.click("#btnSaveRawTriples");
    await page.waitForTimeout(150);
    const vals = await page.evaluate((c) =>
      State.store.match(currentGraph(), iri(c), iri("https://example.org/ns/agents#orcid"), null).map((q) => q.o.v),
      FORESTS);
    expect(vals).toEqual(["hello"]);
  });

  test("a malformed edit is blocked with an inline error, and writes nothing", async ({ page }) => {
    await page.click("#btnTripleRawToggle");
    const before = await page.evaluate((c) => State.store.match(currentGraph(), iri(c), null, null).length, FORESTS);
    await page.fill("#tripleRawText", "this is not turtle at all {{{");
    await page.click("#btnSaveRawTriples");
    await page.waitForTimeout(80);
    expect(await page.textContent("#tripleRawErr")).not.toBe("");
    const after = await page.evaluate((c) => State.store.match(currentGraph(), iri(c), null, null).length, FORESTS);
    expect(after).toBe(before);
  });

  test("clearing an existing statement's line and saving removes it", async ({ page }) => {
    await page.click("#btnAddTripleOut");
    await A.waitModal(page, "Add a property");
    await page.fill("#mProp", ORCID);
    await page.fill("#mPropVal", "0000-0002-1825-0097");
    await A.modalOk(page);
    await page.click("#btnTripleRawToggle");
    const seeded = await page.$eval("#tripleRawText", (el) => el.value);
    expect(seeded).toContain("0000-0002-1825-0097");
    // Re-serializes the same seed minus the one triple under test, rather
    // than editing the rendered text by hand: serializeTurtle() groups every
    // predicate for one subject into a single `;`-joined statement, so a
    // naive line-level removal can leave a dangling `;` or a missing final
    // `.` depending on where in that list the removed line happens to fall.
    const withoutOrcid = await page.evaluate(() =>
      serializeTurtle(TRIPLES_RAW_SEED.filter((q) => q.p.v !== "https://example.org/ns/agents#orcid"), false));
    await page.fill("#tripleRawText", withoutOrcid);
    await page.click("#btnSaveRawTriples");
    await page.waitForTimeout(150);
    const vals = await page.evaluate((c) =>
      State.store.match(currentGraph(), iri(c), iri("https://example.org/ns/agents#orcid"), null), FORESTS);
    expect(vals).toEqual([]);
  });
});

test.describe("Triples tab, without permission to write", () => {
  test("no Add/Save/toggle controls appear, but the code view is still readable", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await page.evaluate(() => { canEditHere = () => false; });
    await A.reveal(page, FORESTS);
    await A.clickRow(page, FORESTS);
    await A.selectTab(page, "triples");
    expect(await page.$("#btnAddTripleOut")).toBeNull();
    expect(await page.$("#btnSaveRawTriples")).toBeNull();
    // the toggle itself is not edit-gated — a read-only session can still look
    expect(await page.$("#btnTripleRawToggle")).not.toBeNull();
    await page.click("#btnTripleRawToggle");
    expect(await page.$eval("#tripleRawText", (el) => el.readOnly)).toBe(true);
  });
});

test.describe("URI templates: build the pattern in parts", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await page.evaluate(() => openUriTemplates());
    await A.waitModal(page, "URI templates");
  });

  test("Build in parts renders the current pattern as one chip per token/literal run", async ({ page }) => {
    const before = await page.$eval("#tDefault", (el) => el.value);
    expect(before).toBe("{base}{domain}/{class}/{localId}");
    await page.click('[data-parts-toggle="tDefault"]');
    const kinds = await page.$$eval("#tDefault_parts .tpl-part select:first-child",
      (els) => els.map((e) => e.value));
    expect(kinds).toEqual(["var", "var", "text", "var", "text", "var"]);
  });

  test("editing a chip writes straight back into the text field", async ({ page }) => {
    await page.click('[data-parts-toggle="tDefault"]');
    const rows = await page.$$("#tDefault_parts .tpl-part");
    // the third chip (index 2) is the literal "/" between {domain} and {class}
    await rows[2].$eval("input[type=text]", (el) => { el.value = "--"; el.dispatchEvent(new Event("input")); });
    await page.waitForTimeout(20);
    expect(await page.$eval("#tDefault", (el) => el.value)).toBe("{base}{domain}--{class}/{localId}");
  });

  test("adding a part grows the pattern, and the instance-identifier variable is labelled clearly", async ({ page }) => {
    await page.click('[data-parts-toggle="tDefault"]');
    const labels = await page.$$eval("#tDefault_parts select:not(:first-child) option",
      (els) => els.map((e) => e.textContent));
    expect(labels).toContain("instance identifier");
    await page.click("#tDefault_parts [data-padd]");
    const count = await page.$$eval("#tDefault_parts .tpl-part", (els) => els.length);
    expect(count).toBe(7);
  });
});

/**
 * A per-class override used to be written as an anonymous
 * `[ tax:forClass ... ; tax:pattern ... ]` node — a real blank node,
 * against this project's own no-blank-node rule (ARCHITECTURE.md §11.1) —
 * and the save never cleaned up an old override either. See
 * APP-ONTOLOGY.md's URI-minting worked example for the corrected shape.
 */
test.describe("URI templates: per-class overrides never use a blank node", () => {
  test("saving one logs a deterministic <tax:uriTemplateFor/{class}> resource, not a blank node", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await page.evaluate(() => openUriTemplates());
    await A.waitModal(page, "URI templates");
    await page.fill("#tc_concept", "{base}{domain}/concept/{localId}");
    await A.modalOk(page);
    const sparql = (await A.logs(page, "rdf")).map((e) => e.code || "").join("\n");
    // no anonymous-node shorthand anywhere in the real, sent SPARQL
    expect(sparql).not.toMatch(/\[\s/);
    expect(sparql).toContain("https://stardog.com/taxonomy/vocab#uriTemplateFor/concept");
    expect(sparql).toContain("https://stardog.com/taxonomy/vocab#forClass");
    expect(sparql).toContain("https://stardog.com/taxonomy/vocab#pattern");
    expect(sparql).toContain("{base}{domain}/concept/{localId}");
    // it's a real guarded write now, not a display-only string next to a
    // local-only mutation — it goes through commit()/Backend.apply(), and
    // actually lands in the store (mock mode's stand-in for the server)
    const stored = await page.evaluate(() =>
      State.store.match(G.config, iri("https://stardog.com/taxonomy/vocab#uriTemplateFor/concept"), P("tax:pattern"), null));
    expect(stored.map((q) => q.o.v)).toEqual(["{base}{domain}/concept/{localId}"]);
  });

  test("resaving with a different pattern removes the old override's own triples, not just the link to it", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await page.evaluate(() => openUriTemplates());
    await A.waitModal(page, "URI templates");
    await page.fill("#tc_concept", "{base}{domain}/concept/{localId}");
    await A.modalOk(page);
    await page.evaluate(() => openUriTemplates());
    await A.waitModal(page, "URI templates");
    await page.fill("#tc_concept", "{base}{domain}/c/{localId}");
    await A.modalOk(page);
    const found = await page.evaluate(() =>
      State.store.match(G.config, iri("https://stardog.com/taxonomy/vocab#uriTemplateFor/concept"), P("tax:pattern"), null));
    expect(found.map((q) => q.o.v)).toEqual(["{base}{domain}/c/{localId}"]);
  });
});
