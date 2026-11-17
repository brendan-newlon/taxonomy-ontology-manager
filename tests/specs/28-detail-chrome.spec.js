const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * Things the interface said that were not worth saying, or were not true.
 *
 * Four of them, all found by looking at one term. The header read
 * "draft  draft  OrgUnit" — the same word twice, meaning two different things,
 * neither labelled. The Graph tab was headed "Context · 2 links, one step
 * away", which named a category the two things did not share, on a tab already
 * called Graph, describing a depth nothing can change. The right rail carried
 * a revision counter and a count of "billable calls". And the overview
 * reported 166 "unplaced terms" on a facet that is legitimately flat.
 *
 * The last one is the same mistake as the tree's old "Not placed under
 * anything" bucket, one screen over: a shape reported as a defect. Where a
 * choice is editorial rather than structural, the app reports and lets a team
 * decide.
 */

test.describe("The header of a term", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "subject-facet" }); });

  const meta = (page) => page.$eval(".detail-meta", (e) => e.textContent.replace(/\s+/g, " ").trim());
  const open = (page, c) => page.evaluate((x) => selectConcept(x), c);
  const someTerm = (page) => page.evaluate(() => allConcepts()[0]);

  test("says the term's status once, and not the tier as well", async ({ page }) => {
    const c = await someTerm(page);
    await open(page, c);
    const text = await meta(page);
    /* Which tier is open is a view setting, not a fact about this term, and it
       is already in the tier picker and the status line. Beside the term's own
       lifecycle status it made a second "draft" that meant something else. */
    const status = await page.evaluate((x) => lifecycle(x), c);
    expect(text.split(" ").filter((w) => w === status)).toHaveLength(1);
    expect(await page.$$(".detail-meta .pill")).not.toHaveLength(0);
  });

  test("the status word carries what it means", async ({ page }) => {
    await open(page, await someTerm(page));
    const st = await page.evaluate(() => lifecycle(State.selected));
    const title = await page.$eval(".detail-meta .pill", (e) => e.getAttribute("title") || "");
    /* The phrase and nothing else: it used to be prefixed "Where this term has
       got to: nobody has proposed it for review yet", which is a sentence
       about a sentence. */
    expect(title).toBe(await page.evaluate((k) => LIFECYCLE_MEANS[k], st));
    expect(title).not.toMatch(/^Where this term/);
    expect(title.length).toBeGreaterThan(15);          // a phrase, not the word again
  });

  test("every status the app can show has an explanation", async ({ page }) => {
    const missing = await page.evaluate(() =>
      ["draft", "proposed", "approved", "deprecated"].filter((k) => !LIFECYCLE_MEANS[k]));
    expect(missing).toEqual([]);
  });

  test("a class is still shown, because that is what kind of thing it is", async ({ page }) => {
    /* The reported term was an OrgUnit. No demo scheme carries a class, so
       this makes one: what was wrong with that header was the duplicated
       "draft", not the kind. */
    const c = await page.evaluate(() => {
      const x = allConcepts()[0];
      State.store.add(currentGraph(), iri(x), P("rdf:type"), iri("http://example.org/org#OrgUnit"));
      selectConcept(x);
      return x;
    });
    expect(c).toBeTruthy();
    const pills = await page.$$eval(".detail-meta .pill.cls", (e) => e.map((x) => x.textContent.trim()));
    expect(pills).toContain("OrgUnit");
    // and it is the kind, next to one status word, not a second status
    const text = await meta(page);
    expect(text).toMatch(/OrgUnit/);
  });
});

