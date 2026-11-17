const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * A second round from the same live session.
 *
 *  - clicking between two terms sent a query per click, and threw the answer
 *    away. The whole vocabulary was already in the tab.
 *  - publishing as a superuser failed with SE0012 on the release graph, which
 *    is a graph that did not exist until the publish tried to make it.
 *  - the roles matrix said "part" in every cell of every row, because every
 *    capability shares the three grants for reaching the database at all.
 *  - a role could be given "Approve" while "See the draft" was unticked.
 *  - roles were named `tax_…`, which reads as an abbreviation for taxation.
 */

const SDG = "plant-conservation";

/** Live mode against a recorder. Returns nothing; read `window.__calls`. */
const recording = (page, answers) => page.evaluate((ans) => {
  window.__calls = [];
  State.mode = "live";
  State.db = "testdb";
  State.conn = Object.assign({}, State.conn,
    { user: "tester", endpoint: "https://x.test", authMode: "basic" });
  window.__realRequest = Backend.request;
  Backend.request = async (o) => {
    const body = o.body && o.body.toString ? o.body.toString() : "";
    window.__calls.push({ method: o.method || "GET", path: o.path, body });
    const hit = Object.keys(ans || {}).find((k) => o.path.indexOf(k) >= 0);
    return {
      ok: true,
      text: async () => "tx-1",
      json: async () => (hit ? ans[hit] : { results: { bindings: [] } })
    };
  };
}, answers || {});

const restore = (page) => page.evaluate(() => {
  if (window.__realRequest) Backend.request = window.__realRequest;
});

test.describe("Browsing costs nothing it does not have to", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: SDG }); });
  test.afterEach(async ({ page }) => { await restore(page); });

  test("clicking between two terms in a fully loaded vocabulary sends no query",
    async ({ page }) => {
      const [a, b] = await page.evaluate(() => allConcepts().slice(0, 2));
      await recording(page, {});
      await page.evaluate(() => { Freshness.reset(); Freshness.checkedAt = performance.now(); });
      for (let i = 0; i < 6; i++) {
        await page.evaluate((c) => selectConcept(c), i % 2 ? a : b);
      }
      await page.waitForTimeout(150);
      /* Six clicks. The freshness clock has not come round, and everything on
         screen is already here, so there is nothing to ask anybody. */
      expect(await page.evaluate(() => window.__calls.length)).toBe(0);
    });

  test("many clicks inside one freshness window ask once, not once each", async ({ page }) => {
    const [a, b] = await page.evaluate(() => allConcepts().slice(0, 2));
    await recording(page, {});
    await page.evaluate(() => { Freshness.reset(); Freshness.checkedAt = -Infinity; State.freshness = "balanced"; });
    for (let i = 0; i < 8; i++) await page.evaluate((c) => selectConcept(c), i % 2 ? a : b);
    await page.waitForTimeout(200);
    const q = await page.evaluate(() =>
      window.__calls.filter((c) => /\/query$/.test(c.path)).length);
    /* One revision check for the eight. Not eight. */
    expect(q).toBe(1);
  });

  test("trusting asks nothing at all until you press Refresh", async ({ page }) => {
    const a = await page.evaluate(() => allConcepts()[0]);
    await recording(page, {});
    await page.evaluate(() => { Freshness.reset(); Freshness.checkedAt = -Infinity; State.freshness = "trusting"; });
    await page.evaluate((c) => selectConcept(c), a);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__calls.length)).toBe(0);
  });

  test("careful asks every time, which is the whole point of it", async ({ page }) => {
    const [a, b] = await page.evaluate(() => allConcepts().slice(0, 2));
    await recording(page, {});
    await page.evaluate(() => { Freshness.reset(); State.freshness = "careful"; });
    await page.evaluate((c) => selectConcept(c), a);
    await page.waitForTimeout(80);
    await page.evaluate((c) => selectConcept(c), b);
    await page.waitForTimeout(120);
    expect(await page.evaluate(() =>
      window.__calls.filter((c) => /\/query$/.test(c.path)).length)).toBe(2);
  });

  test("an unmoved revision counter ends the check — nothing is re-read", async ({ page }) => {
    await recording(page, {
      "/query": { results: { bindings: [{ rev: { type: "literal", value: "0" } }] } }
    });
    const n = await page.evaluate(async () => {
      State.revision = 0;
      Freshness.reset(); Freshness.checkedAt = -Infinity;
      return Freshness.check(true);
    });
    expect(n).toBe(0);
    /* One query. Whatever the vocabulary weighs. */
    expect(await page.evaluate(() =>
      window.__calls.filter((c) => /\/query$/.test(c.path)).length)).toBe(1);
  });

  test("a moved counter asks which terms changed, and re-reads only those",
    async ({ page }) => {
      const c = await page.evaluate(() => allConcepts()[0]);
      await page.evaluate((x) => {
        State.revision = 0;
        Freshness.reset();
        Freshness.seenAt = "2026-01-01T00:00:00.000Z";
      }, c);
      await page.evaluate((x) => {
        window.__answers = 0;
        window.__calls = [];
        State.mode = "live"; State.db = "testdb";
        State.conn = Object.assign({}, State.conn, { user: "tester", endpoint: "https://x.test" });
        window.__realRequest = Backend.request;
        Backend.request = async (o) => {
          const body = o.body && o.body.toString ? o.body.toString() : "";
          window.__calls.push({ path: o.path, body });
          const q = decodeURIComponent(body).replace(/\+/g, " ");
          let bindings = [];
          if (/tax:revision/.test(q)) bindings = [{ rev: { type: "literal", value: "7" } }];
          else if (/tax:subject/.test(q)) bindings = [{ s: { type: "uri", value: x } }];
          return { ok: true, json: async () => ({ results: { bindings } }), text: async () => "" };
        };
      }, c);
      const n = await page.evaluate(() => { Freshness.checkedAt = -Infinity; return Freshness.check(true); });
      expect(n).toBe(1);
      expect(await page.evaluate(() => State.revision)).toBe(7);

      const bodies = await page.evaluate(() =>
        window.__calls.map((c) => decodeURIComponent(c.body).replace(/\+/g, " ")));
      /* Revision, then the change feed, then the one term. Not the vocabulary. */
      expect(bodies.filter((b) => /tax:revision/.test(b))).toHaveLength(1);
      expect(bodies.filter((b) => /tax:subject/.test(b))).toHaveLength(1);
      expect(bodies.some((b) => b.indexOf(`<${c}>`) >= 0)).toBe(true);
    });

  test("the running call count is gone from the status line", async ({ page }) => {
    const txt = await page.textContent("#statusline");
    expect(txt).not.toMatch(/\bcalls\b/);
    expect(await page.$("#statusline [data-st='budget']")).toBeNull();
  });
});

