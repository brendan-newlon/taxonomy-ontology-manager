const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * Agreeing a mapping to another vocabulary.
 *
 * The status of a mapping used to hang off its **target** — a resource in
 * somebody else's vocabulary. Two of this vocabulary's terms mapped to the same
 * AGROVOC concept therefore shared one status, agreeing one agreed the other,
 * and this app was writing assertions about a URI it does not own.
 *
 * So the record is its own resource now, derived from the three things it
 * relates. And the decision is a workflow: propose, agree or turn down, with
 * the reason kept either way.
 */

const SOURCE = A.sdg("forests");
const TARGET = "http://aims.fao.org/aos/agrovoc/c_99999";

const mappings = (page, c) => page.evaluate((x) => mappingsOf(x), c);
const one = async (page, c, target) => (await mappings(page, c)).find((m) => m.target === target) || null;
const propose = (page, c, pred, t, conf, note) => page.evaluate(
  async ([a, b, d, e, f]) => Mappings.propose(a, b, d, e, f), [c, pred, t, conf || "", note || ""]);

test.describe("Proposing a mapping", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("asserts the mapping and records who proposed it", async ({ page }) => {
    expect(await propose(page, SOURCE, "exactMatch", TARGET, "0.9", "Same thing.")).toBe(true);
    const m = await one(page, SOURCE, TARGET);
    expect(m.status).toBe("proposed");
    expect(m.confidence).toBe("0.9");
    expect(m.note).toBe("Same thing.");
    expect(m.by).toBeTruthy();
    expect(await A.hasTriple(page, SOURCE, "skos:exactMatch", TARGET)).toBe(true);
  });

  test("the record is its own resource, not a statement about the target", async ({ page }) => {
    await propose(page, SOURCE, "exactMatch", TARGET);
    const out = await page.evaluate((t) => ({
      onTarget: State.store.match(currentGraph(), iri(t), null, null).map((q) => short(q.p.v)),
      record: State.store.match(currentGraph(), null, P("tax:mapTarget"), iri(t)).length
    }), TARGET);
    /* Nothing at all is asserted about the other vocabulary's URI. */
    expect(out.onTarget).toEqual([]);
    expect(out.record).toBe(1);
  });

  test("two terms mapped to the same target have two independent statuses", async ({ page }) => {
    const other = A.sdg("tropical-rainforest");
    await propose(page, SOURCE, "exactMatch", TARGET);
    await propose(page, other, "exactMatch", TARGET);
    await page.evaluate(async ([c, t]) => Mappings.approve(c, "exactMatch", t), [SOURCE, TARGET]);
    expect((await one(page, SOURCE, TARGET)).status).toBe("approved");
    /* This is the bug the record exists for: agreeing one used to agree both. */
    expect((await one(page, other, TARGET)).status).toBe("proposed");
  });

  test("proposing the same mapping twice converges on one record", async ({ page }) => {
    await propose(page, SOURCE, "exactMatch", TARGET);
    const first = (await one(page, SOURCE, TARGET)).record;
    await propose(page, SOURCE, "exactMatch", TARGET);
    const records = await page.evaluate((t) =>
      State.store.match(currentGraph(), null, P("tax:mapTarget"), iri(t)).length, TARGET);
    expect(records).toBe(1);
    expect((await one(page, SOURCE, TARGET)).record).toBe(first);
  });

  test("a mapping onto a term that has gone is refused", async ({ page }) => {
    const ghost = A.sdg("never-existed");
    expect(await propose(page, ghost, "exactMatch", TARGET)).toBe(false);
  });
});

