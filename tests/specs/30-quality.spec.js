const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * The quality screen.
 *
 * It answers "how far along is it", which is a different question from "what
 * is wrong" — and the one this app previously had no way to answer without
 * first turning 1,621 undefined terms into 1,621 findings.
 *
 * So the thing these tests hold on to is that nothing here is a verdict:
 * coverage is reported for every language, only a language the scheme declares
 * required is a finding, and every row is a filter on the tree rather than a
 * score to improve.
 */

const openQuality = async (page) => {
  await page.evaluate(() => openQuality());
  await A.waitModal(page, "Quality");
};

test.describe("What the screen measures", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("it counts the terms in the open copy", async ({ page }) => {
    const n = (await A.allConcepts(page)).length;
    await openQuality(page);
    expect(await A.modalText(page)).toContain(n.toLocaleString());
  });

  test("a bucket with nothing in it is not shown at all", async ({ page }) => {
    /* Every term in the demo scheme has a place in the hierarchy, so the
       "no broader concept" row would be a zero — and a screen full of zeros
       reads as a list of things to fix. */
    await openQuality(page);
    const txt = await A.modalText(page);
    expect(txt).not.toMatch(/\b0 no broader concept/);
  });

  test("coverage is a proportion, and the numerator is real", async ({ page }) => {
    const out = await page.evaluate(() => {
      const { concepts, prof } = qualityProfile();
      return { total: concepts.length, defined: prof.filter((p) => p.anyDef).length,
               undefined_: prof.filter((p) => !p.anyDef).length };
    });
    expect(out.defined + out.undefined_).toBe(out.total);
    await openQuality(page);
    const bars = await page.$$eval("#modalRoot .covbar span", (e) => e.map((x) => x.style.width));
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((w) => /^\d+%$/.test(w))).toBe(true);
  });

  test("every language with a label anywhere gets a row, declared or not", async ({ page }) => {
    const langs = await page.evaluate(() => qualityProfile().langs);
    await openQuality(page);
    const txt = await A.modalText(page);
    for (const l of langs) expect(txt).toContain(l);
  });

  test("a required language is marked, and coverage in the others is not a defect", async ({ page }) => {
    await page.evaluate(async () => {
      await setLanguageRequired("es", true);
      await new Promise((r) => setTimeout(r, 30));
    });
    await openQuality(page);
    const txt = await A.modalText(page);
    expect(txt).toContain("required");
    /* The sentence that keeps this screen from being a scorecard. */
    expect(txt).toMatch(/information, not a defect/);
  });

  test("findings are grouped by rule, with what each severity means", async ({ page }) => {
    const rules = await page.evaluate(() => [...new Set(State.issues.map((i) => i.rule))]);
    await openQuality(page);
    const txt = await A.modalText(page);
    for (const r of rules) expect(txt).toContain(r);
    expect(txt).toMatch(/stops a release|worth a look|stops a save/);
  });

  test("reading it changes nothing", async ({ page }) => {
    const before = await A.quadCount(page);
    await openQuality(page);
    await A.modalCancel(page);
    expect(await A.quadCount(page)).toBe(before);
  });

  test("it says so when it is only measuring part of the vocabulary", async ({ page }) => {
    test.slow();
    const scheme = await page.evaluate(() => schemeIri());
    const { text } = A.bigSchemeTriples({ roots: 60, branches: 4, perBranch: 3, scheme });
    await A.importText(page, text, "ntriples");
    await A.useWindowedLoading(page);
    await openQuality(page);
    expect(await A.modalText(page)).toMatch(/Measured on what has been read/);
  });
});