test.describe("The Graph tab", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "subject-facet" }); });

  const openGraph = async (page, c) => {
    await page.evaluate((x) => { selectConcept(x); State.tab = "graph"; renderDetail(); }, c);
    await page.waitForSelector("svg.graph", { timeout: 10_000 });
  };

  test("has no heading counting links and steps", async ({ page }) => {
    const c = await page.evaluate(() => allConcepts().find((x) => narrowerOf(x).length >= 3));
    await openGraph(page, c);
    const text = await page.textContent("#tabbody");
    expect(text).not.toMatch(/one step away/);
    expect(text).not.toMatch(/\d+ links?,/);
    /* The legend stays: naming each kind of line is the part worth saying. */
    expect(await page.$$(".glegend .gkey")).not.toHaveLength(0);
  });

  test("no two nodes are drawn on top of each other, anywhere in the vocabulary",
    async ({ page }) => {
      /* Measured before the fix: a term with six narrower concepts drew
         "Access to Education" over "Adaptive Learning". The old rule put nodes
         on one of three rings by index, which spreads them out on average and
         guarantees nothing. */
      const bad = await page.evaluate(() => {
        const out = [];
        const box = (r) => ({
          x: +r.getAttribute("x"), y: +r.getAttribute("y"),
          w: +r.getAttribute("width"), h: +r.getAttribute("height")
        });
        for (const c of allConcepts()) {
          const d = document.createElement("div");
          d.innerHTML = tabGraph(c);
          const rects = [...d.querySelectorAll("svg.graph .gnode rect")].map(box);
          if (rects.length < 2) continue;
          for (let a = 0; a < rects.length; a++) {
            for (let b = a + 1; b < rects.length; b++) {
              const A2 = rects[a], B = rects[b];
              if (A2.x < B.x + B.w && B.x < A2.x + A2.w &&
                  A2.y < B.y + B.h && B.y < A2.y + A2.h) { out.push(labelText(c).plain); break; }
            }
          }
        }
        return [...new Set(out)];
      });
      expect(bad).toEqual([]);
    });

  test("and nothing is drawn outside the picture", async ({ page }) => {
    const bad = await page.evaluate(() => {
      const out = [];
      for (const c of allConcepts()) {
        const d = document.createElement("div");
        d.innerHTML = tabGraph(c);
        for (const r of d.querySelectorAll("svg.graph .gnode rect")) {
          const x = +r.getAttribute("x"), y = +r.getAttribute("y");
          const w = +r.getAttribute("width"), h = +r.getAttribute("height");
          if (x < 0 || y < 0 || x + w > GRAPH_W || y + h > GRAPH_H) { out.push(labelText(c).plain); break; }
        }
      }
      return [...new Set(out)];
    });
    expect(bad).toEqual([]);
  });

  test("the same term draws the same picture every time", async ({ page }) => {
    const same = await page.evaluate(() => {
      const c = allConcepts().find((x) => narrowerOf(x).length >= 4);
      return tabGraph(c) === tabGraph(c);
    });
    expect(same).toBe(true);
  });
});

test.describe("The right rail", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("does not show a revision counter", async ({ page }) => {
    const text = await page.textContent("#paneRight");
    /* A number nobody using this app can act on: it names no version anyone
       could ask for, and the guarded writes it belongs to are the app's
       business. It is still in the console under `internal`. */
    expect(text).not.toMatch(/\brev\b/i);
  });

  test("counts queries, not billable calls", async ({ page }) => {
    await page.evaluate(() => { State.ui.sessionOpen = true; renderCtx(); });
    const text = await page.textContent("#paneRight");
    expect(text).not.toMatch(/billable/i);
    expect(text).toMatch(/quer(y|ies) so far/);
  });
});

test.describe("What the overview calls a backlog", () => {
  test("a term with nothing under it is not a defect", async ({ page }) => {
    await A.boot(page, { scheme: "subject-facet" });
    await page.evaluate(() => { State.selected = null; renderDetail(); });
    const text = await page.textContent("#tabbody");
    expect(text).not.toMatch(/unplaced/i);
    expect(text).not.toMatch(/loose term/i);
  });

  test("what it counts is what someone recorded, not what it inferred", async ({ page }) => {
    await A.boot(page, { scheme: "subject-facet" });
    const n = await page.evaluate(() => {
      const g = currentGraph();
      return {
        marked: allConcepts().filter((c) =>
          State.store.match(g, iri(c), P("tax:needsPlacement"), null).length).length,
        childlessTops: topConcepts().filter((t) => !narrowerOf(t).length).length
      };
    });
    /* The two numbers differ in the demo data, which is the point: the old
       count was the structural guess. */
    expect(n.marked).toBeGreaterThan(0);
    expect(n.marked).not.toBe(n.childlessTops);
    await page.evaluate(() => { State.selected = null; renderDetail(); });
    expect(await page.textContent("#tabbody")).toContain(n.marked.toLocaleString());
  });

  test("a vocabulary that is legitimately flat reports no backlog", async ({ page }) => {
    await A.boot(page, { scheme: "subject-facet" });
    const shown = await page.evaluate(() => {
      /* Strip the markers: what is left is a flat facet, which is a shape, not
         a problem. */
      const g = currentGraph();
      State.store.match(g, null, P("tax:needsPlacement"), null)
        .forEach((q) => State.store.remove(g, q.s, q.p, q.o));
      State.selected = null; renderDetail();
      return document.getElementById("tabbody").textContent;
    });
    expect(shown).not.toMatch(/waiting for a place/);
    expect(shown).toMatch(/concepts/);          // the rest of the overview is intact
  });
});
