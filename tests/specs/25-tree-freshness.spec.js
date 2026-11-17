const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * The tree shows what you just did to it.
 *
 * Every editing gesture in this app ends at `commit()`, which re-renders the
 * tree — so "the tree went stale" is never a missing render call. It is the
 * tree rendering correctly and the row still not being there, and the way that
 * happens is a cap. A big vocabulary's roots are folded into one bucket that
 * shows the first 500 by name; the class view lists the first 200 of a kind.
 * Create a concept whose label sorts past the cap and the detail pane opens a
 * concept the tree does not have — which reads exactly like the save failing.
 *
 * The demo scheme is far too small to reach either cap, which is why this went
 * unnoticed: it only appears on a vocabulary the size of the ones this app was
 * built for. So the windowed cases below build one.
 */

const BIG = { roots: 600, branches: 12, perBranch: 8, depth: 4 };
const ns = A.EX + "big/concept/";
const root = (n) => `${ns}root-${String(n).padStart(4, "0")}`;

async function bootBig(page) {
  await A.boot(page, { scheme: "plant-conservation" });
  const scheme = await page.evaluate(() => schemeIri());
  const { text } = A.bigSchemeTriples({ ...BIG, scheme });
  await A.importText(page, text, "ntriples");
  await A.useWindowedLoading(page);
}

/** Create a concept the way the New concept dialog does, and wait for the write. */
async function newConcept(page, label, parent) {
  await page.evaluate((p) => newConceptPrompt(p), parent === undefined ? "" : parent);
  await A.waitModal(page, "New concept");
  await page.fill("#mText", label);
  await A.modalOk(page);
  await page.waitForFunction(
    (t) => !!State.selected && labelText(State.selected).plain === t, label, { timeout: 15_000 });
  return page.evaluate(() => State.selected);
}

