const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * Discussion on a term.
 *
 * The thing a taxonomy team does constantly that had nowhere to go: arguing
 * about a definition. What these tests hold on to is the three properties that
 * make it worth having rather than a comment box — the thread is not part of
 * the term, it does not disappear when it is settled, and a reply to a settled
 * thread re-opens it rather than being said into a closed room.
 */

const CONCEPT = A.sdg("bosques");

/** Start a thread through the app's own write path. */
const start = (page, c, text) => page.evaluate(
  async ([x, t]) => Discussion.start({ concept: x, text: t }), [c, text]);

const threads = (page, c) => page.evaluate(
  (x) => Discussion.on(x).map((t) => ({
    iri: t.iri, state: t.state, by: t.by, concept: t.concept, scheme: t.scheme,
    comments: t.comments.map((m) => ({ by: m.by, text: m.text, mentions: m.mentions }))
  })), c);

test.describe("A thread on a term", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a question reaches the term it is about", async ({ page }) => {
    await start(page, CONCEPT, "Does this include plantations?");
    const t = await threads(page, CONCEPT);
    expect(t).toHaveLength(1);
    expect(t[0].state).toBe("open");
    expect(t[0].concept).toBe(CONCEPT);
    expect(t[0].comments.map((m) => m.text)).toEqual(["Does this include plantations?"]);
  });

  test("and it is not part of the term", async ({ page }) => {
    await start(page, CONCEPT, "Does this include plantations?");
    /* The whole reason for a graph of its own: an export of the vocabulary
       must not carry the argument, an approval must not promote it, and
       somebody who may not edit must still be able to read it. */
    const inVocab = await page.evaluate((c) => State.store.match(currentGraph(), null, null, null)
      .filter((q) => /discussion|Discussion|tax:Comment/.test(q.p.v + q.o.v)).length, CONCEPT);
    expect(inVocab).toBe(0);
    const inOwn = await page.evaluate(() =>
      State.store.match(G.comments, null, P("rdf:type"), P("tax:Discussion")).length);
    expect(inOwn).toBe(1);
  });

  test("the tab says how many are open, without being opened", async ({ page }) => {
    await A.clickRow(page, CONCEPT);
    await start(page, CONCEPT, "One");
    await page.evaluate(() => renderDetail());
    const count = await page.$eval('#tabs [data-tab="discussion"] .count', (e) => e.textContent);
    expect(count).toBe("1");
  });

  test("a reply lands in the same thread, in order", async ({ page }) => {
    const t = await start(page, CONCEPT, "First");
    await page.evaluate(async (x) => Discussion.reply(x, "Second"), t);
    await page.evaluate(async (x) => Discussion.reply(x, "Third"), t);
    const out = await threads(page, CONCEPT);
    expect(out).toHaveLength(1);
    expect(out[0].comments.map((m) => m.text)).toEqual(["First", "Second", "Third"]);
  });

  test("resolving keeps the thread and everything said in it", async ({ page }) => {
    const t = await start(page, CONCEPT, "Should we merge these?");
    await page.evaluate(async (x) => Discussion.reply(x, "No — different scope."), t);
    await page.evaluate(async (x) => Discussion.setState(x, "resolved", "Leaving both."), t);
    const out = await threads(page, CONCEPT);
    expect(out[0].state).toBe("resolved");
    /* "We decided against this, and here is why" is the most valuable sentence
       in the record. A resolved thread that deleted itself would take it. */
    expect(out[0].comments.map((m) => m.text)).toContain("No — different scope.");
    expect(out[0].comments.map((m) => m.text)).toContain("Leaving both.");
  });

  test("a reply to a settled thread re-opens it", async ({ page }) => {
    const t = await start(page, CONCEPT, "Settled?");
    await page.evaluate(async (x) => Discussion.setState(x, "resolved"), t);
    await page.evaluate(async (x) => Discussion.reply(x, "Actually, one more thing."), t);
    const out = await threads(page, CONCEPT);
    expect(out[0].state).toBe("open");
  });

  test("resolving twice is not a second decision", async ({ page }) => {
    const t = await start(page, CONCEPT, "x");
    await page.evaluate(async (x) => Discussion.setState(x, "resolved"), t);
    const before = await page.evaluate(() => State.store.countIn(G.comments));
    await page.evaluate(async (x) => Discussion.setState(x, "resolved"), t);
    expect(await page.evaluate(() => State.store.countIn(G.comments))).toBe(before);
  });

  test("every write is a guarded transaction with a change-log entry", async ({ page }) => {
    await start(page, CONCEPT, "Anything?");
    const rdf = await A.logs(page, "rdf");
    const audit = await A.logs(page, "audit");
    expect(rdf.some((e) => /Start a discussion/.test(e.msg))).toBe(true);
    expect(audit.some((e) => /StartDiscussion/.test(e.msg))).toBe(true);
    /* Invariant 5: the comment and its audit event in one transaction. */
    const update = rdf.find((e) => /UPDATE — Start a discussion/.test(e.msg));
    expect(update.code).toMatch(/urn:taxonomy:app:comments/);
    expect(update.code).toMatch(/urn:taxonomy:app:audit/);
  });

  test("a question about a term that has gone is refused, not orphaned", async ({ page }) => {
    const out = await page.evaluate(async () => {
      const ghost = "https://taxonomy.example.org/id/plant-conservation/concept/never-existed";
      const ok = await Discussion.start({ concept: ghost, text: "hello?" });
      return { ok, threads: State.store.match(G.comments, null, P("tax:onConcept"), iri(ghost)).length };
    });
    expect(out.ok).toBe(null);
    expect(out.threads).toBe(0);
  });
});

