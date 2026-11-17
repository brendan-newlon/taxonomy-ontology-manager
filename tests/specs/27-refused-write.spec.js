const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * What happens when the server says no.
 *
 * Reported from a live session: a colleague who could read the vocabulary
 * typed a term, pressed OK, and nothing happened. The button looked broken.
 *
 * It was not the button. `Backend.apply` **throws** when a write is refused,
 * and `commit()` did not catch — so the dialog closed, the update came back
 * 403, and the only trace anywhere was an unhandled promise rejection in a
 * console nobody had open. Every editing gesture in the app ends at that one
 * function, so every kind of refusal was silent: a permission, an expired
 * session, a database that went away, a dropped connection.
 *
 * The second half is why they were offered the edit at all.
 * `/admin/permissions/effective/user/{me}` is an *administrator's* endpoint,
 * so for most people it answers 403 and every permission question comes back
 * `null` — "cannot tell from here". Guessing "no" would hide a vocabulary
 * someone can actually see, so the controls stay on. A refusal settles it:
 * it is a measurement, and it outranks not knowing.
 */

/** Live mode with a server that refuses everything. */
const refusing = (page, status) => page.evaluate((st) => {
  window.__unhandled = [];
  window.onunhandledrejection = (e) =>
    window.__unhandled.push(String((e.reason && e.reason.message) || e.reason));
  State.mode = "live";
  State.db = "testdb";
  State.conn = Object.assign({}, State.conn, { user: "tester", endpoint: "https://x.test" });
  Perms.reset();                       // their own permissions are not theirs to read
  window.__realRequest = Backend.request;
  Backend.request = async () => { const e = new Error("Permission denied"); e.status = st; throw e; };
}, status === undefined ? 403 : status);

const restore = (page) => page.evaluate(() => {
  if (window.__realRequest) Backend.request = window.__realRequest;
  Perms.reset();
});

/** Type a term into the New concept dialog and press OK, as a user would. */
async function tryToAdd(page, label) {
  await page.evaluate(() => document.getElementById("btnNewConcept").click());
  await A.waitModal(page, "New concept");
  await page.fill("#mText", label);
  await A.modalOk(page);
  await page.waitForTimeout(500);
}

test.describe("A write the server refuses", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });
  test.afterEach(async ({ page }) => { await restore(page); });

  test("the app offers the edit, because it genuinely cannot tell yet", async ({ page }) => {
    await refusing(page);
    /* Not a bug: an account whose permissions cannot be read gets the
       controls, because guessing "no" would hide work someone can do. */
    expect(await page.evaluate(() => canEditHere())).toBe(true);
    expect(await page.evaluate(() =>
      Perms.forScheme(schemeById(State.schemeId)).writeDraft)).toBeNull();
  });

  test("pressing OK says something, instead of nothing", async ({ page }) => {
    await refusing(page);
    await tryToAdd(page, "American Cheese");
    const text = await A.modalText(page);
    expect(text).toMatch(/not allowed to change this/i);
    expect(text).toMatch(/Nothing was written/i);
  });

  test("and the refusal does not vanish into an unhandled rejection", async ({ page }) => {
    await refusing(page);
    await tryToAdd(page, "American Cheese");
    expect(await page.evaluate(() => window.__unhandled)).toEqual([]);
  });

  test("the editing controls switch off, so it cannot happen twice", async ({ page }) => {
    await refusing(page);
    expect(await page.evaluate(() => document.getElementById("btnNewConcept").disabled)).toBe(false);
    await tryToAdd(page, "American Cheese");
    await page.click("#mCancel");          // the notice has one button, and it is Close
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => canEditHere())).toBe(false);
    expect(await page.evaluate(() => document.getElementById("btnNewConcept").disabled)).toBe(true);
    expect(await page.evaluate(() => document.getElementById("btnNewConcept").title))
      .toMatch(/read-only for your account/i);
  });

  test("only the graph that was refused is marked, not every graph", async ({ page }) => {
    await refusing(page);
    await tryToAdd(page, "American Cheese");
    const out = await page.evaluate(() => ({
      refused: [...Perms.refused],
      here: currentGraph(),
      draft: Perms.canWrite(currentGraph()),
      somewhereElse: Perms.canWrite("urn:taxonomy:scheme:something-else:draft")
    }));
    expect(out.refused).toContain(out.here);
    expect(out.draft).toBe(false);
    expect(out.somewhereElse).toBeNull();      // still unknown, not assumed
  });

  test("nothing was written locally either", async ({ page }) => {
    await refusing(page);
    const before = await page.evaluate(() => allConcepts().length);
    await tryToAdd(page, "American Cheese");
    expect(await page.evaluate(() => allConcepts().length)).toBe(before);
  });

  test("a failure that is not a permission is reported as itself", async ({ page }) => {
    await refusing(page, 503);
    await tryToAdd(page, "American Cheese");
    /* No claim about permissions from a server that fell over. */
    expect(await page.evaluate(() => canEditHere())).toBe(true);
    expect(await A.toasts(page)).toMatch(/not saved/i);
  });
});

test.describe("An account that is allowed is not affected", () => {
  test("a session whose writes go through still edits", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const n = await page.evaluate(() => allConcepts().length);
    await tryToAdd(page, "Perfectly Fine Term");
    expect(await page.evaluate(() => allConcepts().length)).toBe(n + 1);
    expect(await page.evaluate(() => window.__unhandled || [])).toEqual([]);
  });
});

test.describe("Waiting for something slow", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a wait dialog has something moving on it", async ({ page }) => {
    const out = await page.evaluate(async () => {
      const w = openWaitModal("Reading testdb…", "Nothing is written.");
      const sp = document.querySelector(".modal .spinner");
      const r = {
        hasSpinner: !!sp,
        animated: sp ? getComputedStyle(sp).animationName : null,
        text: document.querySelector(".modal").textContent.replace(/\s+/g, " ").trim()
      };
      w.close();
      r.closed = !document.querySelector(".modal");
      return r;
    });
    expect(out.hasSpinner).toBe(true);
    expect(out.animated).toBe("spin");
    expect(out.text).toContain("Reading testdb");
    expect(out.closed).toBe(true);
  });

  test("a multi-stage job can keep saying which stage it is on", async ({ page }) => {
    const out = await page.evaluate(async () => {
      const w = openWaitModal("Reading testdb…", "Checking what this account can reach.");
      const first = document.querySelector(".modal").textContent;
      w.say("Opening Sustainable Development…", "In testdb.");
      const second = document.querySelector(".modal").textContent;
      w.close();
      /* And a stale handle cannot paint over whatever came next. */
      openModal({ title: "Something else", body: "", okText: "Close" });
      w.say("Too late", "should not appear");
      const after = document.querySelector(".modal").textContent;
      document.getElementById("mOk").click();
      return { first, second, after };
    });
    expect(out.first).toContain("Reading testdb");
    expect(out.second).toContain("Opening Sustainable Development");
    expect(out.second).not.toContain("Checking what this account");
    expect(out.after).toContain("Something else");
    expect(out.after).not.toContain("Too late");
  });
});