test.describe("What the tree shows after an edit", () => {
  test.describe("a vocabulary small enough to draw whole", () => {
    test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

    test("a new top concept is on screen straight away", async ({ page }) => {
      const c = await newConcept(page, "Probe Top");
      expect(await A.treeHas(page, c)).toBe(true);
      expect((await A.treeRow(page, c)).selected).toBe(true);
    });

    test("a new narrower concept is on screen under the concept it was put under", async ({ page }) => {
      const parent = await page.evaluate(() => allConcepts()[0]);
      const c = await newConcept(page, "Probe Narrower", parent);
      const kids = await A.treeChildren(page, parent);
      expect(kids.map((k) => k.iri)).toContain(c);
    });

    test("the + button puts it under whatever is selected", async ({ page }) => {
      const parent = await page.evaluate(() => allConcepts()[0]);
      await page.evaluate((p) => selectConcept(p), parent);
      await page.evaluate(() => document.getElementById("btnNewConcept").click());
      await A.waitModal(page, "New concept");
      expect(await page.evaluate(() => pickerValue("mBroader"))).toBe(parent);
    });

    test("renaming changes the row, and moves it to where the new name sorts", async ({ page }) => {
      const c = await newConcept(page, "Probe Aaa");
      const before = (await A.treeRoots(page)).findIndex((r) => r.iri === c);
      await page.evaluate((x) => {
        const l = xlLabels(x, "prefLabel")[0];
        editLabel(x, l.labelIri || l.key, "prefLabel", l.lang, l.text, "Zzz Probe Renamed");
      }, c);
      await page.waitForFunction(
        (x) => labelText(x).plain === "Zzz Probe Renamed", c, { timeout: 15_000 });
      const row = await A.treeRow(page, c);
      expect(row.label).toBe("Zzz Probe Renamed");
      // "Zzz…" sorts after "Probe…", so the row is further down than it was
      const after = (await A.treeRoots(page)).findIndex((r) => r.iri === c);
      expect(after).toBeGreaterThan(before);
    });

    test("deprecating shows on the row without re-opening the vocabulary", async ({ page }) => {
      const c = await newConcept(page, "Probe Doomed");
      await page.evaluate((x) => deprecatePrompt(x), c);
      await A.waitModal(page, "Deprecate concept");
      await A.modalOk(page);
      await page.waitForFunction((x) => lifecycle(x) === "deprecated", c, { timeout: 15_000 });
      expect((await A.treeRow(page, c)).flags).toContain("dep");
    });
  });

  test.describe("a vocabulary big enough to be capped", () => {
    test.slow();
    test.beforeEach(async ({ page }) => { await bootBig(page); });

    test("the roots really are capped, or this proves nothing", async ({ page }) => {
      expect(await page.evaluate(() => topConcepts().length)).toBeGreaterThan(500);
      expect(await A.treeRoots(page)).toHaveLength(500);       // one ROOT_PAGE
    });

    test("every root is a root — there is no invented parent above any of them", async ({ page }) => {
      /* A top concept with no narrower terms used to be folded into a bucket
         called "Not placed under anything", which is a rendering budget
         wearing a taxonomic label: the data says only that it is a top
         concept. Childless roots sit in the same alphabetical list as the
         rest, at the same depth. */
      const rows = await A.treeRows(page);
      expect(rows.every((r) => r.depth === 0)).toBe(true);
      expect(rows.some((r) => r.unfiled)).toBe(false);
      expect(await page.textContent("#tree")).not.toMatch(/Not placed under anything/);
      // and the list really does hold both kinds
      expect(rows.some((r) => r.leaf)).toBe(true);
      expect(rows.some((r) => !r.leaf)).toBe(true);
    });

    test("a new top concept sorting past the cap is still on screen", async ({ page }) => {
      /* "Zzz" sorts after all 600 "Root NNNN" rows, so it falls off the end of
         the 500-row page — the case the small scheme cannot reach. */
      const c = await newConcept(page, "Zzz Probe Late");
      expect(await A.treeHas(page, c)).toBe(true);
      expect((await A.treeRow(page, c)).selected).toBe(true);
      /* Where it sorts, not lifted to the top: "Zzz" is last, so it is the
         last row in the list rather than the first. */
      const roots = await A.treeRoots(page);
      expect(roots[roots.length - 1].iri).toBe(c);
    });

    test("a new top concept sorting inside the cap is on screen too", async ({ page }) => {
      const c = await newConcept(page, "Aaa Probe Early");
      expect(await A.treeHas(page, c)).toBe(true);
    });

    test("the list says how many it is holding back, once", async ({ page }) => {
      const text = await page.textContent("#tree");
      expect(text).toMatch(/Showing 500 of [\d,]+ top concepts/);
      /* Two lines used to say this — one for the render page, one for
         windowed mode's server-side root page — which is a distinction
         nobody looking at a tree is making. */
      expect(text.match(/Showing [\d,]+ of/g)).toHaveLength(1);
    });

    test("and stops saying it once there is nothing held back", async ({ page }) => {
      /* Reaching a term that sorts last draws everything before it, so the
         line has nothing left to report. Saying "showing 612 of 612" would be
         a control that does nothing. */
      await newConcept(page, "Zzz Probe Late");
      expect(await page.textContent("#tree")).not.toMatch(/Showing [\d,]+ of/);
    });

    test("Show more lengthens the list without inventing a category", async ({ page }) => {
      await page.click("#btnMoreRoots");
      await page.waitForFunction(() =>
        document.querySelectorAll("#tree .trow").length > 500, null, { timeout: 20_000 });
      const rows = await A.treeRows(page);
      expect(rows.length).toBeGreaterThan(500);
      expect(rows.every((r) => r.depth === 0)).toBe(true);
    });

    test("a new narrower concept appears under a branch that was fetched", async ({ page }) => {
      await A.toggle(page, root(0));
      await page.waitForFunction((p) => State.load.childrenOf.has(p), root(0), { timeout: 20_000 });
      const c = await newConcept(page, "Zzz Probe Child", root(0));
      const kids = await A.treeChildren(page, root(0));
      expect(kids.map((k) => k.iri)).toContain(c);
    });
  });

  test.describe("what a page of roots is a page of", () => {
    test.slow();
    test.beforeEach(async ({ page }) => {
      await A.boot(page, { scheme: "plant-conservation" });
      const scheme = await page.evaluate(() => schemeIri());
      await A.importText(page, A.bigSchemeTriples({ ...BIG, scheme }).text, "ntriples");
      /* Full mode on purpose: windowed mode answers a filter by scanning the
         server, so only this path pages a filtered list locally. */
    });

    /** Make one late-sorting root the only term missing a definition. */
    const onlyMatchIsLast = (page) => page.evaluate(() => {
      const g = currentGraph();
      const roots = topConcepts().sort((a, b) => labelText(a).plain.localeCompare(labelText(b).plain));
      const last = roots[roots.length - 1];
      State.store.match(g, null, P("skos:definition"), null)
        .forEach((q) => State.store.remove(g, q.s, q.p, q.o));
      roots.forEach((c) => { if (c !== last) State.store.add(g, iri(c), P("skos:definition"), lit("d", "en")); });
      State.treeFilter = { mode: "missing", lang: null, prop: "def" };
      State.selected = null;
      renderTree();
      return { last, rootCount: roots.length };
    });

    test("a filtered page is a page of matches, not of the first 500 roots", async ({ page }) => {
      /* The cap used to be applied to the raw root order, so a term matching
         the filter under root 600 could not be reached at all — and the
         filter is how anyone finds a term in a vocabulary this size. */
      const { last, rootCount } = await onlyMatchIsLast(page);
      expect(rootCount).toBeGreaterThan(500);
      expect(await A.treeHas(page, last)).toBe(true);
    });

    test("and filtering does not throw", async ({ page }) => {
      /* `roots.filter(subtreeMatches)` handed the array index to the recursion
         guard, which threw on every filtered render. */
      await onlyMatchIsLast(page);
      expect(page.__errors).toEqual([]);
      expect(await page.$$("#tree .trow")).not.toHaveLength(0);
    });

    test("a filtered list holding nothing back says nothing about paging", async ({ page }) => {
      await onlyMatchIsLast(page);
      const text = await page.textContent("#tree");
      expect(text).not.toMatch(/Showing [\d,]+ of/);
    });

    test("how far the list was opened is not remembered across vocabularies", async ({ page }) => {
      /* It lived in State.ui, which is written to localStorage whole — so
         "I pressed Show more four times" was remembered forever, on every
         vocabulary, and the next session opened by drawing 2,000 root rows
         synchronously. That is the stall the page exists to prevent.
         ROOTS_SHOWN_BY (a Map, keyed by graph + scheme + filter) replaced the
         single ROOTS_SHOWN scalar once a graph could hold more than one
         scheme's own root list — a different graph is simply a different
         key, so nothing needs to be reset by hand. */
      await page.evaluate(() => {
        ROOTS_SHOWN_BY.set(`${currentGraph()}|${schemeIri()}|all|pref|`, 4000);
      });
      await A.switchScheme(page, "subject-facet");
      const stale = await page.evaluate(() => {
        const g = currentGraph();
        return [...ROOTS_SHOWN_BY.entries()].some(([k, v]) => k.startsWith(g + "|") && v === 4000);
      });
      expect(stale).toBe(false);
    });

    test("and is not written to the browser", async ({ page }) => {
      await page.evaluate(() => {
        ROOTS_SHOWN_BY.set(`${currentGraph()}|${schemeIri()}|all|pref|`, 4000);
        try { localStorage.setItem("tax.ui", JSON.stringify(State.ui)); } catch (_) {}
      });
      const saved = await page.evaluate(() => localStorage.getItem("tax.ui") || "");
      expect(saved).not.toMatch(/rootsShown|ROOTS_SHOWN|4000/);
    });

    test("changing the filter starts the list again", async ({ page }) => {
      await page.evaluate(() => {
        ROOTS_SHOWN_BY.set(`${currentGraph()}|${schemeIri()}|all|pref|`, 4000);
        renderTree();
      });
      const forNewFilter = await page.evaluate(() => {
        State.treeFilter = { mode: "missing", lang: null, prop: "def" };
        renderTree();
        return ROOTS_SHOWN_BY.get(`${currentGraph()}|${schemeIri()}|missing|def|`);
      });
      expect(forNewFilter).toBeUndefined();
    });
  });

  test("in the class view, the selected concept is on the page whatever the cap", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const held = await page.evaluate(() => {
      /* One class with more instances than the view will draw, and the one we
         care about last by name. */
      const cls = "https://taxonomy.example.org/id/probe/Kind";
      const g = currentGraph();
      const made = [];
      for (let i = 0; i < 205; i++) {
        const c = `${cls}/inst-${String(i).padStart(3, "0")}`;
        State.store.add(g, iri(c), P("rdf:type"), P("skos:Concept"));
        State.store.add(g, iri(c), P("rdf:type"), iri(cls));
        State.store.add(g, iri(c), P("skos:prefLabel"), lit(`Inst ${String(i).padStart(3, "0")}`, "en"));
        made.push(c);
      }
      const last = `${cls}/zzz-last`;
      State.store.add(g, iri(last), P("rdf:type"), P("skos:Concept"));
      State.store.add(g, iri(last), P("rdf:type"), iri(cls));
      State.store.add(g, iri(last), P("skos:prefLabel"), lit("Zzz Last One", "en"));
      State.treeMode = "classes";
      State.expanded.add(cls);
      State.ui.openClass = cls;
      State.selected = last;
      renderTree();
      return last;
    });
    expect(await A.treeHas(page, held)).toBe(true);
    /* And the note under it never contradicts the rows. It used to hardcode the
       cap, so a page stretched to reach the selected term was described as "the
       first 200" while more than 200 rows were on screen — the exact
       silent-cap problem the note exists to avoid. Reaching the last term by
       name draws everything, so the honest answer here is no note at all. */
    const drawn = await page.$$eval("#tree .trow.inst", (e) => e.length);
    const m = /The first ([\d,]+) of ([\d,]+), by name/.exec(await page.textContent("#tree"));
    if (m) expect(Number(m[1].replace(/,/g, ""))).toBe(drawn);
    else expect(drawn).toBe(await page.evaluate(() => classInstances(State.ui.openClass).length));
  });

  test("in the class view, a capped list says how many it drew", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const drawn = await page.evaluate(() => {
      const cls = "https://taxonomy.example.org/id/probe/Kind";
      const g = currentGraph();
      for (let i = 0; i < 260; i++) {
        const c = `${cls}/inst-${String(i).padStart(3, "0")}`;
        State.store.add(g, iri(c), P("rdf:type"), P("skos:Concept"));
        State.store.add(g, iri(c), P("rdf:type"), iri(cls));
        State.store.add(g, iri(c), P("skos:prefLabel"), lit(`Inst ${String(i).padStart(3, "0")}`, "en"));
      }
      State.treeMode = "classes";
      State.expanded.add(cls);
      State.ui.openClass = cls;
      State.selected = `${cls}/inst-000`;        // sorts first, so the page is not stretched
      renderTree();
      return document.querySelectorAll("#tree .trow.inst").length;
    });
    const m = /The first ([\d,]+) of ([\d,]+), by name/.exec(await page.textContent("#tree"));
    expect(m).toBeTruthy();
    expect(Number(m[1].replace(/,/g, ""))).toBe(drawn);
    expect(Number(m[2].replace(/,/g, ""))).toBeGreaterThan(drawn);
  });
});
