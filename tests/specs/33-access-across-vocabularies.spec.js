const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * Two things an administrator needed and did not have.
 *
 * Setting a new colleague up across four vocabularies meant opening the same
 * dialog four times, switching vocabulary in between — the same work four
 * times, and the easiest possible place to forget one. And a database's graph
 * list showed somebody's vocabulary and this app's own bookkeeping as equally
 * anonymous URNs, which is the picture you want *before* granting anything.
 */

/** Open one person's panel with the admin API stubbed, and return what was sent. */
async function person(page, opts = {}) {
  return page.evaluate(async (o) => {
    State.mode = "live";
    State.db = "testdb";
    State.conn = Object.assign({}, State.conn, { user: "lead", endpoint: "https://example.test:5820" });
    const sent = [];
    const real = Backend.request;
    Backend.request = async (r) => {
      sent.push({ method: r.method || "GET", path: r.path, body: r.body });
      if (r.path === "/admin/roles") return { ok: true, json: async () => ({ roles: o.roles || [] }) };
      if (/^\/admin\/permissions\/role\//.test(r.path)) return { ok: true, json: async () => ({ permissions: [] }) };
      if (r.path === "/admin/users/marta")
        return { ok: true, json: async () => ({ enabled: true, roles: o.has || [], permissions: [] }) };
      return { ok: true, json: async () => ({}), text: async () => "{}" };
    };
    try { await openPersonPanel("marta"); } finally { Backend.request = real; }
    window.__sent = sent;
    return sent.length;
  }, opts);
}

/** Stand in for setAccess so a Save can be observed without a server. */
const captureSaves = (page) => page.evaluate(() => {
  window.__saves = [];
  window.__realSetAccess = window.setAccess;
  window.setAccess = async (who, keys, schemeId) => {
    window.__saves.push({ who, keys, schemeId });
    return { roles: [], failed: [], all: [] };
  };
});
const saves = (page) => page.evaluate(() => {
  if (window.__realSetAccess) window.setAccess = window.__realSetAccess;
  return window.__saves || [];
});

test.describe("One person, every vocabulary", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("there is a checklist for each vocabulary, not just the open one", async ({ page }) => {
    await person(page);
    const lists = await page.$$eval("#modalRoot .lvlist[data-lvscheme]", (e) => e.map((x) => x.dataset.lvscheme));
    const all = await page.evaluate(() => schemes().map((s) => s.id));
    expect(lists.sort()).toEqual(all.sort());
  });

  test("the one you came from is first and already open", async ({ page }) => {
    await person(page);
    const first = await page.$eval("#modalRoot .lvlist[data-lvscheme]", (e) => e.dataset.lvscheme);
    expect(first).toBe("plant-conservation");
    const open = await page.$$eval("#modalRoot .vocacc[open] .lvlist", (e) => e.map((x) => x.dataset.lvscheme));
    expect(open).toContain("plant-conservation");
  });

  test("a vocabulary they already have something on is open too", async ({ page }) => {
    const r = await A.roleName(page, "edit", "regions");
    await person(page, { roles: [r], has: [r] });
    const open = await page.$$eval("#modalRoot .vocacc[open] .lvlist", (e) => e.map((x) => x.dataset.lvscheme));
    expect(open).toContain("regions");
  });

  test("each vocabulary's summary says what they can do there", async ({ page }) => {
    const r = await A.roleName(page, "edit", "plant-conservation");
    await person(page, { roles: [r], has: [r] });
    const s = await page.$$eval("#modalRoot .vocacc > summary", (e) =>
      e.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
    expect(s.find((x) => /Plant Conservation/.test(x))).toMatch(/edit the draft/i);
    expect(s.filter((x) => /nothing yet/.test(x)).length).toBeGreaterThan(0);
  });

  test("entailment is per vocabulary and does not leak", async ({ page }) => {
    await person(page);
    const out = await page.evaluate(() => {
      const a = document.querySelector('#modalRoot .lvlist[data-lvscheme="plant-conservation"]');
      const b = document.querySelector('#modalRoot .lvlist[data-lvscheme="regions"]');
      const box = a.querySelector('[data-lvl="edit"]');
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
      const locked = (l) => [...l.querySelectorAll("[data-lvl]")].filter((x) => x.disabled).map((x) => x.dataset.lvl);
      return { a: locked(a), b: locked(b) };
    });
    /* Editing one vocabulary covers reading it. It says nothing at all about
       what somebody may do to another one. */
    expect(out.a).toContain("follow");
    expect(out.a).toContain("discuss");
    expect(out.b).toEqual([]);
  });

  test("reading the screen and pressing Save writes nothing", async ({ page }) => {
    /* The trap: holding `edit` makes the entailment pass tick and lock "See
       the draft", so the boxes legitimately say more than the role list does.
       Comparing against the roles would call that a change on every open. */
    const r = await A.roleName(page, "edit", "plant-conservation");
    await person(page, { roles: [r], has: [r] });
    await captureSaves(page);
    await page.click("#mOk");
    await page.waitForTimeout(200);
    expect(await saves(page)).toEqual([]);
    expect(await A.toasts(page)).toMatch(/Nothing changed for marta/);
  });

  test("only the vocabularies you actually touched are written", async ({ page }) => {
    await person(page);
    await page.evaluate(() => {
      const b = document.querySelector('#modalRoot .lvlist[data-lvscheme="regions"] [data-lvl="approve"]');
      b.checked = true;
      b.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await captureSaves(page);
    await page.click("#mOk");
    await page.waitForTimeout(250);
    const out = await saves(page);
    expect(out).toHaveLength(1);
    expect(out[0].schemeId).toBe("regions");
    expect(out[0].keys).toContain("approve");
  });

  test("two vocabularies in one visit are two grants and one report", async ({ page }) => {
    await person(page);
    await page.evaluate(() => {
      for (const [id, lvl] of [["plant-conservation", "edit"], ["pub-series", "follow"]]) {
        const b = document.querySelector(`#modalRoot .lvlist[data-lvscheme="${id}"] [data-lvl="${lvl}"]`);
        b.checked = true;
        b.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await captureSaves(page);
    await page.click("#mOk");
    await page.waitForTimeout(300);
    const out = await saves(page);
    expect(out.map((x) => x.schemeId).sort()).toEqual(["plant-conservation", "pub-series"]);
    expect(await A.toasts(page)).toMatch(/2 vocabularies/);
  });
});

test.describe("Every capability that writes can actually write", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("each one asks for the change log and the revision bookkeeping", async ({ page }) => {
    /* Every write in this app stamps the graph's revision into the session
       graph and its audit event into the change log, in the same transaction.
       Only `edit` used to ask for the session graph — so approving, importing,
       publishing and changing the rules were each one grant short of working,
       and would have been refused on their first action. */
    const out = await page.evaluate(() => {
      State.mode = "live"; State.db = "testdb";
      const gs = schemeGraphs(schemeById(State.schemeId));
      const writes = ["discuss", "edit", "import", "approve", "publish", "rules"];
      const missing = {};
      for (const k of writes) {
        const have = new Set(grantsForLevel(k, gs).map((n) => n.join(" ")));
        missing[k] = [
          ["WRITE", "named-graph", G.sessions].join(" "),
          ["READ", "named-graph", G.sessions].join(" "),
          ["WRITE", "named-graph", G.audit()].join(" "),
          ["READ", "named-graph", G.audit()].join(" ")
        ].filter((n) => !have.has(n));
      }
      return missing;
    });
    for (const [k, gaps] of Object.entries(out)) expect(gaps, `${k} is missing`).toEqual([]);
  });

  test("a capability that only reads asks for no write at all", async ({ page }) => {
    const out = await page.evaluate(() => {
      State.mode = "live"; State.db = "testdb";
      const gs = schemeGraphs(schemeById(State.schemeId));
      return { read: grantsForLevel("read", gs).map((n) => n[0]),
               follow: grantsForLevel("follow", gs).map((n) => n[0]) };
    });
    expect(out.read).not.toContain("WRITE");
    expect(out.follow).not.toContain("WRITE");
  });

  test("publishing can create the release graph it is about to name", async ({ page }) => {
    /* A release graph's name carries its version, so it is minted at publish
       time — and Stardog has no prefix wildcard, so it can never have been
       granted in advance. The database-level write is what makes it possible. */
    const out = await page.evaluate(() => {
      State.mode = "live"; State.db = "testdb";
      const gs = schemeGraphs(schemeById(State.schemeId));
      return grantsForLevel("publish", gs).map((n) => n.join(" "));
    });
    expect(out).toContain("WRITE db");
    expect(out.some((n) => /WRITE named-graph urn:taxonomy:app:config/.test(n))).toBe(true);
  });
});

test.describe("What is in this database", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("a vocabulary's graphs and the app's bookkeeping are told apart", async ({ page }) => {
    const { roles: out, appGraphs } = await page.evaluate(() => {
      const appGraphs = [G.config, G.sessions, G.audit(), G.reviews, G.comments, G.loads];
      const probe = [
        "urn:taxonomy:scheme:plant-conservation:draft",
        "urn:taxonomy:scheme:plant-conservation:approved",
        "urn:taxonomy:scheme:plant-conservation:published",
        "urn:taxonomy:scheme:plant-conservation:shapes",
        "urn:taxonomy:scheme:plant-conservation:incoming",
        "urn:taxonomy:scheme:plant-conservation:provenance",
        "urn:taxonomy:scheme:plant-conservation:release:v2026-01-01",
        ...appGraphs,
        "urn:taxonomy:tags:library",
        "urn:someone:elses:graph"
      ];
      return { appGraphs, roles: probe.map((g) => [g, graphRole(g)]) };
    });
    const by = Object.fromEntries(out);
    expect(by["urn:taxonomy:scheme:plant-conservation:draft"]).toEqual(
      { kind: "vocabulary", scheme: "plant-conservation", role: "working draft" });
    expect(by["urn:taxonomy:scheme:plant-conservation:release:v2026-01-01"].frozen).toBe(true);
    expect(by["urn:taxonomy:scheme:plant-conservation:release:v2026-01-01"].role).toBe("release v2026-01-01");
    /* Everything the app keeps for itself, named as such — nothing here is
       anybody's project, and taking it away breaks every editor. */
    for (const g of appGraphs) expect(by[g].kind, g).toBe("app");
    expect(by["urn:taxonomy:tags:library"].role).toMatch(/library/);
    expect(by["urn:someone:elses:graph"]).toEqual({ kind: "other", role: null });
  });

  test("every graph a vocabulary uses has a name for what it is", async ({ page }) => {
    const out = await page.evaluate(() => {
      const gs = schemeGraphs(schemeById(State.schemeId));
      return Object.entries(gs).map(([k, g]) => [k, graphRole(g).role]);
    });
    for (const [k, role] of out) expect(role, k).toBeTruthy();
  });

  test("the screen groups by vocabulary, then the app's own records", async ({ page }) => {
    await page.evaluate(async () => { State.db = "testdb"; Caps.graphs = null; await openGraphInventory(); });
    await A.waitModal(page, "What is in");
    const heads = await page.$$eval("#modalRoot h3", (e) => e.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
    expect(heads).toContain("Plant Conservation and Sustainable Agriculture");
    expect(heads).toContain("This app's own records");
    const txt = await A.modalText(page);
    expect(txt).toMatch(/working draft/);
    expect(txt).toMatch(/change log/);
  });

  test("and reading it writes nothing", async ({ page }) => {
    const before = await A.quadCount(page);
    await page.evaluate(async () => { State.db = "testdb"; Caps.graphs = null; await openGraphInventory(); });
    await A.waitModal(page, "What is in");
    await A.modalCancel(page);
    expect(await A.quadCount(page)).toBe(before);
  });
});