test.describe("Every row is a way into the tree", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a bucket narrows the tree to exactly those terms", async ({ page }) => {
    await openQuality(page);
    await page.click('#modalRoot [data-qfilter="def"]');
    await page.waitForTimeout(60);
    const f = await page.evaluate(() => State.treeFilter);
    expect(f).toEqual({ mode: "missing", lang: null, prop: "def" });
    /* And the narrowing is the app's own filter, so the rows on screen are the
       ones the number counted. */
    const shown = await A.treeRows(page);
    expect(shown.length).toBeGreaterThan(0);
  });

  test("a language row narrows to the terms missing that language", async ({ page }) => {
    await openQuality(page);
    const btn = await page.$('#modalRoot [data-qlang]');
    const lang = await btn.evaluate((b) => b.dataset.qlang);
    await btn.click();
    await page.waitForTimeout(60);
    expect(await page.evaluate(() => State.treeFilter)).toEqual({ mode: "missing", lang, prop: "pref" });
  });

  test("a findings row opens the first term it is about", async ({ page }) => {
    await openQuality(page);
    const btn = await page.$('#modalRoot [data-qgo]');
    const want = await btn.evaluate((b) => b.dataset.qgo);
    await btn.click();
    await page.waitForTimeout(80);
    expect(await A.selected(page)).toBe(want);
  });

  test("the overview offers it without needing the menu", async ({ page }) => {
    await page.evaluate(() => { State.selected = null; renderDetail(); });
    await page.click('#tabbody [data-ovact="quality"]');
    await A.waitModal(page, "Quality");
    expect(await A.modalTitle(page)).toMatch(/^Quality/);
  });

  test("and a read-only account may still look", async ({ page }) => {
    /* Unlike New concept and Import, which applyEditability strips: asking how
       complete a vocabulary is takes nothing away from anybody. */
    const out = await page.evaluate(() => {
      const real = canEditHere;
      window.canEditHere = () => false;
      State.selected = null;
      try { renderDetail(); } finally { window.canEditHere = real; }
      const body = document.getElementById("tabbody");
      return { quality: !!body.querySelector('[data-ovact="quality"]'),
               newConcept: !!body.querySelector('[data-ovact="new"]') };
    });
    expect(out.quality).toBe(true);
    expect(out.newConcept).toBe(false);
  });
});

test.describe("The number and the list are the same set", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the hierarchy bucket does not count orphans and then show every root", async ({ page }) => {
    /* Measured before the fix: with one orphan the bucket read 1 and Show
       rendered 11 rows — the orphan plus the ten top concepts, every one of
       them placed exactly as intended. "Missing a broader concept" matches
       every root in the vocabulary; "missing a place in the hierarchy" does
       not, and that is the question the count was asking. */
    const orphan = await page.evaluate(() => {
      const g = currentGraph(), c = topConcepts()[0];
      State.store.match(g, iri(c), P("skos:topConceptOf"), null).slice()
        .forEach((q) => State.store.remove(g, q.s, q.p, q.o));
      return c;
    });
    const counted = await page.evaluate(() => qualityProfile().prof.filter((p) => !p.placed).length);
    expect(counted).toBe(1);

    await openQuality(page);
    await page.click('#modalRoot [data-qfilter="placed"]');
    await page.waitForTimeout(80);
    const rows = (await A.treeRows(page)).filter((r) => r.iri);
    expect(rows).toHaveLength(counted);
    expect(rows[0].iri).toBe(orphan);
  });

  test("a top concept is placed, and a term with a parent is placed", async ({ page }) => {
    const out = await page.evaluate(() => {
      const prop = treeFilterProp("placed");
      const top = topConcepts()[0];
      const kid = narrowerOf(top)[0];
      return { top: !!prop.test(top), kid: !!prop.test(kid) };
    });
    expect(out.top).toBe(true);
    expect(out.kid).toBe(true);
  });

  test("the profile is walked once, however many languages there are", async ({ page }) => {
    const out = await page.evaluate(() => {
      const { prof } = qualityProfile();
      let touched = 0;
      const watched = prof.map((p) => new Proxy(p, { get(t, k) { if (k === "anyDef") touched++; return t[k]; } }));
      /* Stand in for the profile so the dialog's own counting is what is
         measured, not qualityProfile's. */
      const real = qualityProfile;
      window.qualityProfile = () => ({ concepts: allConcepts(), prof: watched, langs: ["en", "es", "pt", "gn", "qu", "ay"] });
      try { openQuality(); } finally { window.qualityProfile = real; }
      document.getElementById("mCancel").click();
      return { touched, concepts: watched.length };
    });
    /* One read of anyDef per concept: one pass. Before the fix each of the
       four buckets and three columns per language re-filtered the whole list. */
    expect(out.touched).toBe(out.concepts);
  });
});
