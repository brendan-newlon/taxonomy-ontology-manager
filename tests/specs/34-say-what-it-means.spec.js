const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * Four things a user reported, all of them the same failure in different
 * clothes: the app said something that was not true, or said nothing at all.
 *
 *  - 93 findings on a freshly imported vocabulary disabled the only Publish
 *    button in the app, with a tooltip reading "blocked by validation
 *    findings". Publishing was in fact never gated on them — a release is a
 *    snapshot of the *approved* copy and those findings were on the draft —
 *    so the button was refusing on a rule that did not exist.
 *  - the notification offering to fix it, "Show validation", un-collapsed a
 *    pane that was already open. There was no list of findings anywhere for
 *    it to show.
 *  - the tree marked rows `poly` and `dep`, and in restrained mode drew a
 *    glyph *next to* the word, so the tree read "poly⑂" and "dep⊘".
 *  - an account that could read a discussion but not add to it was told
 *    exactly that and nothing else — no capability named, no route out.
 */

const SDG = "plant-conservation";

test.describe("A release is not held hostage by the draft", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: SDG }); });

  test("the Publish button is live even with findings outstanding", async ({ page }) => {
    /* Make sure there is something to be gated on, so this is not passing by
       accident on a clean vocabulary. */
    const gate = await page.evaluate(() => {
      const c = allConcepts()[0];
      State.issues.push({ concept: c, tier: "gate", rule: "test-rule", text: "Something to fix" });
      renderCtx();
      return State.issues.filter((i) => i.tier === "gate").length;
    });
    expect(gate).toBeGreaterThan(0);

    const btn = await page.$("#btnPublish");
    expect(btn).not.toBeNull();
    expect(await btn.isDisabled()).toBe(false);
    expect(await btn.getAttribute("title")).not.toMatch(/block/i);
  });

  test("publishing is in the vocabulary menu, not only inside a folded panel", async ({ page }) => {
    await page.click("#btnMenu");
    const items = await page.$$eval(".menu .menu-item", (els) => els.map((e) => e.textContent.trim()));
    expect(items.join(" | ")).toMatch(/Publish a release/);
    await page.keyboard.press("Escape");
  });

  test("the notification says what is true, and its button reaches the findings", async ({ page }) => {
    const note = await page.evaluate(() => {
      const c = allConcepts()[0];
      State.issues.push({ concept: c, tier: "gate", rule: "test-rule", text: "Something to fix" });
      computeNotifications();
      return State.notifications.find((n) => n.id === "gate");
    });
    expect(note).toBeTruthy();
    /* It used to say "blocking publication", which nothing did. */
    expect(note.text).not.toMatch(/block/i);
    expect(note.action).toBe("Show findings");

    await page.evaluate(() => State.notifications.find((n) => n.id === "gate").run());
    await A.waitModal(page, "Quality");
    const txt = await A.modalText(page);
    expect(txt).toMatch(/Something to fix/);
    /* And it says outright that none of them stand in the way. */
    expect(txt).toMatch(/None of these stops a release/i);
  });

  test("the dialog reports the findings rather than refusing", async ({ page }) => {
    await page.evaluate(async () => {
      const some = allConcepts().slice(0, 3);
      const r = await Review.submit({ concepts: some, note: "batch" });
      await Review.approve(r, "fine");
      State.issues.push({ concept: some[0], tier: "gate", rule: "test-rule", text: "Something to fix" });
    });
    await page.evaluate(() => openPublish());
    await A.waitModal(page, "Publish");
    const txt = await A.modalText(page);
    expect(txt).toMatch(/this can still go ahead/i);
    expect(await page.$("#mOk")).not.toBeNull();      // a real button, not a dead end
    await A.modalCancel(page);
  });
});