test.describe("Deciding it", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await propose(page, SOURCE, "exactMatch", TARGET, "", "Looks right to me.");
  });

  test("agreeing records who stood behind it and leaves the assertion", async ({ page }) => {
    await page.evaluate(async ([c, t]) => Mappings.approve(c, "exactMatch", t), [SOURCE, TARGET]);
    const m = await one(page, SOURCE, TARGET);
    expect(m.status).toBe("approved");
    expect(m.decidedBy).toBeTruthy();
    expect(await A.hasTriple(page, SOURCE, "skos:exactMatch", TARGET)).toBe(true);
  });

  test("turning it down removes the assertion and keeps the reason", async ({ page }) => {
    await page.evaluate(async ([c, t]) => Mappings.reject(c, "exactMatch", t, "Theirs is broader."),
      [SOURCE, TARGET]);
    expect(await A.hasTriple(page, SOURCE, "skos:exactMatch", TARGET)).toBe(false);
    const rej = await page.evaluate((c) => rejectedMappings().filter((r) => r.source === c), SOURCE);
    expect(rej).toHaveLength(1);
    expect(rej[0].note).toBe("Theirs is broader.");
    expect(rej[0].decidedBy).toBeTruthy();
  });

  test("re-proposing something turned down clears the old decision", async ({ page }) => {
    await page.evaluate(async ([c, t]) => Mappings.reject(c, "exactMatch", t, "No."), [SOURCE, TARGET]);
    await propose(page, SOURCE, "exactMatch", TARGET);
    const m = await one(page, SOURCE, TARGET);
    expect(m.status).toBe("proposed");
    expect(m.decidedBy).toBe(null);
    expect(m.note).toBe(null);
    /* And it is out of the turned-down list, rather than in both. */
    expect(await page.evaluate((c) => rejectedMappings().filter((r) => r.source === c).length, SOURCE)).toBe(0);
  });

  test("removing a mapping takes its record with it", async ({ page }) => {
    const rec = (await one(page, SOURCE, TARGET)).record;
    await page.evaluate(async ([c, t]) => deleteMapping(c, "exactMatch", t), [SOURCE, TARGET]);
    await page.waitForTimeout(60);
    expect(await one(page, SOURCE, TARGET)).toBe(null);
    /* Left behind, it would keep the mapping in the review queue after the
       mapping itself had gone. */
    expect(await page.evaluate((r) => State.store.match(currentGraph(), iri(r), null, null).length, rec)).toBe(0);
  });

  test("agreeing something a colleague already removed is a conflict, not a decision", async ({ page }) => {
    await page.evaluate(async ([c, t]) => {
      /* Somebody else removed the assertion since the queue was drawn. */
      State.store.remove(currentGraph(), iri(c), P("skos:exactMatch"), iri(t));
    }, [SOURCE, TARGET]);
    const ok = await page.evaluate(async ([c, t]) => Mappings.approve(c, "exactMatch", t), [SOURCE, TARGET]);
    expect(ok).toBe(false);
  });

  test("every decision is a guarded write with a change-log entry", async ({ page }) => {
    await page.evaluate(async ([c, t]) => Mappings.approve(c, "exactMatch", t), [SOURCE, TARGET]);
    const rdf = await A.logs(page, "rdf");
    expect(rdf.some((e) => /guard — Approve skos:exactMatch/.test(e.msg) ||
                           /UPDATE — Approve skos:exactMatch/.test(e.msg))).toBe(true);
    expect((await A.logs(page, "audit")).some((e) => /ApproveMapping/.test(e.msg))).toBe(true);
  });
});

test.describe("Data written before the record existed", () => {
  test("a status kept on the target is still read", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    /* The demo vocabulary carries mappings in the old shape. A vocabulary must
       not start reporting every mapping in it as un-reviewed because the app
       changed its mind about where to put a word. */
    const out = await page.evaluate(() => {
      const c = allConcepts().find((x) => mappingsOf(x).some((m) => m.status === "approved" && !m.hasRecord));
      return c ? mappingsOf(c).filter((m) => m.status === "approved") : [];
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].hasRecord).toBe(false);
  });

  test("and deciding one gives it a record", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const out = await page.evaluate(async () => {
      /* One nobody has agreed yet — asking to agree something already agreed
         is correctly a no-op, and would prove nothing here. */
      const c = allConcepts().find((x) =>
        mappingsOf(x).some((m) => !m.hasRecord && m.status !== "approved"));
      const m = mappingsOf(c).find((x) => !x.hasRecord && x.status !== "approved");
      await Mappings.decide(c, m.pred, m.target, "approved", "Checked.", false);
      const after = mappingsOf(c).find((x) => x.target === m.target && x.pred === m.pred);
      return { source: after.hasRecord, status: after.status, note: after.note };
    });
    expect(out.source).toBe(true);
    expect(out.status).toBe("approved");
    expect(out.note).toBe("Checked.");
  });
});