test.describe("Naming somebody", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("an @name is recorded as a mention", async ({ page }) => {
    await start(page, CONCEPT, "@marta is this right?");
    const t = await threads(page, CONCEPT);
    expect(t[0].comments[0].mentions).toEqual(["marta"]);
  });

  test("an email address in a comment does not mention a stranger", async ({ page }) => {
    await start(page, CONCEPT, "Ask ana@example.org about it.");
    const t = await threads(page, CONCEPT);
    expect(t[0].comments[0].mentions).toEqual([]);
  });

  test("the same name twice is one mention", async ({ page }) => {
    await start(page, CONCEPT, "@marta — @marta, are you there?");
    const t = await threads(page, CONCEPT);
    expect(t[0].comments[0].mentions).toEqual(["marta"]);
  });

  test("a thread that names you is separated from the rest", async ({ page }) => {
    const out = await page.evaluate(async () => {
      State.conn = Object.assign({}, State.conn, { user: "marta" });
      await Discussion.start({ concept: topConcepts()[0], text: "@marta please look" });
      await Discussion.start({ concept: topConcepts()[1] || topConcepts()[0], text: "no names here" });
      return computeNotifications().map((n) => ({ id: n.id, text: n.text }));
    });
    expect(out.find((n) => n.id === "mentions").text).toMatch(/1 discussion names you/);
    expect(out.find((n) => n.id === "discussions").text).toMatch(/1 open discussion/);
  });

  test("your own name is picked out in the text, and other people's are not", async ({ page }) => {
    const out = await page.evaluate(() => {
      State.conn = Object.assign({}, State.conn, { user: "marta" });
      return { mine: commentHtml("@marta look"), theirs: commentHtml("@ronaldo look") };
    });
    expect(out.mine).toMatch(/class="mention me"/);
    expect(out.theirs).toMatch(/class="mention"/);
    expect(out.theirs).not.toMatch(/mention me/);
  });
});

test.describe("The discussion screen", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("lists what is open, and says which term each is about", async ({ page }) => {
    await start(page, CONCEPT, "About forests");
    await page.evaluate(() => openDiscussions());
    const txt = await A.modalText(page);
    expect(txt).toMatch(/About forests/);
    expect(txt).toMatch(/Bosques|Forests|Florestas/);
  });

  test("a thread in another vocabulary is not on this one's list", async ({ page }) => {
    await start(page, CONCEPT, "In plant-conservation");
    await A.switchScheme(page, "regions");
    await page.evaluate(() => openDiscussions());
    expect(await A.modalText(page)).not.toMatch(/In plant-conservation/);
  });

  test("and reading it writes nothing", async ({ page }) => {
    await start(page, CONCEPT, "hello");
    const before = await page.evaluate(() => State.store.countIn(G.comments));
    await page.evaluate(() => openDiscussions());
    await A.modalCancel(page);
    expect(await page.evaluate(() => State.store.countIn(G.comments))).toBe(before);
  });
});

test.describe("Commenting is not editing", () => {
  test("a read-only account can still say something", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    await start(page, CONCEPT, "Existing question");
    await A.clickRow(page, CONCEPT);
    const out = await page.evaluate(() => {
      /* A session that may read the draft and not write it. The discussion
         controls must survive applyEditability, which strips every editing
         control from the pane — commenting is a different capability. */
      const real = canEditHere;
      window.canEditHere = () => false;
      State.tab = "discussion"; State.tabTouched = true;
      try { renderDetail(); } finally { window.canEditHere = real; }
      const body = document.getElementById("tabbody");
      return {
        reply: !!body.querySelector("[data-dsend]"),
        resolve: !!body.querySelector("[data-dstate]"),
        startBox: !!body.querySelector("#dStart"),
        addLabel: !!body.querySelector("[data-addlabel]")
      };
    });
    expect(out.reply).toBe(true);
    expect(out.resolve).toBe(true);
    expect(out.startBox).toBe(true);
    expect(out.addLabel).toBe(false);
  });

  test("joining the discussion is its own capability", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const out = await page.evaluate(() => {
      State.mode = "live"; State.db = "testdb";
      const gs = schemeGraphs(schemeById(State.schemeId));
      const needs = (k) => grantsForLevel(k, gs).map((n) => n.join(" "));
      return {
        discuss: needs("discuss"),
        follow: needs("follow"),
        impliedByEdit: levelsImpliedBy(["edit"]),
        impliedByDiscuss: levelsImpliedBy(["discuss"])
      };
    });
    /* Commenting writes, so it needs the discussion graph — and, like every
       write in this app, the change log and the revision bookkeeping. */
    expect(out.discuss.some((n) => /WRITE named-graph urn:taxonomy:app:comments/.test(n))).toBe(true);
    expect(out.discuss.some((n) => /WRITE named-graph urn:taxonomy:app:audit/.test(n))).toBe(true);
    expect(out.discuss.some((n) => /WRITE named-graph urn:taxonomy:app:sessions/.test(n))).toBe(true);
    /* And "See the draft" stays a genuine read: no write anywhere in it. */
    expect(out.follow.some((n) => /^WRITE/.test(n))).toBe(false);
    /* Editing covers it; commenting does not cover editing. */
    expect(out.impliedByEdit).toContain("discuss");
    expect(out.impliedByDiscuss).not.toContain("edit");
    expect(out.impliedByDiscuss).toContain("follow");
  });
});

