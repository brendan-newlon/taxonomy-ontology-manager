const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * Publishing, and the changelog between releases.
 *
 * Publish used to be a dialog that showed a plausible transaction and then, on
 * OK, wrote a toast — no release existed afterwards, nothing was snapshotted,
 * and the "Changelog" line said in so many words that there was no previous
 * release to diff against because there never could be one.
 *
 * So: a release is a real immutable graph, its record survives the graph being
 * dropped, publishing the same version twice is refused rather than silently
 * merged, and the changelog is three questions a taxonomist actually asks.
 */

/** Move some terms into the approved copy the way the app does — via a review. */
async function approveSome(page, n) {
  return page.evaluate(async (k) => {
    const some = allConcepts().slice(0, k);
    const r = await Review.submit({ concepts: some, note: "batch" });
    await Review.approve(r, "fine");
    return some;
  }, n);
}

const publish = async (page, notes) => {
  await page.evaluate(() => openPublish());
  await A.waitModal(page, "Publish");
  if (notes) await page.fill("#pubNotes", notes);
  await A.modalOk(page);
  await page.waitForTimeout(120);
};

const releases = (page) => page.evaluate(() => Releases.list(State.schemeId));

test.describe("Nothing approved yet", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("publishing says which step comes first, and offers it", async ({ page }) => {
    await page.evaluate(() => openPublish());
    await A.waitModal(page, "Nothing to release yet");
    const txt = await A.modalText(page);
    expect(txt).toMatch(/submitted for review and approved/);
    expect(await page.$("#pubRev")).not.toBeNull();
    /* And it is not a publish button that does nothing. */
    expect(await page.$("#mOk")).toBeNull();
  });

  test("and nothing is written by looking", async ({ page }) => {
    const before = await page.evaluate(() => State.store.countIn(G.config));
    await page.evaluate(() => openPublish());
    await A.waitModal(page, "Nothing to release yet");
    await A.modalCancel(page);
    expect(await page.evaluate(() => State.store.countIn(G.config))).toBe(before);
  });
});

test.describe("A first release", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await approveSome(page, 5);
  });

  test("the approved copy becomes a graph nothing writes to again", async ({ page }) => {
    await publish(page, "First cut.");
    const list = await releases(page);
    expect(list).toHaveLength(1);
    const snapshot = await page.evaluate((g) => State.store.countIn(g), list[0].graph);
    const approved = await page.evaluate(() =>
      State.store.countIn(schemeGraphs(schemeById(State.schemeId)).approved));
    expect(snapshot).toBe(approved);
    expect(snapshot).toBeGreaterThan(0);
  });

  test("and published points at that snapshot", async ({ page }) => {
    await publish(page);
    const list = await releases(page);
    const [snap, pub] = await page.evaluate((g) => [
      State.store.countIn(g),
      State.store.countIn(schemeGraphs(schemeById(State.schemeId)).published)
    ], list[0].graph);
    expect(pub).toBe(snap);
  });

  test("the version is in the graph name, so one exact version can be asked for", async ({ page }) => {
    await publish(page);
    const list = await releases(page);
    expect(list[0].graph).toContain(":release:");
    expect(list[0].graph).toContain(list[0].version);
  });

  test("the record carries the counts, not just a pointer to two graphs", async ({ page }) => {
    await publish(page, "Notes here.");
    const [r] = await releases(page);
    /* A release graph is real disk and an administrator may reclaim an old
       one. The changelog has to survive that. */
    expect(r.added).toBe(5);
    expect(r.removed).toBe(0);
    expect(r.renamed).toBe(0);
    expect(r.notes).toBe("Notes here.");
    expect(r.by).toBeTruthy();
  });

  /**
   * Snapshot, repoint, record, audit — and each of them its own SPARQL update.
   *
   * They used to be one string with `;` between the statements, on the reading
   * that SPARQL 1.1 lets a request carry a sequence of operations. The grammar
   * does; what nothing promises is that a server runs such a request as one
   * unit, and invariant 5 is not a thing to rest on an inference. So they are
   * separate updates now, and the transaction is asked for outright.
   */
  test("a publish is four effects, sent as separate updates", async ({ page }) => {
    await publish(page);
    const rdf = await A.logs(page, "rdf");
    const ups = rdf.filter((e) => /UPDATE \d+ of \d+ — Publish/.test(e.msg));
    expect(ups).toHaveLength(3);
    expect(ups[0].code).toMatch(/ADD SILENT/);
    expect(ups[1].code).toMatch(/COPY SILENT/);
    expect(ups[2].code).toMatch(/urn:taxonomy:app:audit/);
    /* No statement is glued to another. */
    ups.forEach((u) => expect(u.code).not.toMatch(/;\s*(INSERT|DELETE|ADD|COPY|MOVE|DROP)\s/));
    expect((await A.logs(page, "audit")).some((e) => /Publish/.test(e.msg))).toBe(true);
  });

  test("the guard is 'this version does not exist yet'", async ({ page }) => {
    await publish(page);
    const rdf = await A.logs(page, "rdf");
    const update = (await A.logs(page, "rdf")).find((e) => /UPDATE 3 of 3 — Publish/.test(e.msg));
    expect(update.code).toMatch(/FILTER NOT EXISTS/);
    expect(update.code).toMatch(/tax:Release|vocab#Release/);
    expect(rdf.some((e) => /^guard — Publish/.test(e.msg))).toBe(false);   // mock mode asks the store
  });
});

