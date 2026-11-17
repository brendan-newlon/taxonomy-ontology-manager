const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * A cluster of functions used to build a correct DELETE/INSERT/WHERE string
 * purely to display it in the transparency console, while the actual change
 * was a direct State.store/State.config mutation with no Backend.apply()
 * call at all — invisible in mock/offline mode (there's no server to notice
 * the gap), but meaning the write never reached a live Stardog server: it
 * looked applied for the rest of the session and was silently gone on the
 * next reconnect. See developer-docs/APP-ONTOLOGY.md's URI-minting worked
 * example for the fuller writeup.
 *
 * Fixed: addLanguage(), openUriTemplates()'s save, retargetTags(),
 * flagTagsForReview(), and changeUriPrompt()'s own inline tag rewrite — all
 * now go through commit(mutation({...})), the same pipeline as every other
 * guarded write, so this file asserts *real* Backend.request calls happen
 * in live mode, not just that the console shows the right SPARQL.
 */
async function goLive(page, db) {
  await page.evaluate((database) => {
    window.__calls = [];
    State.mode = "live";
    State.db = database;
    State.conn = Object.assign({}, State.conn, { user: "tester", endpoint: "https://x.test" });
    window.__realRequest = Backend.request;
    Backend.request = async (o) => {
      /* o.body is a URLSearchParams (update=... / query=...) for every call
         these functions make — decode it via .get(), not .toString(), or
         every colon/slash in the SPARQL comes through as %3A/%2F and no
         regex against it will ever match. */
      const body = o.body instanceof URLSearchParams
        ? (o.body.get("update") || o.body.get("query") || "")
        : (o.body && o.body.toString ? o.body.toString() : "");
      window.__calls.push({ method: o.method || "GET", path: o.path, body });
      if (/\/transaction\/begin$/.test(o.path)) return { ok: true, text: async () => "tx-1" };
      if (/\/query$/.test(o.path)) return { ok: true, json: async () => ({ boolean: true }) };
      return { ok: true, text: async () => "tx-1", json: async () => ({ boolean: true }) };
    };
  }, db);
}
async function goOffLive(page) {
  await page.evaluate(() => { if (window.__realRequest) Backend.request = window.__realRequest; });
}