test.describe("Publishing takes the graph it is about to create", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: SDG }); });
  test.afterEach(async ({ page }) => { await restore(page); });

  test("the release graph is granted before the transaction that writes it", async ({ page }) => {
    await page.evaluate(async () => {
      const some = allConcepts().slice(0, 3);
      const r = await Review.submit({ concepts: some, note: "batch" });
      await Review.approve(r, "fine");
    });
    await page.evaluate(() => openPublish());
    await A.waitModal(page, "Publish");
    await recording(page, {});
    await A.modalOk(page);
    await page.waitForTimeout(250);

    const calls = await page.evaluate(() => window.__calls);
    const grants = calls.filter((c) => /^\/admin\/permissions\/user\//.test(c.path));
    /* Read and write, on the release graph, before anything is written to it.
       Stardog reports the missing grant as an execution failure -- HTTP 500,
       SE0012, deep in a stack trace -- which is what a superuser hit on the
       first release ever published. */
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.some((g) => /:release:/.test(g.body))).toBe(true);
    const firstWrite = calls.findIndex((c) => /\/transaction\/begin$/.test(c.path));
    const lastGrant = calls.map((c) => c.path).lastIndexOf(grants[grants.length - 1].path);
    expect(lastGrant).toBeLessThan(firstWrite);
  });

  test("a named-graph refusal is explained, not shown as a stack trace", async ({ page }) => {
    const said = await page.evaluate(() => {
      const e = new Error('500 : {"message":"com.complexible.stardog.plan.eval.ExecutionException: ' +
        'User does not have permissions to update the named graph ' +
        'urn:taxonomy:scheme:temp-vocab:release:v2026-08-31","code":"SE0012"}');
      return { graph: graphDenied(e) };
    });
    expect(said.graph).toBe("urn:taxonomy:scheme:temp-vocab:release:v2026-08-31");
  });
});