test.describe("The marks in the tree are words", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: SDG }); });

  test("a term with two parents says so, and says it in both densities", async ({ page }) => {
    const c = await page.evaluate(() => {
      const c = allConcepts().find((x) => broaderOf(x).length === 1);
      const other = topConcepts().find((t) => t !== broaderOf(c)[0]);
      State.store.add(currentGraph(), iri(c), P("skos:broader"), iri(other));
      State.expanded = new Set(allConcepts());
      renderTree();
      return c;
    });
    const row = await A.treeRow(page, c);
    expect(row.flagText).toContain("2 parents");
    expect(row.flags).not.toContain("poly");

    /* Restrained mode used to keep the word *and* add a glyph on top of it. */
    await page.evaluate(() => { document.body.classList.add("ui-restrained"); });
    const after = await page.$eval(
      `#tree .trow[data-c="${c.replace(/"/g, '\\"')}"] .tflag.parents`,
      (el) => ({ text: el.textContent, extra: getComputedStyle(el, "::after").content }));
    expect(after.text).toBe("2 parents");
    expect(after.extra === "none" || after.extra === "" || after.extra === "normal").toBe(true);
  });

  test("clicking it opens the pane that lists where else the term is", async ({ page }) => {
    const c = await page.evaluate(() => {
      const c = allConcepts().find((x) => broaderOf(x).length === 1);
      const other = topConcepts().find((t) => t !== broaderOf(c)[0]);
      State.store.add(currentGraph(), iri(c), P("skos:broader"), iri(other));
      State.expanded = new Set(allConcepts());
      State.ui.ctxCollapsed = true; applyUiPrefs();
      renderTree();
      return c;
    });
    await page.click(`#tree .trow[data-c="${c.replace(/"/g, '\\"')}"] .tflag.parents`);
    expect(await page.evaluate(() => State.ui.ctxCollapsed)).toBe(false);
    expect(await page.evaluate(() => State.selected)).toBe(c);
    /* The answer is in the pane: every broader concept, each one a link. */
    const links = await page.$$eval("#ctx [data-goto2]", (a) => a.length);
    expect(links).toBe(2);
  });

  test("a deprecated term is marked with the word, not an abbreviation", async ({ page }) => {
    const c = await page.evaluate(() => {
      const c = topConcepts()[0];
      const g = currentGraph();
      State.store.match(g, iri(c), P("tax:lifecycleStatus"), null)
        .forEach((q) => State.store.remove(g, q.s, q.p, q.o));
      State.store.add(g, iri(c), P("tax:lifecycleStatus"), lit("deprecated"));
      renderTree();
      return c;
    });
    const row = await A.treeRow(page, c);
    expect(row.flagText).toContain("deprecated");
  });

  test("nothing in the tree is one of the retired abbreviations", async ({ page }) => {
    await page.evaluate(() => { State.expanded = new Set(allConcepts()); renderTree(); });
    const flags = await page.$$eval("#tree .tflag", (els) => els.map((e) => e.textContent.trim()));
    flags.forEach((f) => expect(["poly", "dep", "!"]).not.toContain(f));
  });
});

test.describe("Being unable to comment is a sentence you can act on", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: SDG }); });

  /** A live session holding every grant except a write on the discussion graph. */
  const noComment = (page) => page.evaluate(() => {
    State.mode = "live";
    State.db = "testdb";
    State.conn = Object.assign({}, State.conn, { user: "tester", endpoint: "https://x.test" });
    Perms.reset();
    Perms.loaded = true;
    Perms.readable = true;
    Perms.entries = [{ action: "READ", type: "named-graph", resources: ["testdb", G.comments] }];
  });

  test("the tab names the capability and offers the screen that grants it", async ({ page }) => {
    await noComment(page);
    expect(await page.evaluate(() => canDiscussHere())).toBe(false);
    const html = await page.evaluate(() => discussBlockedHtml());
    expect(html).toMatch(/Join the discussion/);
    /* It is its own capability, which is the part that surprises people:
       an account that can edit the vocabulary still may not comment on it. */
    expect(html).toMatch(/its own capability/i);
    expect(html).not.toMatch(/part-granted/i);
    expect(html).toMatch(/Roles/);
  });

  test("the vocabulary-wide screen says it too, instead of just losing every reply box",
    async ({ page }) => {
      await noComment(page);
      await page.evaluate(() => openDiscussions());
      await A.waitModal(page, "Discussions");
      expect(await A.modalText(page)).toMatch(/Join the discussion/);
      await A.modalCancel(page);
    });
});
