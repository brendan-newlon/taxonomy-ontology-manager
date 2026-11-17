const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

const FORESTS = A.sdg("bosques");
const MANGROVE = A.sdg("manglar");

/**
 * Review, on the shared draft.
 *
 * Everyone edits the same draft — that is a decision, not an omission. A
 * private copy per editor costs three things: two people editing the same term
 * in separate graphs never conflict, they diverge and collide later; every
 * read becomes "the draft plus mine, mine winning"; and landing the work back
 * is a three-way merge this app has never built. Guarded conditional writes
 * already handle the concurrency. What was missing was a way to say "the part
 * I did is finished".
 *
 * The change-set comes from the change log, which has recorded the subject,
 * the actor and the time of every write since the beginning, in the same
 * transaction as the write.
 */

const asUser = (page, who) => page.evaluate((u) => { State.conn.user = u; }, who);
const reviews = (page, state) => page.evaluate((st) => Review.list(State.schemeId, st), state || null);
const inGraph = (page, graph, c) => page.evaluate((x) =>
  State.store.match(x.g === "approved" ? schemeGraphs(schemeById(State.schemeId)).approved
    : schemeGraphs(schemeById(State.schemeId)).draft, iri(x.c), null, null).length,
  { g: graph, c });

async function editSomething(page, concept, text) {
  await A.reveal(page, concept);
  await A.clickRow(page, concept);
  await A.selectTab(page, "notes");
  await page.click('[data-addnote="scopeNote"]');
  await A.waitModal(page, "Add scopeNote");
  await page.fill("#mText", text);
  await A.modalOk(page);
}

test.describe("Submitting work for review", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("what I changed comes from the change log, not from a diff", async ({ page }) => {
    await asUser(page, "sara");
    await editSomething(page, FORESTS, "Sara looked at this");
    const mine = await page.evaluate(() => Review.changedBy("sara", State.schemeId, null));
    expect(mine).toContain(FORESTS);
    // and it is scoped to the person
    expect(await page.evaluate(() => Review.changedBy("someone-else", State.schemeId, null))).toEqual([]);
  });

  test("a request names the terms, who raised it and when", async ({ page }) => {
    await asUser(page, "sara");
    await editSomething(page, FORESTS, "Sara looked at this");
    await page.evaluate((c) => Review.submit({ concepts: [c], note: "Tidied the forest terms." }), FORESTS);

    const [r] = await reviews(page, "pending");
    expect(r.by).toBe("sara");
    expect(r.concepts).toEqual([FORESTS]);
    expect(r.note).toBe("Tidied the forest terms.");
    expect(r.state).toBe("pending");
    expect(Date.parse(r.at)).toBeGreaterThan(0);
  });

  test("submitting is one transaction with its change-log entry", async ({ page }) => {
    await asUser(page, "sara");
    const at = await page.evaluate(() => State.log.length);
    await page.evaluate((c) => Review.submit({ concepts: [c], note: "" }), FORESTS);
    const fresh = (await A.logs(page)).slice(at);
    const rdf = fresh.filter((e) => e.channel === "rdf").map((e) => e.code || "").join(" | ");
    expect(rdf).toContain("urn:taxonomy:app:reviews");
    expect(fresh.filter((e) => e.channel === "audit").map((e) => e.msg || "").join(" | "))
      .toMatch(/SubmitForReview/);
  });

  test("the second submission only offers what changed since the first", async ({ page }) => {
    await asUser(page, "sara");
    await editSomething(page, FORESTS, "one");
    await page.evaluate((c) => Review.submit({ concepts: [c], note: "" }), FORESTS);
    const since = await page.evaluate(() => Review.lastSubmission("sara", State.schemeId));
    expect(since).toBeTruthy();

    // nothing new yet
    expect(await page.evaluate((s) => Review.changedBy("sara", State.schemeId, s), since)).toEqual([]);

    await editSomething(page, MANGROVE, "two");
    const next = await page.evaluate((s) => Review.changedBy("sara", State.schemeId, s), since);
    expect(next).toContain(MANGROVE);
    expect(next).not.toContain(FORESTS);
  });

  test("the dialog is empty and says so when there is nothing to submit", async ({ page }) => {
    await asUser(page, "nobody-has-edited");
    await page.evaluate(() => openSubmitForReview());
    await A.waitModal(page, "Submit for review");
    expect(await A.modalText(page)).toMatch(/have not changed anything/i);
    expect(await page.$("#mOk")).toBeNull();
  });
});