test.describe("Roles say what they are", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: SDG }); });

  test("the name reads as a word, not an abbreviation for taxation", async ({ page }) => {
    const name = await A.roleName(page, "edit", SDG);
    expect(name).toBe("taxonomy_plant_conservation_edit");
    expect(await page.evaluate((n) => isTaxonomyRole(n), name)).toBe(true);
  });

  test("the name earlier versions created is still recognised, and never minted",
    async ({ page }) => {
      expect(await page.evaluate(() => isTaxonomyRole("tax_plant_conservation_edit"))).toBe(true);
      expect(await page.evaluate(() => isTaxonomyRole("taxonomy_mgr_app_plant_conservation_edit"))).toBe(true);
      expect(await page.evaluate(() => isTaxonomyRole("taxonomy_reports_weekly"))).toBe(false);
      expect(await page.evaluate(() => isTaxonomyRole("sd_auto_sysadmin"))).toBe(false);
      /* Minting always uses the settled prefix, which defaults to the plain one. */
      expect(await page.evaluate(() => rolePrefix())).toBe("taxonomy");
    });

  test("a name already taken by somebody else's role moves the whole family",
    async ({ page }) => {
      const prefix = await page.evaluate(async () => {
        State.mode = "live"; State.db = "testdb";
        const real = Backend.request;
        Backend.request = async (o) => {
          if (o.path === "/admin/roles") {
            return { json: async () => ({ roles: ["taxonomy_plant_conservation_edit"] }) };
          }
          if (/^\/admin\/permissions\/role\//.test(o.path)) {
            /* Somebody else's role that happens to have the name. What makes
               it theirs is what it *holds*: a graph with nothing to do with
               this vocabulary. (A role holding nothing at all is a different
               case -- far likelier one of ours that lost its grants, and
               there is nothing in it to hand anybody.) */
            return { json: async () => ({ permissions: [
              { action: "READ", resource_type: "named-graph", resource: ["testdb", "urn:someone:else"] }] }) };
          }
          return real(o);
        };
        const p = await settleRolePrefix("plant-conservation");
        Backend.request = real;
        return p;
      });
      expect(prefix).toBe("taxonomy_mgr_app");
      /* And it is what this session mints from here on, whether or not
         recording it in the config graph succeeded. */
      expect(await page.evaluate(() => rolePrefix())).toBe("taxonomy_mgr_app");
      expect(await page.evaluate(() => levelRoleName("edit", "plant-conservation")))
        .toBe("taxonomy_mgr_app_plant_conservation_edit");
    });

  test("a name already taken by a role we made earlier is not a clash", async ({ page }) => {
    const prefix = await page.evaluate(async () => {
      State.mode = "live"; State.db = "testdb";
      const gs = schemeGraphs(schemeById("plant-conservation"));
      const real = Backend.request;
      Backend.request = async (o) => {
        if (o.path === "/admin/roles") return { json: async () => ({ roles: ["taxonomy_plant_conservation_edit"] }) };
        if (/^\/admin\/permissions\/role\//.test(o.path)) {
          return { json: async () => ({ permissions: grantsForLevel("edit", gs).map(n => ({
            action: n[0], resource_type: n[1],
            resource: n[1] === "named-graph" ? ["testdb", n[2]] : ["testdb"]
          })) }) };
        }
        return real(o);
      };
      const p = await settleRolePrefix("plant-conservation");
      Backend.request = real;
      return p;
    });
    expect(prefix).toBe("taxonomy");
  });
});

test.describe("A role either can or it cannot", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: SDG }); });

  test("unticking a capability unticks everything that needs it", async ({ page }) => {
    const gone = await page.evaluate(() => {
      const gs = schemeGraphs(schemeById(State.schemeId));
      return levelsNeeding("follow", gs);
    });
    /* Reading the draft is part of editing it, approving it and changing its
       rules -- so taking it away takes those with it. Derived from the grant
       lists, never a hand-written table. */
    expect(gone).toContain("edit");
    expect(gone).toContain("approve");
    expect(gone).not.toContain("read");
  });

  test("it is exactly the inverse of what ticking a capability implies", async ({ page }) => {
    const ok = await page.evaluate(() => {
      const gs = schemeGraphs(schemeById(State.schemeId));
      return ACCESS_LEVELS.every(a => ACCESS_LEVELS.every(b => {
        if (a.key === b.key) return true;
        const aNeedsB = levelsNeeding(b.key, gs).includes(a.key);
        const bImpliedByA = levelsImpliedBy([a.key], null, gs).includes(b.key);
        return aNeedsB === bImpliedByA;
      }));
    });
    expect(ok).toBe(true);
  });

  test("no cell says 'part' any more", async ({ page }) => {
    /* It appeared in every cell of every role that touched the database at
       all, because every capability shares the three grants for reaching it.
       A word that appears everywhere says nothing. */
    const src = await page.evaluate(() => openAccessPanel.toString());
    expect(src).not.toMatch(/accpart|>part</);
  });
});