/**
 * The live path: what actually goes over the wire.
 *
 * The point of the change is not the shape of the strings, it is that all of
 * them land inside one transaction the app opened on purpose. Nothing here
 * talks to a server — `Backend.request` is replaced with a recorder — but the
 * sequence of calls is exactly the sequence a server would see.
 */
test.describe("Publishing against a live endpoint", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await approveSome(page, 5);
    await page.evaluate(() => {
      window.__calls = [];
      window.goLive = () => {
        State.mode = "live";
        State.db = "testdb";
        State.conn = Object.assign({}, State.conn, { user: "tester", endpoint: "https://x.test" });
        window.__realRequest = Backend.request;
        Backend.request = async (o) => {
          const body = o.body && o.body.toString ? o.body.toString() : "";
          window.__calls.push({ method: o.method || "GET", path: o.path, body });
          return { ok: true, text: async () => "tx-1", json: async () => ({ boolean: true }) };
        };
      };
    });
  });
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => { if (window.__realRequest) Backend.request = window.__realRequest; });
  });

  test("every update goes inside one transaction the app opened", async ({ page }) => {
    /* The dialog is opened before the endpoint is swapped in, because reading
       the approved copy to build the changelog is not what this is about. */
    await page.evaluate(() => openPublish());
    await A.waitModal(page, "Publish");
    await page.evaluate(() => { goLive(); window.__calls = []; });
    await A.modalOk(page);
    await page.waitForTimeout(200);
    const calls = await page.evaluate(() => window.__calls);
    const paths = calls.map((c) => c.path);

    const begin = paths.filter((p) => /\/transaction\/begin$/.test(p));
    expect(begin).toHaveLength(1);

    /* The guard, then the three updates, then the commit — all on tx-1. */
    expect(paths.filter((p) => /\/tx-1\/query$/.test(p))).toHaveLength(1);
    const updates = calls.filter((c) => /\/tx-1\/update$/.test(c.path));
    expect(updates).toHaveLength(3);
    expect(paths.filter((p) => /\/transaction\/commit\/tx-1$/.test(p))).toHaveLength(1);
    expect(paths.filter((p) => /\/transaction\/rollback\//.test(p))).toHaveLength(0);

    /* Never the plain update endpoint: that is one operation, uncommitted
       alongside the others, which is the thing this replaced. */
    expect(paths.some((p) => /\/testdb\/update$/.test(p))).toBe(false);

    /* And each request carries exactly one operation. */
    const sent = updates.map((u) => decodeURIComponent(u.body).replace(/\+/g, " "));
    expect(sent[0]).toMatch(/ADD SILENT/);
    expect(sent[1]).toMatch(/COPY SILENT/);
    expect(sent[2]).toMatch(/INSERT \{/);
    sent.forEach((b) => expect(b).not.toMatch(/;\s*(INSERT|DELETE|ADD|COPY|MOVE|DROP)\s/));
  });

  test("an ordinary single-statement edit still goes as one plain request", async ({ page }) => {
    await page.evaluate(() => { goLive(); window.__calls = []; });
    await page.evaluate(async () => {
      const c = allConcepts()[0];
      await commit(mutation({
        label: "touch", graph: currentGraph(),
        ins: [{ s: iri(c), p: P("skos:editorialNote"), o: lit("hello") }],
        audit: auditEvent({ action: "Edit", subject: c })
      }));
    });
    const paths = (await page.evaluate(() => window.__calls)).map((c) => c.path);
    /* Nothing to make atomic that the update is not already, so no round
       trips are spent opening and closing a transaction for it. */
    expect(paths.filter((p) => /\/transaction\/begin$/.test(p))).toHaveLength(0);
    expect(paths.filter((p) => /\/testdb\/update$/.test(p))).toHaveLength(1);
  });
});

test.describe("A second release on the same day", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await approveSome(page, 5);
    await publish(page);
  });

  test("gets its own version rather than colliding with the first", async ({ page }) => {
    const v2 = await page.evaluate(() => Releases.nextVersion(State.schemeId));
    const [first] = await releases(page);
    expect(v2).not.toBe(first.version);
    expect(v2).toContain(first.version);
  });

  test("publishing the same version twice is refused, and nothing is lost", async ({ page }) => {
    const [first] = await releases(page);
    const before = await page.evaluate((g) => State.store.countIn(g), first.graph);
    const ok = await page.evaluate(async (v) => Releases.publish({
      version: v, notes: "second attempt", summary: { added: 0, removed: 0, renamed: 0 }
    }), first.version);
    expect(ok).toBe(false);
    expect(await releases(page)).toHaveLength(1);
    expect(await page.evaluate((g) => State.store.countIn(g), first.graph)).toBe(before);
    /* And it is told as what it is, not as a concept-edit conflict. */
    expect(await A.modalTitle(page)).toMatch(/already exists/);
  });

  test("mock mode refuses it for the same reason live mode would", async ({ page }) => {
    const logs = await A.logs(page, "internal");
    const [first] = await releases(page);
    await page.evaluate(async (v) => Releases.publish({ version: v, summary: null }), first.version);
    const after = await A.logs(page, "internal");
    expect(after.length).toBeGreaterThan(logs.length);
    expect(after.some((e) => /absent is already there/.test(e.msg))).toBe(true);
  });
});