test.describe("Deciding a review", () => {
  test.beforeEach(async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await asUser(page, "sara");
    await editSomething(page, FORESTS, "Sara looked at this");
    await page.evaluate((c) => Review.submit({ concepts: [c], note: "Please check." }), FORESTS);
    await asUser(page, "lead");
  });

  test("approving promotes the terms into the approved copy", async ({ page }) => {
    expect(await inGraph(page, "approved", FORESTS)).toBe(0);
    const [r] = await reviews(page, "pending");
    await page.evaluate((x) => Review.approve(x, "Looks right."), r.iri);

    expect(await inGraph(page, "approved", FORESTS)).toBeGreaterThan(0);
    expect(await inGraph(page, "draft", FORESTS)).toBeGreaterThan(0);   // the draft keeps it too
  });

  test("the promotion and the decision are one transaction", async ({ page }) => {
    const [r] = await reviews(page, "pending");
    const at = await page.evaluate(() => State.log.length);
    await page.evaluate((x) => Review.approve(x, ""), r.iri);
    const rdf = (await A.logs(page)).slice(at).filter((e) => e.channel === "rdf")
      .map((e) => e.code || "").join(" | ");
    // one UPDATE naming both graphs — a promotion with no record, or a record
    // with no promotion, is worse than neither
    const update = rdf.split(" | ").find((q) => q.includes("approved"));
    expect(update).toContain("urn:taxonomy:app:reviews");
    expect(update).toMatch(/:approved/);
  });

  test("a decided review records who decided it, when, and what they said", async ({ page }) => {
    const [r] = await reviews(page, "pending");
    await page.evaluate((x) => Review.approve(x, "Looks right."), r.iri);
    const after = await page.evaluate((x) => Review.read(x), r.iri);
    expect(after.state).toBe("approved");
    expect(after.decidedBy).toBe("lead");
    expect(after.decision).toBe("Looks right.");
    expect(Date.parse(after.decidedAt)).toBeGreaterThan(0);
  });

  test("sending one back moves nothing", async ({ page }) => {
    const [r] = await reviews(page, "pending");
    await page.evaluate((x) => Review.returnIt(x, "Two of these are duplicates."), r.iri);
    expect(await inGraph(page, "approved", FORESTS)).toBe(0);
    const after = await page.evaluate((x) => Review.read(x), r.iri);
    expect(after.state).toBe("returned");
    expect(after.decision).toBe("Two of these are duplicates.");
  });

  test("two reviewers deciding at once conflict rather than overwriting", async ({ page }) => {
    const [r] = await reviews(page, "pending");
    await page.evaluate((x) => Review.approve(x, "first"), r.iri);
    // the second decision is guarded on the state it read, which has moved
    const second = await page.evaluate((x) => Review.returnIt(x, "second"), r.iri);
    expect(second).toBe(false);
    expect((await page.evaluate((x) => Review.read(x), r.iri)).state).toBe("approved");
  });

  test("it drops off the waiting list once decided", async ({ page }) => {
    const [r] = await reviews(page, "pending");
    await page.evaluate((x) => Review.approve(x, ""), r.iri);
    expect(await reviews(page, "pending")).toEqual([]);
    expect((await reviews(page)).length).toBe(1);
  });
});

test.describe("Finding out there is something to review", () => {
  test("a waiting review is a notification", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await asUser(page, "sara");
    await editSomething(page, FORESTS, "x");
    await page.evaluate((c) => Review.submit({ concepts: [c], note: "" }), FORESTS);
    const notes = await page.evaluate(() => computeNotifications().map((n) => n.id + ":" + n.text));
    expect(notes.join(" | ")).toMatch(/reviews.*1 review waiting/);
  });

  test("someone who cannot approve is not told to", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await asUser(page, "sara");
    await editSomething(page, FORESTS, "x");
    await page.evaluate((c) => Review.submit({ concepts: [c], note: "" }), FORESTS);
    await page.evaluate(() => { canReviewHere = () => false; });
    const notes = await page.evaluate(() => computeNotifications().map((n) => n.id));
    expect(notes).not.toContain("reviews");
  });

  test("the queue shows what is waiting and what has been decided", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await asUser(page, "sara");
    await editSomething(page, FORESTS, "x");
    await page.evaluate((c) => Review.submit({ concepts: [c], note: "Please check." }), FORESTS);
    await page.evaluate(() => openReviewQueue());
    await A.waitModal(page, "Reviews");
    const body = (await A.modalText(page)).replace(/\s+/g, " ");
    expect(body).toContain("sara");
    expect(body).toContain("Please check.");
    expect(body).toMatch(/waiting/);
  });
});

