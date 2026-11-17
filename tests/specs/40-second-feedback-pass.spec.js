const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * A second round of user feedback after PR #29/#30 shipped the multi-scheme
 * tree, Triples tab and SPARQL console. Ten reports, ten fixes:
 *
 *  1. auditEvent() now asserts rdfs:label on the actor resource, and both
 *     read paths (allAuditEvents() for mock/offline, sparqlAuditEvents() for
 *     live) prefer it over parsing the actor IRI's slug.
 *  2. beginCreateDatabase(), reached from switchDatabase() on an
 *     already-open workspace, now resets the tree/detail panes instead of
 *     leaving the previous database's content on screen.
 *  3/4. openSparqlConsole() gained Run/Stop (an AbortController threaded
 *     through Backend.request) and a minimize lifecycle mirroring
 *     minimizeImport() — backdrop/Escape preserves text+results behind a
 *     header button, the footer's Close discards them.
 *  5. The Scheme health pills are buttons wired to openQuality("findings")
 *     rather than inert text.
 *  6. The Publish button's title explains the draft/release distinction.
 *  7. The header's copy-IRI button is hidden until the IRI itself is
 *     hovered or focused (superseded by iriChip() — see
 *     41-third-feedback-pass.spec.js — which generalised this to every
 *     instance IRI shown anywhere in the app).
 *  8. The Relations tab ends with a cross-reference to Mappings for
 *     exactMatch/closeMatch/etc., wired via [data-goto-tab].
 *  9. The "+" button and tree-pane title are contextual on State.treeMode;
 *     Collections got a real "New collection" creation path it never had.
 * 10. The hierarchy filter's property/language <select> is never disabled;
 *     picking a value while mode is "all" now activates "has" itself
 *     instead of silently doing nothing.
 */

async function goLive(page, db) {
  await page.evaluate((database) => {
    window.__calls = [];
    State.mode = "live";
    State.db = database;
    State.conn = Object.assign({}, State.conn, { user: "tester", endpoint: "https://x.test" });
    window.__realRequest = Backend.request;
    Backend.request = async (o) => {
      window.__calls.push({ method: o.method || "GET", path: o.path });
      if (/\/transaction\/begin$/.test(o.path)) return { ok: true, text: async () => "tx-1" };
      return { ok: true, text: async () => "tx-1", json: async () => ({ boolean: true }) };
    };
  }, db);
}
async function goOffLive(page) {
  await page.evaluate(() => { if (window.__realRequest) Backend.request = window.__realRequest; });
}

test.describe("Change log shows who really did it", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a real username is asserted as rdfs:label on the actor, not just slugged into its IRI", async ({ page }) => {
    const who = "alex.rivera@example.org";
    const found = await page.evaluate((user) => {
      State.conn = Object.assign({}, State.conn, { user });
      const ev = auditEvent({ action: "AddProperty", subject: sdgConcept(), property: P("dct:source"), newValue: lit("x") });
      const label = ev.triples.find((t) => t.p.v.endsWith("label") && t.o.v === user);
      return !!label;
      function sdgConcept() { return allConcepts()[0]; }
    }, who);
    expect(found).toBe(true);
  });

  test("allAuditEvents() (mock/offline) reads the label back instead of the IRI tail", async ({ page }) => {
    const who = "alex.rivera@example.org";
    const c = await A.allConcepts(page).then((cs) => cs[0]);
    await page.evaluate(([user, concept]) => {
      State.conn = Object.assign({}, State.conn, { user });
      const ev = auditEvent({ action: "AddProperty", subject: concept, property: P("dct:source"), newValue: lit("verify-me") });
      ev.triples.forEach((t) => State.store.add(G.audit(), t.s, t.p, t.o));
    }, [who, c]);
    const events = await page.evaluate(() => allAuditEvents());
    const mine = events.find((e) => e.newValue === "verify-me");
    expect(mine.who).toBe(who);
  });
});