test.describe("The mapping queue", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  const open = async (page) => {
    await page.evaluate(() => openMappingReview());
    await A.waitModal(page, "Mappings");
  };

  test("lists what nobody has decided", async ({ page }) => {
    await propose(page, SOURCE, "exactMatch", TARGET, "", "Waiting on somebody.");
    await open(page);
    const txt = await A.modalText(page);
    expect(txt).toMatch(/Waiting for a decision/);
    expect(txt).toContain(TARGET);
  });

  test("and what nobody has proposed, with the candidate named", async ({ page }) => {
    /* Validation already matches terms that exist in another vocabulary here;
       until now "candidate for skos:exactMatch" was a sentence with nothing on
       the end of it. */
    const candidates = await page.evaluate(() =>
      State.issues.filter((i) => i.rule === "mapping-candidate").map((i) => ({ c: i.concept, t: i.target })));
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((x) => !!x.t)).toBe(true);
    await open(page);
    expect(await page.$('#modalRoot [data-mrnew]')).not.toBeNull();
  });

  test("a candidate already asserted drops out of the list", async ({ page }) => {
    const first = await page.evaluate(() =>
      State.issues.filter((i) => i.rule === "mapping-candidate").map((i) => ({ c: i.concept, t: i.target }))[0]);
    await propose(page, first.c, "exactMatch", first.t);
    await open(page);
    const still = await page.$$eval("#modalRoot [data-mrnew]",
      (els) => els.map((e) => e.dataset.mrnew + "|" + e.dataset.t));
    expect(still).not.toContain(first.c + "|" + first.t);
  });

  test("a candidate already turned down does not come back", async ({ page }) => {
    const first = await page.evaluate(() =>
      State.issues.filter((i) => i.rule === "mapping-candidate").map((i) => ({ c: i.concept, t: i.target }))[0]);
    await propose(page, first.c, "exactMatch", first.t);
    await page.evaluate(async (x) => Mappings.reject(x.c, "exactMatch", x.t, "Different sense."), first);
    await open(page);
    const still = await page.$$eval("#modalRoot [data-mrnew]",
      (els) => els.map((e) => e.dataset.mrnew + "|" + e.dataset.t));
    expect(still).not.toContain(first.c + "|" + first.t);
  });

  test("a target in another vocabulary here is named, not shown as a dead link", async ({ page }) => {
    const html = await page.evaluate(() => {
      const i = State.issues.find((x) => x.rule === "mapping-candidate");
      return mapTargetHtml(i.target);
    });
    expect(html).not.toMatch(/<a /);
    expect(html).toMatch(/in /);
  });

  test("a target somewhere else entirely is a link out", async ({ page }) => {
    const html = await page.evaluate(() => mapTargetHtml("http://aims.fao.org/aos/agrovoc/c_7797"));
    expect(html).toMatch(/<a class="link" href="http:\/\/aims\.fao\.org/);
    expect(html).toMatch(/rel="noopener noreferrer"/);
  });

  test("reading the queue writes nothing", async ({ page }) => {
    await propose(page, SOURCE, "exactMatch", TARGET);
    const before = await A.quadCount(page);
    await open(page);
    await A.modalCancel(page);
    expect(await A.quadCount(page)).toBe(before);
  });

  test("the five predicates are offered in words, not only as CURIEs", async ({ page }) => {
    await A.clickRow(page, SOURCE);
    await A.selectTab(page, "mappings");
    await page.click("#tabbody [data-addmap]");
    /* Mock mode always grants decide rights (canDecideMappings() short-
       circuits to true off State.mode) — see the fourth feedback pass's
       admin direct-add feature — so this modal is always the decide-capable
       "Add a mapping" here, never the propose-only title a genuinely
       unprivileged live session would see (covered separately, under a
       faked restricted live session, in 42-fourth-feedback-pass.spec.js). */
    await A.waitModal(page, "Add a mapping");
    const opts = await page.$$eval("#mPred option", (e) => e.map((o) => o.textContent));
    expect(opts.join(" ")).toMatch(/the same as/);
    expect(opts.join(" ")).toMatch(/skos:exactMatch/);
    /* skos:broadMatch means the target is the broader one. */
    expect(opts.find((o) => /skos:broadMatch/.test(o))).toMatch(/narrower than/);
  });

  test("the dialog will not propose nothing", async ({ page }) => {
    await A.clickRow(page, SOURCE);
    await A.selectTab(page, "mappings");
    await page.click("#tabbody [data-addmap]");
    await A.waitModal(page, "Add a mapping");
    expect(await A.okDisabled(page)).toBe(true);
    // mTarget is a picker now (item 6: browse/search a concept instead of
    // only pasting a bare IRI) — typing into its visible input is what a
    // pasted external URI looks like; wireRequired() reads it the same way
    // pickerTyped() will on submit.
    await page.fill("#mTarget", TARGET);
    expect(await A.okDisabled(page)).toBe(false);
  });
});

