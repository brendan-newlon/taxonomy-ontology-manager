const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * RDF/XML in.
 *
 * Export has written it for a long time and import refused it, which made the
 * app a one-way door for the format a great many SKOS vocabularies are still
 * published as. The strongest evidence that reading it works is that the app's
 * own writer and reader agree on the whole demo vocabulary, so that is the
 * first test; the rest cover the spellings a hand-written or foreign file uses
 * that our writer never emits.
 */

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const SKOS = "http://www.w3.org/2004/02/skos/core#";

const parse = (page, xml) => page.evaluate((x) => parseRdfXml(x), xml);
const triples = (rows) => rows.filter((r) => r.s).map((r) =>
  [r.s.v, r.p.v, r.o.t === "iri" ? r.o.v : `"${r.o.v}"${r.o.lang ? "@" + r.o.lang : ""}`].join(" "));

const doc = (body, attrs) => `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="${RDF}" xmlns:skos="${SKOS}"
         xmlns:owl="http://www.w3.org/2002/07/owl#"
         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"${attrs || ""}>
${body}
</rdf:RDF>`;

test.describe("Reading RDF/XML", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("what the app writes, the app reads back — every triple of it", async ({ page }) => {
    const { xml, expected } = await page.evaluate(() => {
      const quads = exportQuads("scheme", false, false);
      return { xml: serializeRdfXml(quads), expected: quads.length };
    });
    expect(expected).toBeGreaterThan(1000);          // the whole demo scheme, not a corner of it
    const rows = await parse(page, xml);
    expect(rows.filter((r) => r.error)).toEqual([]);
    expect(rows.filter((r) => r.s).length).toBe(expected);
  });

  test("a round trip keeps the same statements, not just the same count", async ({ page }) => {
    const same = await page.evaluate(() => {
      const key = (q) => `${q.s.v}|${q.p.v}|${q.o.t}|${q.o.v}|${q.o.lang || ""}|${q.o.dt || ""}`;
      const before = exportQuads("scheme", false, false);
      const after = parseRdfXml(serializeRdfXml(before)).filter((r) => r.s);
      const a = new Set(before.map(key)), b = new Set(after.map(key));
      return {
        missing: [...a].filter((x) => !b.has(x)).slice(0, 5),
        extra: [...b].filter((x) => !a.has(x)).slice(0, 5)
      };
    });
    expect(same.missing).toEqual([]);
    expect(same.extra).toEqual([]);
  });

  test("a typed node element is a subject and its own rdf:type", async ({ page }) => {
    const rows = await parse(page, doc(
      `<skos:Concept rdf:about="http://x.example/a">
         <skos:prefLabel xml:lang="es">Bosques</skos:prefLabel>
       </skos:Concept>`));
    expect(triples(rows)).toEqual([
      `http://x.example/a ${RDF}type ${SKOS}Concept`,
      `http://x.example/a ${SKOS}prefLabel "Bosques"@es`
    ]);
  });

  test("xml:lang is inherited, and a nearer one wins", async ({ page }) => {
    const rows = await parse(page, doc(
      `<rdf:Description rdf:about="http://x.example/a">
         <skos:prefLabel>Florestas</skos:prefLabel>
         <skos:altLabel xml:lang="fr">Forets</skos:altLabel>
       </rdf:Description>`, ` xml:lang="pt"`));
    expect(rows.filter((r) => r.s).map((r) => r.o.lang)).toEqual(["pt", "fr"]);
  });

  test("relative references resolve against xml:base", async ({ page }) => {
    const rows = await parse(page, doc(
      `<skos:Concept rdf:ID="trees"><skos:broader rdf:resource="plants"/></skos:Concept>`,
      ` xml:base="http://base.example/voc/"`));
    expect(triples(rows)).toContain(
      `http://base.example/voc/#trees ${SKOS}broader http://base.example/voc/plants`);
  });

  test("a relative reference with no base is kept as written, and said so", async ({ page }) => {
    const rows = await parse(page, doc(
      `<skos:Concept rdf:about="http://x.example/a"><skos:broader rdf:resource="plants"/></skos:Concept>`));
    expect(triples(rows)).toContain(`http://x.example/a ${SKOS}broader plants`);
    expect(rows.filter((r) => r.error).map((r) => r.error).join(" ")).toMatch(/relative/i);
  });

  test("property attributes are statements too", async ({ page }) => {
    const rows = await parse(page, doc(
      `<skos:Concept rdf:about="http://x.example/a" skos:notation="A.1"/>`));
    expect(triples(rows)).toContain(`http://x.example/a ${SKOS}notation "A.1"`);
  });

  test("a nested node element is the object of the property above it", async ({ page }) => {
    const rows = await parse(page, doc(
      `<skos:Concept rdf:about="http://x.example/a">
         <skos:narrower><skos:Concept rdf:about="http://x.example/b"/></skos:narrower>
       </skos:Concept>`));
    const t = triples(rows);
    expect(t).toContain(`http://x.example/a ${SKOS}narrower http://x.example/b`);
    expect(t).toContain(`http://x.example/b ${RDF}type ${SKOS}Concept`);
  });

  test("an anonymous node arrives as a blank node, for skolemising like any other", async ({ page }) => {
    const rows = await parse(page, doc(
      `<rdfs:Class rdf:about="http://x.example/C">
         <rdfs:subClassOf rdf:parseType="Resource">
           <owl:onProperty rdf:resource="http://x.example/p"/>
         </rdfs:subClassOf>
       </rdfs:Class>`));
    expect(rows.filter((r) => r.s && r.o.t === "bnode").length).toBe(1);
    expect(rows.filter((r) => r.s && r.s.t === "bnode").length).toBe(1);
  });

  test("a datatype on a literal survives", async ({ page }) => {
    const rows = await parse(page, doc(
      `<rdf:Description rdf:about="http://x.example/a">
         <skos:notation rdf:datatype="http://www.w3.org/2001/XMLSchema#string">A.1</skos:notation>
       </rdf:Description>`));
    expect(rows[0].o.dt).toBe("http://www.w3.org/2001/XMLSchema#string");
    expect(rows[0].o.lang).toBeFalsy();
  });

  test("something that is not RDF says so rather than importing nothing quietly", async ({ page }) => {
    const rows = await parse(page, "<html><body><p>not rdf</p></body></html>");
    expect(rows.filter((r) => r.error).length).toBeGreaterThan(0);
  });

  test("a file the browser cannot parse is reported as bad XML", async ({ page }) => {
    const rows = await parse(page, "<rdf:RDF><unclosed>");
    expect(rows.map((r) => r.error).join(" ")).toMatch(/not valid XML/);
  });
});

test.describe("Importing an RDF/XML file end to end", () => {
  test("the format is offered, detected, and the concepts land", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const before = (await A.allConcepts(page)).length;
    const xml = doc(
      `<skos:Concept rdf:about="https://taxonomy.example.org/id/imported/xml-one">
         <skos:prefLabel xml:lang="en">From an XML file</skos:prefLabel>
       </skos:Concept>`);

    await page.evaluate(() => openImportDialog());
    await page.waitForSelector("#iFormat");
    expect(await page.$$eval("#iFormat option", (e) => e.map((o) => o.value))).toContain("rdfxml");
    await page.click("#mCancel");

    // and auto-detected, by name and by content, without being told
    expect(await page.evaluate((x) => sniffFormat("vocab.rdf", x), xml)).toBe("rdfxml");
    expect(await page.evaluate((x) => sniffFormat("", x), xml)).toBe("rdfxml");

    await A.importText(page, xml, "rdfxml");
    expect((await A.allConcepts(page)).length).toBe(before + 1);
    expect(await A.conceptByLabel(page, "From an XML file")).toBeTruthy();
  });
});