test.describe("Switching databases refreshes the workspace", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });
  test.afterEach(async ({ page }) => { await goOffLive(page); });

  test("beginCreateDatabase() from an already-open workspace clears the previous database's tree and selection", async ({ page }) => {
    await goLive(page, "old-db");
    await A.clickRow(page, await A.allConcepts(page).then((cs) => cs[0]));
    expect(await page.evaluate(() => State.selected)).not.toBeNull();
    expect(await page.$$eval("#tree .trow", (r) => r.length)).toBeGreaterThan(0);

    await page.evaluate(() => {
      window.__realCreateDatabaseSilently = createDatabaseSilently;
      createDatabaseSilently = () => Promise.resolve(true);
      window.__realOpenNameVocabularyModal = openNameVocabularyModal;
      openNameVocabularyModal = () => {};
      beginCreateDatabase("brand_new_db");
    });

    expect(await page.evaluate(() => State.selected)).toBeNull();
    expect(await page.$$eval("#tree .trow", (r) => r.length)).toBe(0);
    expect(await page.evaluate(() => State.db)).toBe("brand_new_db");

    await page.evaluate(() => {
      createDatabaseSilently = window.__realCreateDatabaseSilently;
      openNameVocabularyModal = window.__realOpenNameVocabularyModal;
    });
  });
});

test.describe("SPARQL console: Stop, and minimize instead of losing results", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("Run becomes Stop while a query is in flight, and Stop aborts it cleanly", async ({ page }) => {
    // Mocks Backend.queryOn directly rather than fetch/AbortController — the
    // console's own Run/Stop wiring and its "Stopped" message are what this
    // asserts; the signal composition inside Backend.request is plain
    // boilerplate covered by the other guarded-write specs.
    await page.evaluate(() => {
      window.__realRequest = Backend.request;
      window.__realQueryOn = Backend.queryOn;
      Backend.request = async ({ path }) => {
        if (/\/admin\/databases$/.test(path)) return { ok: true, json: async () => ({ databases: ["testdb"] }) };
        throw new Error("unexpected request in this test: " + path);
      };
      Backend.queryOn = (db, sparql, why, signal) => new Promise((resolve, reject) => {
        const cancel = () => { const e = new Error("Cancelled."); e.cancelled = true; reject(e); };
        if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel);
      });
      openSparqlConsole();
    });
    await page.waitForSelector("#sqText");
    await page.fill("#sqText", "SELECT * WHERE { ?s ?p ?o }");
    await page.click("#sqRun");
    await page.waitForFunction(() => document.getElementById("sqRun").textContent === "Stop");
    await page.click("#sqRun");
    await page.waitForFunction(() => document.getElementById("sqRun").textContent === "Run");
    const resultsText = await page.$eval("#sqResults", (e) => e.textContent);
    expect(resultsText).toMatch(/Stopped/);
    await page.evaluate(() => { Backend.request = window.__realRequest; Backend.queryOn = window.__realQueryOn; });
  });

  test("clicking away minimizes the console behind a header button, preserving text and results", async ({ page }) => {
    await page.evaluate(() => openSparqlConsole());
    await page.waitForSelector("#sqText");
    await page.fill("#sqText", "SELECT * WHERE { ?s ?p ?o } LIMIT 1");
    await page.evaluate(() => { document.getElementById("sqResults").innerHTML = "<div>fake results</div>"; });
    await page.keyboard.press("Escape");
    await page.waitForSelector("#modalRoot .modal", { state: "detached" });
    expect(await page.$eval("#btnSparqlMini", (b) => b.classList.contains("hidden"))).toBe(false);

    await page.click("#btnSparqlMini");
    await page.waitForSelector("#sqText");
    expect(await page.$eval("#sqText", (e) => e.value)).toBe("SELECT * WHERE { ?s ?p ?o } LIMIT 1");
    expect(await page.$eval("#sqResults", (e) => e.innerHTML)).toContain("fake results");
  });

  test("the footer Close button discards the session instead of minimizing it", async ({ page }) => {
    await page.evaluate(() => openSparqlConsole());
    await page.waitForSelector("#sqText");
    await page.fill("#sqText", "SELECT * WHERE { ?s ?p ?o } LIMIT 1");
    await A.modalCancel(page);
    expect(await page.evaluate(() => SPARQL_CONSOLE)).toBeNull();
    expect(await page.$eval("#btnSparqlMini", (b) => b.classList.contains("hidden"))).toBe(true);
  });
});