test.describe("What changed since the last release", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await approveSome(page, 5);
    await publish(page);
  });

  /** Change the approved copy directly: the point here is the diff, not the edit path. */
  const churn = (page) => page.evaluate(() => {
    const gs = schemeGraphs(schemeById(State.schemeId));
    const s = State.store;
    const ids = [...new Set(s.match(gs.approved, null, P("rdf:type"), P("skos:Concept")).map((q) => q.s.v))].sort();
    const lab = s.match(gs.approved, iri(ids[0]), P("skos:prefLabel"), null)[0];
    s.remove(gs.approved, iri(ids[0]), P("skos:prefLabel"), lab.o);
    s.add(gs.approved, iri(ids[0]), P("skos:prefLabel"), lit("Renamed Thing", lab.o.lang));
    s.match(gs.approved, iri(ids[1]), null, null).slice()
      .forEach((q) => s.remove(gs.approved, q.s, q.p, q.o));
    s.add(gs.approved, iri("urn:brand:new"), P("rdf:type"), P("skos:Concept"));
    s.add(gs.approved, iri("urn:brand:new"), P("skos:prefLabel"), lit("Brand New", "en"));
    return { renamedFrom: lab.o.v, removed: ids[1] };
  });

  test("it names what is new, what is gone and what is now called something else", async ({ page }) => {
    const what = await churn(page);
    const d = await page.evaluate(async () => {
      const gs = schemeGraphs(schemeById(State.schemeId));
      return Releases.diff(Releases.latest(State.schemeId).graph, gs.approved);
    });
    expect(d.added.list).toEqual(["urn:brand:new"]);
    expect(d.removed.list).toEqual([what.removed]);
    expect(d.renamed.list).toHaveLength(1);
    expect(d.renamed.list[0].was).toBe(what.renamedFrom);
    expect(d.renamed.list[0].now).toBe("Renamed Thing");
  });

  test("an added translation is not a rename", async ({ page }) => {
    await page.evaluate(() => {
      const gs = schemeGraphs(schemeById(State.schemeId));
      const s = State.store;
      const id = [...new Set(s.match(gs.approved, null, P("rdf:type"), P("skos:Concept")).map((q) => q.s.v))].sort()[0];
      /* A language that graph did not have. Comparing label *sets* would call
         this a rename; comparing the same language's string does not. */
      s.add(gs.approved, iri(id), P("skos:prefLabel"), lit("Ganz Neu", "de"));
    });
    const d = await page.evaluate(async () => Releases.diff(
      Releases.latest(State.schemeId).graph, schemeGraphs(schemeById(State.schemeId)).approved));
    expect(d.renamed.list).toHaveLength(0);
  });

  test("the count is exact even when the list is capped", async ({ page }) => {
    const cap = await page.evaluate(() => CHANGELOG_CAP);
    await page.evaluate((n) => {
      const gs = schemeGraphs(schemeById(State.schemeId));
      const s = State.store;
      for (let i = 0; i <= n + 10; i++) {
        s.add(gs.approved, iri("urn:bulk:" + i), P("rdf:type"), P("skos:Concept"));
        s.add(gs.approved, iri("urn:bulk:" + i), P("skos:prefLabel"), lit("Bulk " + i, "en"));
      }
    }, cap);
    const d = await page.evaluate(async () => Releases.diff(
      Releases.latest(State.schemeId).graph, schemeGraphs(schemeById(State.schemeId)).approved));
    expect(d.added.list).toHaveLength(cap);
    expect(d.added.more).toBe(true);
    /* A count that stopped at the cap would be written onto the release as the
       truth and be wrong forever. */
    expect(d.added.count).toBe(cap + 11);
  });

  test("the dialog shows the changelog before anything is written", async ({ page }) => {
    await churn(page);
    await page.evaluate(() => openPublish());
    await A.waitModal(page, "Publish");
    const txt = await A.modalText(page);
    expect(txt).toMatch(/New terms/);
    expect(txt).toMatch(/Terms no longer in the vocabulary/);
    expect(txt).toMatch(/Renamed/);
    expect(txt).toMatch(/Renamed Thing/);
    await A.modalCancel(page);
    expect(await releases(page)).toHaveLength(1);
  });

  test("a term that is gone is still named, not shown as a bare URI", async ({ page }) => {
    /* labelText reads the graph on screen, which is the draft — and the whole
       point of this list is terms that are not in it. */
    const out = await page.evaluate(() => {
      const gs = schemeGraphs(schemeById(State.schemeId));
      const prev = Releases.latest(State.schemeId).graph;
      const id = [...new Set(State.store.match(prev, null, P("rdf:type"), P("skos:Concept")).map((q) => q.s.v))].sort()[0];
      /* Remove it from the draft too, so nothing on screen knows its name. */
      [prev === gs.draft ? null : gs.draft, gs.approved].filter(Boolean).forEach((g) =>
        State.store.match(g, iri(id), null, null).slice().forEach((q) => State.store.remove(g, q.s, q.p, q.o)));
      return { id, html: labelIn(id, prev) };
    });
    expect(out.html).not.toBe(out.id);
    expect(out.html.length).toBeGreaterThan(0);
  });

  test("the release list shows every release with its counts", async ({ page }) => {
    await churn(page);
    await publish(page, "Second pass.");
    await page.evaluate(() => openReleases());
    await A.waitModal(page, "Releases of");
    const txt = await A.modalText(page);
    const list = await releases(page);
    expect(list).toHaveLength(2);
    for (const r of list) expect(txt).toContain(r.version);
    expect(txt).toContain("Second pass.");
  });
});