test.describe("Writing from the Discussions screen", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  const openScreen = async (page) => {
    await page.evaluate(() => openDiscussions());
    await A.waitModal(page, "Discussions");
  };

  test("a reply appears, and the box it was typed in is empty again", async ({ page }) => {
    /* commit() re-renders the tree and detail pane, which is why the same
       controls work on the Discussion tab. A dialog is not on that list, so
       the reply landed in the database and left the screen showing the thread
       without it — with the text still in the box, one keypress away from
       being posted twice. */
    await start(page, CONCEPT, "First question");
    await openScreen(page);
    await page.fill("#modalRoot [data-dreply]", "A reply typed in the modal");
    await page.click("#modalRoot [data-dsend]");
    await page.waitForTimeout(150);
    expect(await A.modalText(page)).toContain("A reply typed in the modal");
    expect(await page.$eval("#modalRoot [data-dreply]", (t) => t.value)).toBe("");
  });

  test("resolving from the screen shows it as resolved", async ({ page }) => {
    await start(page, CONCEPT, "Settle this");
    await openScreen(page);
    await page.click("#modalRoot [data-dstate]");
    await page.waitForTimeout(150);
    const pills = await page.$$eval("#modalRoot .thread .pill", (e) => e.map((x) => x.textContent.trim()));
    expect(pills).toContain("resolved");
    expect(await page.$eval("#modalRoot [data-dstate]", (b) => b.textContent.trim())).toBe("Reopen");
  });

  test("and it does not scroll back to the top under you", async ({ page }) => {
    /* Repainting in place rather than reopening the dialog: on a screen whose
       whole point is a list of conversations, being thrown back to the top is
       most of what the reader was looking at. */
    for (let i = 0; i < 30; i++) await start(page, CONCEPT, "Question " + i);
    await openScreen(page);
    const before = await page.$eval("#modalRoot .modal-body", (b) => {
      b.scrollTop = Math.floor(b.scrollHeight / 2);
      return b.scrollTop;
    });
    expect(before).toBeGreaterThan(0);         // the list really is long enough to scroll
    /* Dispatched rather than page.click: Playwright scrolls a target into view
       before clicking it, which would move the very thing being measured. */
    await page.evaluate(() => document.querySelector("#modalRoot [data-dstate]").click());
    await page.waitForTimeout(150);
    expect(await page.$eval("#modalRoot .modal-body", (b) => b.scrollTop)).toBe(before);
  });

  test("the count in the subtitle keeps up", async ({ page }) => {
    await start(page, CONCEPT, "One");
    await openScreen(page);
    expect(await page.$eval("#modalRoot .modal-head p", (p) => p.textContent)).toMatch(/^1 open/);
    await page.click("#modalRoot [data-dstate]");
    await page.waitForTimeout(150);
    expect(await page.$eval("#modalRoot .modal-head p", (p) => p.textContent)).toMatch(/^Nothing open/);
  });

  test("the notification scan only reads this vocabulary's threads", async ({ page }) => {
    /* One graph holds the discussion for every vocabulary in the database, on
       purpose. Reading all of them on every notification refresh and throwing
       most away is a full scan on a keystroke's budget. */
    await start(page, CONCEPT, "In plant-conservation");
    await A.switchScheme(page, "regions");
    await page.evaluate(async () => Discussion.start({ concept: topConcepts()[0], text: "In geography" }));
    const out = await page.evaluate(() => {
      const real = Discussion.read;
      let reads = 0;
      Discussion.read = (x) => { reads++; return real(x); };
      try { return { threads: Discussion.inScheme("regions").length, reads }; }
      finally { Discussion.read = real; }
    });
    expect(out.threads).toBe(1);
    expect(out.reads).toBe(1);              // not 2 — the other vocabulary is never read
  });
});