test.describe("Reviewing needs the permission to review", () => {
  test("the capability grants the reviews graph, or a reviewer cannot record a decision", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const g = await page.evaluate(() =>
      grantsForLevels(["approve"], schemeGraphs(schemeById(State.schemeId))).map(needLabel));
    expect(g).toContain("READ urn:taxonomy:app:reviews");
    expect(g).toContain("WRITE urn:taxonomy:app:reviews");
  });

  test("an editor can raise one, which is a write to the same graph", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const g = await page.evaluate(() =>
      grantsForLevels(["edit"], schemeGraphs(schemeById(State.schemeId))).map(needLabel));
    expect(g).toContain("WRITE urn:taxonomy:app:reviews");
  });
});

/**
 * A committed write has to reach the screen, not only the server.
 *
 * Live mode used to skip mirroring into the local store: an edit landed on
 * Stardog, the toast said it worked, and the tree did not change — the edit
 * came back only when the vocabulary was re-opened. Mock mode mirrored and
 * live mode did not, which is the same mock-and-live asymmetry that hid the
 * guard bug in STARDOG-API-CALLS §8.1b, in the other direction. Found by
 * committing a note against a real server and then asking the store what it
 * held: server 1, store 0.
 *
 * Both paths call `Backend.mirror` now, from `apply` and nowhere else.
 */
test.describe("A write reaches the screen, not only the server", () => {
  const liveCommit = (page, extra) => page.evaluate(async (x) => {
    const real = Backend.request;
    const sent = [];
    Backend.request = async (o) => {
      sent.push(o.path);
      return { ok: true, status: 200, text: async () => "tx-1",
               json: async () => ({ boolean: true }) };
    };
    const wasMode = State.mode;
    State.mode = "live";
    State.db = "testdb";
    const g = currentGraph();
    const C = iri(x.c);
    let applied = false;
    try {
      applied = await commit(mutation({
        label: "test",
        graph: g,
        guard: [{ s: C, p: P("rdf:type"), o: P("skos:Concept") }],
        del: [], ins: [{ s: C, p: P("skos:scopeNote"), o: lit("landed", "en") }],
        also: x.also ? [{ graph: G.reviews, ins: [{ s: iri("urn:t:r"), p: P("tax:reviewState"), o: lit("pending") }] }] : [],
        audit: auditEvent({ action: "AddNote", subject: x.c, newValue: lit("landed") })
      }));
    } finally { Backend.request = real; State.mode = wasMode; }
    return {
      applied, sent,
      inStore: State.store.match(g, C, P("skos:scopeNote"), null).map((q) => q.o.v),
      inReviews: State.store.match(G.reviews, iri("urn:t:r"), null, null).length,
      inAudit: State.store.match(G.audit(new Date().toISOString()), null, P("tax:action"), null).length
    };
  }, extra);

  test("a live commit puts the statement in the store, not only in the request", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const r = await liveCommit(page, { c: FORESTS });
    expect(r.applied).toBe(true);
    expect(r.sent.some((p) => p.includes("transaction"))).toBe(true);   // it really went out
    expect(r.inStore).toContain("landed");                              // and it really came back
  });

  test("what a live commit writes to a second graph lands there too", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const r = await liveCommit(page, { c: FORESTS, also: true });
    expect(r.inReviews).toBe(1);
  });

  test("the change-log entry is mirrored with the change", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const before = await page.evaluate(() =>
      State.store.match(G.audit(new Date().toISOString()), null, P("tax:action"), null).length);
    const r = await liveCommit(page, { c: FORESTS });
    expect(r.inAudit).toBeGreaterThan(before);
  });

  test("a refused write mirrors nothing", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const r = await page.evaluate(async (c) => {
      const real = Backend.request;
      Backend.request = async (o) => ({
        ok: true, status: 200, text: async () => "tx-1",
        // the guard does not hold
        json: async () => ({ boolean: false })
      });
      const wasMode = State.mode;
      State.mode = "live"; State.db = "testdb";
      const g = currentGraph(), C = iri(c);
      let applied = null;
      try {
        applied = await Backend.apply(mutation({
          label: "test", graph: g,
          guard: [{ s: C, p: P("rdf:type"), o: P("skos:Concept") }],
          del: [], ins: [{ s: C, p: P("skos:scopeNote"), o: lit("must not land", "en") }]
        }));
      } finally { Backend.request = real; State.mode = wasMode; }
      return { applied, inStore: State.store.match(g, C, P("skos:scopeNote"), null).map((q) => q.o.v) };
    }, FORESTS);
    expect(r.applied.applied).toBe(false);
    expect(r.inStore).not.toContain("must not land");
  });
});