test.describe("Scheme health pills act, and Publish explains itself", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a findings pill opens the Quality panel's findings section", async ({ page }) => {
    await page.evaluate(() => { State.selected = null; State.ui.healthOpen = true; renderDetail(); renderCtx(); });
    const pill = await page.$('#ctx [data-qtier="gate"]');
    test.skip(!pill, "no 'to resolve' findings in this scheme's mock data");
    await pill.click();
    await A.waitModal(page, "Quality");
    expect(await A.modalText(page)).toMatch(/FINDINGS/i);
  });

  test("Publish has a tooltip explaining the difference from live editing", async ({ page }) => {
    const title = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => /^Publish/.test(b.textContent.trim()));
      return btn && btn.title;
    });
    expect(title && title.length).toBeGreaterThan(20);
    expect(title).toMatch(/snapshot|release/i);
  });

  test("Re-run validation visibly runs, and reports what it found", async ({ page }) => {
    await page.evaluate(() => { State.selected = null; State.ui.healthOpen = true; renderDetail(); renderCtx(); });
    await page.click("#btnValidate");
    await page.waitForFunction(() => {
      const t = document.querySelectorAll(".toast, #toasts > *");
      return [...t].some((e) => /Validated/.test(e.textContent));
    });
    expect(await page.$eval("#btnValidate", (b) => b.disabled)).toBe(false);
  });
});

test.describe("Copy URI reveals on hover, next to the IRI itself", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the copy button is transparent until the IRI (not the title) is hovered", async ({ page }) => {
    const c = await A.allConcepts(page).then((cs) => cs[0]);
    await A.clickRow(page, c);
    await page.waitForSelector(".detail-meta .iri-copy-btn");
    expect(await page.$eval(".detail-meta .iri-copy-btn", (b) => getComputedStyle(b).opacity)).toBe("0");
    await page.hover(".detail-title h1");
    expect(await page.$eval(".detail-meta .iri-copy-btn", (b) => getComputedStyle(b).opacity)).toBe("0");
    await page.hover(".detail-meta .iri-chip");
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector(".detail-meta .iri-copy-btn")).opacity === "1");
  });

  test("clicking it copies the full IRI, not the shortened display text", async ({ page }) => {
    const c = await A.allConcepts(page).then((cs) => cs[0]);
    await A.clickRow(page, c);
    await page.click(".detail-meta .iri-copy-btn");
    expect(await page.evaluate(() => window.__clipboard)).toBe(c);
  });
});

test.describe("Relations tab points to Mappings for cross-vocabulary matches", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("the note is present and clicking it switches to the Mappings tab", async ({ page }) => {
    await A.clickRow(page, await A.allConcepts(page).then((cs) => cs[0]));
    await A.selectTab(page, "relations");
    const note = await page.$eval("#tabbody", (e) => e.textContent);
    expect(note).toMatch(/exact.*close.*broader.*narrower.*related/i);
    await page.click('#tabbody [data-goto-tab="mappings"]');
    expect(await page.evaluate(() => State.tab)).toBe("mappings");
  });
});

test.describe("The '+' button and tree title are contextual", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("Hierarchy shows Concepts / New concept", async ({ page }) => {
    expect(await page.$eval("#treePaneTitle", (e) => e.textContent)).toBe("Concepts");
    expect(await page.$eval("#btnNewConcept", (e) => e.classList.contains("hidden"))).toBe(false);
  });

  test("Collections shows Collections / New collection, and + actually creates one", async ({ page }) => {
    await page.click('[data-tm="collections"]');
    expect(await page.$eval("#treePaneTitle", (e) => e.textContent)).toBe("Collections");
    expect(await page.$eval("#btnNewConcept", (e) => e.title)).toBe("New collection");
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New collection");
  });

  test("Classes shows Classes, and + creates a class (fourth feedback pass)", async ({ page }) => {
    await page.click('[data-tm="classes"]');
    expect(await page.$eval("#treePaneTitle", (e) => e.textContent)).toBe("Classes");
    // Was unconditionally hidden — see 42-fourth-feedback-pass.spec.js for
    // the full "New class" flow this button now reaches (newClassPrompt()).
    expect(await page.$eval("#btnNewConcept", (e) => e.classList.contains("hidden"))).toBe(false);
    expect(await page.$eval("#btnNewConcept", (e) => e.title)).toBe("New class");
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New class");
  });
});

test.describe("The hierarchy filter's property dropdown is always usable", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("it is never disabled, even while mode is 'all'", async ({ page }) => {
    await page.click('[data-lf-toggle]');
    await page.waitForSelector("#lfProp");
    expect(await page.$eval("#lfProp", (e) => e.disabled)).toBe(false);
  });

  test("choosing a property while mode is 'all' activates 'has' on its own", async ({ page }) => {
    await page.click('[data-lf-toggle]');
    await page.waitForSelector("#lfProp");
    expect(await page.evaluate(() => State.treeFilter.mode)).toBe("all");
    await page.selectOption("#lfProp", "def");
    expect(await page.evaluate(() => State.treeFilter.mode)).toBe("has");
    expect(await page.evaluate(() => State.treeFilter.prop)).toBe("def");
  });
});