test.describe("Config and bulk-tag writes actually reach a live server", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
  });
  test.afterEach(async ({ page }) => { await goOffLive(page); });

  test("adding an active language sends a real update, not just a logged one", async ({ page }) => {
    await goLive(page, "testdb");
    await page.evaluate(() => openLanguages());
    await A.waitModal(page, "Languages");
    await page.fill("#mTag", "qu");
    await A.modalOk(page);
    await page.waitForTimeout(80);
    const calls = await page.evaluate(() => window.__calls);
    const update = calls.find((c) => /\/testdb\/update$/.test(c.path) && /activeLanguage/.test(c.body));
    expect(update).toBeTruthy();
    expect(await page.evaluate(() => State.config.languages)).toContain("qu");
  });

  test("URI templates saved in an earlier session are read back on the next boot, not just on the session that saved them", async ({ page }) => {
    // Simulate reconnecting to a database someone already configured:
    // write the config graph's triples directly (bypassing the save
    // dialog entirely), the way they'd already be there on a real server
    // from a previous session, then re-run the boot hydration that reads
    // them back into State.config.uriTemplate.
    await page.evaluate(() => {
      const g = G.config, CFG = iri(g);
      State.store.add(g, CFG, P("tax:uriBase"), lit("https://example.org/prior-session/"));
      State.store.add(g, CFG, P("tax:uriDomain"), lit("prior-domain"));
      State.store.add(g, CFG, P("tax:uriLocalIdStrategy"), lit("uuid"));
      State.store.add(g, CFG, P("tax:uriTemplate"), lit("{base}{domain}/{class}/{localId}/v2"));
      const ov = iri(`${NS.tax}uriTemplateFor/concept`);
      State.store.add(g, CFG, P("tax:uriTemplateFor"), ov);
      State.store.add(g, ov, P("tax:forClass"), lit("concept"));
      State.store.add(g, ov, P("tax:pattern"), lit("{base}{domain}/concept/{localId}"));
    });
    await page.evaluate(() => bootWorkspace());
    const ut = await page.evaluate(() => State.config.uriTemplate);
    expect(ut.base).toBe("https://example.org/prior-session/");
    expect(ut.domain).toBe("prior-domain");
    expect(ut.localIdStrategy).toBe("uuid");
    expect(ut.default).toBe("{base}{domain}/{class}/{localId}/v2");
    expect(ut.byClass.concept).toBe("{base}{domain}/concept/{localId}");
  });

  test("a fresh install's first save is a plain update — nothing stored yet to guard against", async ({ page }) => {
    await goLive(page, "testdb");
    await page.evaluate(() => openUriTemplates());
    await A.waitModal(page, "URI templates");
    await page.fill("#tDomain", "brand-new-domain");
    await A.modalOk(page);
    await page.waitForTimeout(80);
    const calls = await page.evaluate(() => window.__calls);
    expect(calls.filter((c) => /\/transaction\/begin$/.test(c.path))).toHaveLength(0);
    const update = calls.find((c) => /\/testdb\/update$/.test(c.path) && /brand-new-domain/.test(c.body));
    expect(update).toBeTruthy();
  });

  test("saving again, once something is actually stored, is a real guarded transaction", async ({ page }) => {
    await goLive(page, "testdb");
    await page.evaluate(() => openUriTemplates());
    await A.waitModal(page, "URI templates");
    await page.fill("#tDomain", "first-save-domain");
    await A.modalOk(page);
    await page.waitForTimeout(80);
    await page.evaluate(() => { window.__calls = []; });

    await page.evaluate(() => openUriTemplates());
    await A.waitModal(page, "URI templates");
    await page.fill("#tDomain", "second-save-domain");
    await A.modalOk(page);
    await page.waitForTimeout(80);
    const calls = await page.evaluate(() => window.__calls);
    expect(calls.filter((c) => /\/transaction\/begin$/.test(c.path))).toHaveLength(1);
    const update = calls.find((c) => /\/tx-1\/update$/.test(c.path) &&
      /first-save-domain/.test(c.body) && /second-save-domain/.test(c.body));
    expect(update).toBeTruthy();
    expect(calls.filter((c) => /\/transaction\/commit\//.test(c.path))).toHaveLength(1);
  });

  test("retargetTags() sends a real guarded transaction against the tags graph", async ({ page }) => {
    const setup = await page.evaluate(() => {
      const corpus = tagCorpora()[0];
      const g = G.tags(corpus.id);
      const anyTag = State.store.match(g, null, P("rdf:type"), P("tax:Tag"))[0];
      const from = State.store.match(g, anyTag.s, P("tax:concept"), null)[0].o.v;
      return { g, from };
    });
    await goLive(page, "testdb");
    await page.evaluate(({ from }) => retargetTags(from, "https://example.org/some-other-concept", "test"), setup);
    await page.waitForTimeout(80);
    const calls = await page.evaluate(() => window.__calls);
    expect(calls.filter((c) => /\/transaction\/begin$/.test(c.path))).toHaveLength(1);
    const update = calls.find((c) => /\/tx-1\/update$/.test(c.path) && /NeedsReview/.test(c.body));
    expect(update).toBeTruthy();
  });

  test("flagTagsForReview() sends a real guarded transaction, and clears any prior reason", async ({ page }) => {
    const setup = await page.evaluate(() => {
      const corpus = tagCorpora()[0];
      const g = G.tags(corpus.id);
      const anyTag = State.store.match(g, null, P("rdf:type"), P("tax:Tag"))[0];
      const concept = State.store.match(g, anyTag.s, P("tax:concept"), null)[0].o.v;
      State.store.add(g, anyTag.s, P("tax:reviewReason"), lit("an old reason"));
      return { concept };
    });
    await goLive(page, "testdb");
    await page.evaluate(({ concept }) => flagTagsForReview(concept, "a new reason"), setup);
    await page.waitForTimeout(80);
    const calls = await page.evaluate(() => window.__calls);
    expect(calls.filter((c) => /\/transaction\/begin$/.test(c.path))).toHaveLength(1);
    const update = calls.find((c) => /\/tx-1\/update$/.test(c.path) &&
      /an old reason/.test(c.body) && /a new reason/.test(c.body));
    expect(update).toBeTruthy();
  });

  test("retargeting the same tag a second time doesn't leave two tax:retargetedFrom values", async ({ page }) => {
    const setup = await page.evaluate(() => {
      const corpus = tagCorpora()[0];
      const g = G.tags(corpus.id);
      const anyTag = State.store.match(g, null, P("rdf:type"), P("tax:Tag"))[0];
      const from = State.store.match(g, anyTag.s, P("tax:concept"), null)[0].o.v;
      return { tag: anyTag.s.v, g, from };
    });
    await retargetOnce(page, setup.from, "https://example.org/second-concept");
    await retargetOnce(page, "https://example.org/second-concept", "https://example.org/third-concept");
    const found = await page.evaluate(({ tag, g }) =>
      State.store.match(g, iri(tag), P("tax:retargetedFrom"), null).map((q) => q.o.v), setup);
    expect(found).toEqual(["https://example.org/second-concept"]);
  });

  async function retargetOnce(page, from, to) {
    await page.evaluate(({ from, to }) => retargetTags(from, to, "test"), { from, to });
    await page.waitForTimeout(80);
  }

  test("a conflicting merge never triggers the tag retarget that assumed it happened", async ({ page }) => {
    // A tagged concept from the seeded sample-publications corpus (built by
    // buildMock() — see tagCorpora()/tagsForConcept() usage elsewhere in
    // this file), merged into another concept in its own scheme.
    const setup = await page.evaluate(() => {
      const corpus = tagCorpora()[0];
      const g = G.tags(corpus.id);
      const anyTag = State.store.match(g, null, P("rdf:type"), P("tax:Tag"))[0];
      const from = State.store.match(g, anyTag.s, P("tax:concept"), null)[0].o.v;
      const home = currentGraph();
      const sibling = allConcepts().find((x) => x !== from &&
        State.store.match(home, iri(x), P("rdf:type"), P("skos:Concept")).length);
      return { from, sibling };
    });
    const applyCalls = await page.evaluate(async ({ from, sibling }) => {
      const calls = [];
      const orig = Backend.apply;
      Backend.apply = async (m) => { calls.push(m.label); return orig.call(Backend, m); };
      // Violate the merge's own guard (rdf:type skos:Concept on the
      // concept being merged away) so its commit() resolves {applied:false}.
      State.store.remove(currentGraph(), iri(from), P("rdf:type"), P("skos:Concept"));
      await new Promise((resolve) => {
        mergePrompt(from);
        setTimeout(() => {
          document.getElementById("mInto").value = sibling;
          document.getElementById("mInto").dataset.pickerValue = sibling;
          document.getElementById("mWhy") && (document.getElementById("mWhy").value = "test");
          document.getElementById("mOk").click();
          setTimeout(resolve, 150);
        }, 30);
      });
      Backend.apply = orig;
      return calls;
    }, setup);
    // The merge's own (conflicting) write is expected; a second call whose
    // label mentions "Retarget" would mean the tag retarget ran anyway.
    expect(applyCalls.some((label) => /Retarget/.test(label))).toBe(false);
  });
});