test.describe("Nothing is credited to the wrong person", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("re-proposing replaces who proposed it, rather than adding a second", async ({ page }) => {
    /* Measured before the fix: the record ended up holding tax:proposedBy
       "ana" AND "ronaldo" with two dct:created values, and one() takes the
       first — so the screen credited ana for a mapping ronaldo had put back. */
    const out = await page.evaluate(async ([c, t]) => {
      State.conn = Object.assign({}, State.conn, { user: "ana" });
      await Mappings.propose(c, "exactMatch", t, "", "");
      State.conn = Object.assign({}, State.conn, { user: "ronaldo" });
      await Mappings.reject(c, "exactMatch", t, "no");
      await Mappings.propose(c, "exactMatch", t, "", "");
      const rec = mappingRecordIri(c, "exactMatch", t);
      const g = currentGraph();
      return {
        by: State.store.match(g, iri(rec), P("tax:proposedBy"), null).map((q) => q.o.v),
        created: State.store.match(g, iri(rec), P("dct:created"), null).length,
        reported: readMapping(c, "exactMatch", t).by
      };
    }, [SOURCE, TARGET]);
    expect(out.by).toEqual(["ronaldo"]);
    expect(out.created).toBe(1);
    expect(out.reported).toBe("ronaldo");
  });
});

test.describe("A read-only session is offered no mapping decision", () => {
  test("Agree and Turn down go with the ✕, not instead of it", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const out = await page.evaluate(() => {
      const c = allConcepts().find((x) => mappingsOf(x).some((m) => m.status !== "approved"));
      selectConcept(c);
      const real = canEditHere;
      window.canEditHere = () => false;
      State.tab = "mappings"; State.tabTouched = true;
      try { renderDetail(); } finally { window.canEditHere = real; }
      const b = document.getElementById("tabbody");
      return {
        propose: !!b.querySelector("[data-addmap]"),
        remove: !!b.querySelector("[data-delmap]"),
        agree: !!b.querySelector("[data-mapok]"),
        turnDown: !!b.querySelector("[data-mapno]")
      };
    });
    /* Turning a mapping down deletes an assertion — a bigger write than the ✕
       that was already being stripped. */
    expect(out).toEqual({ propose: false, remove: false, agree: false, turnDown: false });
  });
});

test.describe("A merge takes the decision with it", () => {
  const MANGROVE = A.sdg("mangrove");
  const FORESTS = A.sdg("forests");
  const T = "http://example.org/other/agreed";

  test("the survivor's mapping keeps its record and its status", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await page.evaluate(async ([c, t]) => {
      await Mappings.propose(c, "exactMatch", t, "", "");
      await Mappings.approve(c, "exactMatch", t, "checked");
    }, [MANGROVE, T]);

    await A.reveal(page, MANGROVE);
    await A.clickRow(page, MANGROVE);
    await page.evaluate((c) => mergePrompt(c), MANGROVE);
    await A.waitModal(page, "Merge");
    await A.pick(page, "mInto", "Forests");
    await page.fill("#mWhy", "same concept");
    await A.modalOk(page);
    await page.waitForTimeout(120);

    const out = await page.evaluate(([from, into, t]) => {
      const survivor = mappingsOf(into).find((m) => m.target === t);
      return {
        found: !!survivor,
        status: survivor && survivor.status,
        decidedBy: survivor && survivor.decidedBy,
        oldRecordLeft: State.store.match(currentGraph(), iri(mappingRecordIri(from, "exactMatch", t)), null, null).length,
        strayRejected: rejectedMappings().filter((r) => r.source === from).length
      };
    }, [MANGROVE, FORESTS, T]);

    /* Before the fix the record stayed keyed on the merged-away term, so the
       survivor's mapping read as un-reviewed and the approval was lost. */
    expect(out.found).toBe(true);
    expect(out.status).toBe("approved");
    expect(out.decidedBy).toBeTruthy();
    expect(out.oldRecordLeft).toBe(0);
    expect(out.strayRejected).toBe(0);
  });
});

test.describe("The queue says when it is only part of the vocabulary", () => {
  test("windowed loading is called out, as it is on the quality screen", async ({ page }) => {
    test.slow();
    await A.boot(page, { scheme: "plant-conservation" });
    const scheme = await page.evaluate(() => schemeIri());
    const { text } = A.bigSchemeTriples({ roots: 60, branches: 4, perBranch: 3, scheme });
    await A.importText(page, text, "ntriples");
    await A.useWindowedLoading(page);
    await page.evaluate(() => openMappingReview());
    await A.waitModal(page, "Mappings");
    /* An empty queue in windowed mode means "nothing among what has been
       read", and a reviewer working it to empty would think they had finished. */
    expect(await A.modalText(page)).toMatch(/Only the part that has been read/);
  });
});
