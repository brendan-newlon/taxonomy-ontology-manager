const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * Found by opening the app against a real Stardog database holding a real
 * vocabulary — 17,071 terms, a review history, a published release.
 *
 * Four screens reported an empty server. Reviews said nothing was waiting
 * while 22 triples of review requests sat in the database; Discussions said
 * nobody had ever asked anything; the change log said "0 of 0 events" over a
 * change log with 18 in it; and the revision counter read 0.
 *
 * One cause: those screens read the local store, on the assumption — written
 * into a comment above one of them — that the app's own graphs arrive with
 * everything else on connect. Opening a vocabulary loads the vocabulary. The
 * app graphs were only ever loaded by a code path nothing on the opening
 * route calls.
 *
 * And one thing that is *not* fixed by loading them: the change log is the
 * one app graph that grows without bound, so it reads its own data.
 *
 * Also here, from the same session: ten permission grants re-sent on every
 * reconnect, each answered with a 400 because the account already held it.
 */

const SDG = "plant-conservation";

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
    return { ok: true, text: async () => "tx-1",
             json: async () => (hit ? ans[hit] : { results: { bindings: [] } }) };
  };
}, answers || {});

const restore = (page) => page.evaluate(() => {
  if (window.__realRequest) Backend.request = window.__realRequest;
  State.mode = "mock";
});

/** The SPARQL a recorded call carried, as the server would have read it. */
const sparqlOf = (body) => decodeURIComponent(String(body || "").replace(/\+/g, "%20"))
  .replace(/^(query|update)=/, "");

/** Every graph named in a hydrate query, in the order they were asked for. */
const hydrated = (page) => page.evaluate(() =>
  window.__calls
    .filter((c) => /\/query$/.test(c.path))
    .map((c) => (decodeURIComponent(String(c.body || "").replace(/\+/g, "%20"))
      .match(/GRAPH <([^>]+)>/) || [])[1])
    .filter(Boolean));

test.describe("The app's own records are actually loaded", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: SDG }); });
  test.afterEach(async ({ page }) => { await restore(page); });

  test("opening a vocabulary reads the records the screens show", async ({ page }) => {
    await recording(page, {});
    await page.evaluate(() => Backend.hydrateAppRecords(true));
    const got = await hydrated(page);
    /* Settings, the revision counter, the register of loaded files, review
       requests, discussion threads — one query each, and each of them is
       something a screen in this app draws directly from the store. */
    expect(got).toEqual(expect.arrayContaining([
      "urn:taxonomy:app:config", "urn:taxonomy:app:sessions", "urn:taxonomy:app:loads",
      "urn:taxonomy:app:reviews", "urn:taxonomy:app:comments"]));
  });

  test("the change log is deliberately not among them", async ({ page }) => {
    await recording(page, {});
    await page.evaluate(() => Backend.hydrateAppRecords(true));
    /* It is the one that grows with every change ever made, forever. Reading
       all of it to draw a screen with a date filter on it is the wrong trade
       at any size, and at the size this app is for it is the wrong trade
       twice. */
    expect(await hydrated(page)).not.toContain("urn:taxonomy:app:audit");
  });

  test("a graph already held is not read again", async ({ page }) => {
    await recording(page, {});
    await page.evaluate(() => { State.loadedGraphs.add(G.reviews); });
    await page.evaluate(() => Backend.hydrateAppRecords());
    expect(await hydrated(page)).not.toContain("urn:taxonomy:app:reviews");
  });

  test("they are read before the freshness baseline is taken", async ({ page }) => {
    /* The revision counter is read out of the session graph at the end of a
       hydrate, and the freshness check measures against it — so a counter
       left at 0 makes the first check of every session believe the server
       has moved on and re-read a vocabulary that had not changed. */
    const order = await page.evaluate(async () => {
      const seen = [];
      const realHydrate = Backend.hydrateAppRecords;
      const realReset = Freshness.reset;
      Backend.hydrateAppRecords = async () => { seen.push("records"); };
      Freshness.reset = () => { seen.push("baseline"); realReset.call(Freshness); };
      try { await Data.openScheme(true); } finally {
        Backend.hydrateAppRecords = realHydrate; Freshness.reset = realReset;
      }
      return seen;
    });
    expect(order).toContain("records");
    expect(order.indexOf("records")).toBeLessThan(order.indexOf("baseline"));
  });
});

test.describe("What the store holds, and what says so", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: SDG }); });
  test.afterEach(async ({ page }) => { await restore(page); });

  test("a fresh store forgets what the old one had read", async ({ page }) => {
    /* `loadedGraphs` is the answer to "have I already read this graph?", and
       the app's own graphs are named the same in every database — so a store
       replaced without it says yes about a store holding nothing, and opening
       a second database in one session left every one of those screens empty
       again. */
    const after = await page.evaluate(() => {
      State.loadedGraphs.add("urn:taxonomy:app:reviews");
      State.loadedGraphs.add("urn:taxonomy:app:config");
      resetStore();
      return { loaded: [...State.loadedGraphs], quads: State.store.size ? State.store.size() : 0,
               skeleton: State.load.skeletonOf };
    });
    expect(after.loaded).toEqual([]);
    expect(after.skeleton).toBeNull();
  });

  test("after a reset the records are read again, not assumed", async ({ page }) => {
    /* The two halves composed: this is what opening a second database in one
       session does, and what it used to skip. `openLiveDatabase` calls
       `resetStore` for exactly this reason. */
    await recording(page, {});
    await page.evaluate(() => {
      APP_RECORD_GRAPHS().forEach(g => State.loadedGraphs.add(g));
      resetStore();
    });
    await page.evaluate(() => Backend.hydrateAppRecords());
    const got = await hydrated(page);
    expect(got).toEqual(expect.arrayContaining([
      "urn:taxonomy:app:config", "urn:taxonomy:app:sessions", "urn:taxonomy:app:loads",
      "urn:taxonomy:app:reviews", "urn:taxonomy:app:comments"]));
  });

  test("a whole-session reload reads the same records, and still not the change log",
    async ({ page }) => {
      /* `Freshness._reload` calls the no-argument `Backend.hydrate()` whenever
         the counter moves and the change log does not explain it — the
         ordinary outcome when another tool writes. That path used to pull the
         entire audit graph in, and never pulled reviews at all. */
      await recording(page, {});
      await page.evaluate(() => Backend.hydrate());
      const got = await hydrated(page);
      expect(got).toContain("urn:taxonomy:app:reviews");
      expect(got).not.toContain("urn:taxonomy:app:audit");
    });

  test("reading one person's access writes nothing", async ({ page }) => {
    /* The dialog opens under a wait modal that says so. Settling what this
       vocabulary's roles are called is a read; recording the answer is a
       write, and it belongs to the first thing that creates a role. */
    const sent = await page.evaluate(async () => {
      State.mode = "live"; State.db = "testdb";
      State.conn = Object.assign({}, State.conn, { user: "lead", endpoint: "https://x.test" });
      const out = [];
      const real = Backend.request;
      Backend.request = async (r) => {
        out.push({ method: r.method || "GET", path: r.path });
        if (r.path === "/admin/roles") return { ok: true, json: async () => ({ roles: [] }) };
        if (r.path === "/admin/users/nadia")
          return { ok: true, json: async () => ({ enabled: true, roles: [], permissions: [] }) };
        return { ok: true, json: async () => ({}), text: async () => "{}" };
      };
      try { await openPersonPanel("nadia"); } finally { Backend.request = real; }
      return out;
    });
    expect(sent.filter((c) => /update|transaction/.test(c.path))).toHaveLength(0);
    expect(sent.filter((c) => c.method === "POST" || c.method === "PUT")).toHaveLength(0);
  });

  test("and the name it settled on is still recorded when a role is made", async ({ page }) => {
    const out = await page.evaluate(async () => {
      State.mode = "live"; State.db = "testdb";
      State.conn = Object.assign({}, State.conn, { user: "lead", endpoint: "https://x.test" });
      const realReq = Backend.request, realCommit = commit;
      const commits = [];
      commit = async (m) => { commits.push(m.label); return true; };
      Backend.request = async (r) => {
        if (r.path === "/admin/roles") return { ok: true, json: async () => ({ roles: [] }) };
        return { ok: true, json: async () => ({}), text: async () => "{}" };
      };
      await settleRolePrefix("plant-conservation", false);        // the read-only screen
      const afterRead = commits.length;
      await settleRolePrefix("plant-conservation");               // something that creates a role
      const afterWrite = commits.length;
      Backend.request = realReq; commit = realCommit;
      return { afterRead, afterWrite, prefix: rolePrefix() };
    });
    expect(out.afterRead).toBe(0);
    expect(out.afterWrite).toBe(1);
    expect(out.prefix).toBe("taxonomy");
  });
});

test.describe("The change log reads the change log", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: SDG }); });
  test.afterEach(async ({ page }) => { await restore(page); });

  test("it asks the server, newest first and bounded", async ({ page }) => {
    await recording(page, {});
    await page.evaluate(() => auditEvents());
    const sent = sparqlOf(await page.evaluate(() =>
      (window.__calls.find((c) => /\/query$/.test(c.path)) || {}).body || ""));
    expect(sent).toContain("urn:taxonomy:app:audit");
    expect(sent).toMatch(/ORDER BY DESC\(\?at\)/);
    expect(sent).toMatch(/LIMIT \d+/);
  });

  test("what the screen offers to show you is what it sent", async ({ page }) => {
    /* There was a "Show the SPARQL" button next to a query the app never
       ran — a hand-written one, kept beside a screen that was reading the
       local store. Two things to get out of step, and they were. */
    await recording(page, {});
    await page.evaluate(() => auditEvents());
    const sent = sparqlOf(await page.evaluate(() =>
      (window.__calls.find((c) => /\/query$/.test(c.path)) || {}).body || ""));
    const shown = await page.evaluate(() => LAST_AUDIT_QUERY);
    expect(sent.trim()).toBe(shown.trim());
  });

  test("with no server it answers from this tab, and names the same graph", async ({ page }) => {
    const out = await page.evaluate(async () => {
      const events = await auditEvents();
      return { n: events.length, query: LAST_AUDIT_QUERY };
    });
    expect(out.query).toContain("urn:taxonomy:app:audit");
    expect(out.n).toBeGreaterThanOrEqual(0);
  });

  test("the screen opens on real events rather than an empty table", async ({ page }) => {
    await page.evaluate(async () => {
      await commit(mutation({
        label: "Note", graph: currentGraph(),
        ins: [{ s: iri(allConcepts()[0]), p: P("skos:scopeNote"), o: lit("for the log", "en") }],
        audit: auditEvent({ action: "AddNote", subject: allConcepts()[0] })
      }));
    });
    await page.evaluate(() => openAuditLog());
    await A.waitModal(page, "Change log");
    expect(await page.$$eval("#auditRows tr", (r) => r.length)).toBeGreaterThan(0);
    expect(await page.textContent("#auditCount")).not.toMatch(/^0 of 0/);
    await A.modalCancel(page);
  });
});

test.describe("A grant already held is not asked for again", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: SDG }); });
  test.afterEach(async ({ page }) => { await restore(page); });

  /** Effective permissions covering every named graph in `graphs`. */
  const holding = (page, graphs) => page.evaluate((gs) => {
    Perms.reset(); Perms.loaded = true; Perms.readable = true;
    Perms.entries = gs.reduce((acc, g) => acc.concat([
      { action: "READ", type: "named-graph", resources: ["testdb", g] },
      { action: "WRITE", type: "named-graph", resources: ["testdb", g] }]), []);
  }, graphs);

  const appGraphs = (page) => page.evaluate(() => appBookkeepingGraphs());

  /** Calls that ask for a permission, as opposed to writing a marker triple. */
  const grantCalls = (calls) => calls.filter((c) => c.path.startsWith("/admin/permissions/user/"));
  /** Calls that write a graph's placeholder marker triple. */
  const seedCalls = (calls) => calls.filter((c) => /\/update$/.test(c.path));

  test("holding all of them sends nothing at all", async ({ page }) => {
    await recording(page, {});
    await holding(page, await appGraphs(page));
    await page.evaluate(() => { window.__calls = []; return ensureAppGraphGrants(); });
    /* Stardog answers an already-held grant with a 400. Harmless, and it was
       already read as success — but it was ten failed round trips on every
       reconnect to a database this account had used before. */
    expect(await page.evaluate(() => window.__calls.length)).toBe(0);
  });

  test("holding all but one asks for that one, and seeds it", async ({ page }) => {
    const all = await appGraphs(page);
    await recording(page, {});
    await holding(page, all.filter((g) => !/comments$/.test(g)));
    await page.evaluate(() => { window.__calls = []; return ensureAppGraphGrants(); });
    const calls = await page.evaluate(() => window.__calls);
    const granted = grantCalls(calls);
    expect(granted.length).toBe(2);                      // read and write, one graph
    granted.forEach((c) => expect(c.body).toContain("urn:taxonomy:app:comments"));
    /* A grant just newly acquired is seeded with a marker triple, so the
       graph exists and explains itself the moment this account can write it
       — not only once something else happens to write there first. */
    const seeded = seedCalls(calls);
    expect(seeded.length).toBe(1);
    expect(sparqlOf(seeded[0].body)).toContain("urn:taxonomy:app:comments");
    expect(sparqlOf(seeded[0].body)).toContain("tax:AppGraph");
  });

  test("an account that cannot see its own permissions still asks for everything",
    async ({ page }) => {
      /* `/admin/permissions/effective/user/{me}` is an administrator's
         endpoint. For most of the people this app is for it answers 403, and
         "cannot tell from here" must not be read as "already held". */
      await recording(page, {});
      await page.evaluate(() => { Perms.reset(); Perms.readable = false; });
      await page.evaluate(() => { window.__calls = []; return ensureAppGraphGrants(); });
      const calls = await page.evaluate(() => window.__calls);
      expect(grantCalls(calls).length).toBe(12);           // read and write, six graphs
      /* Every graph but config, which `writeAppMarker` already covers more
         fully than a placeholder triple would. */
      expect(seedCalls(calls).length).toBe(5);
    });

  test("a grant that is refused is not seeded", async ({ page }) => {
    const all = await appGraphs(page);
    await holding(page, all.filter((g) => !/comments$/.test(g)));
    const calls = await page.evaluate(async () => {
      State.mode = "live"; State.db = "testdb";
      State.conn = Object.assign({}, State.conn, { user: "tester", endpoint: "https://x.test", authMode: "basic" });
      const out = [];
      Backend.request = async (o) => {
        out.push({ method: o.method || "GET", path: o.path });
        if (o.path.startsWith("/admin/permissions/user/")) { const e = new Error("refused"); e.status = 403; throw e; }
        return { ok: true, text: async () => "tx-1", json: async () => ({ results: { bindings: [] } }) };
      };
      await ensureAppGraphGrants();
      return out;
    });
    expect(grantCalls(calls).length).toBe(2);             // still asked for -- best effort
    expect(seedCalls(calls).length).toBe(0);               // never held it, so never wrote to it
  });
});

test.describe("A first write repairs its own missing grant", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: SDG }); });
  test.afterEach(async ({ page }) => { await restore(page); });

  /**
   * The scenario reported live: an administrator, the first person ever to
   * comment on a database, refused with "does not have permissions to update
   * the named graph urn:taxonomy:app:comments" even though `commit()` had
   * already logged the write's SPARQL correctly. `ensureAppGraphGrants` only
   * ever runs at connect, so an account that reaches a bookkeeping graph for
   * the first time *between* connects — the ordinary case for a graph this
   * new — hit exactly the gap this fixes.
   */
  test("a permission denial on comments is granted, seeded and retried, silently",
    async ({ page }) => {
      const out = await page.evaluate(async () => {
        State.mode = "live"; State.db = "testdb";
        State.conn = Object.assign({}, State.conn, { user: "admin", authMode: "basic" });
        Perms.reset(); Perms.loaded = true; Perms.readable = true;
        const calls = [];
        let firstUpdateSeen = false;
        Backend.request = async (o) => {
          calls.push({ method: o.method || "GET", path: o.path });
          if (/\/update$/.test(o.path) && !firstUpdateSeen) {
            firstUpdateSeen = true;
            const e = new Error('500 : {"message":"com.complexible.stardog.plan.eval.ExecutionException: ' +
              'User does not have permissions to update the named graph ' +
              'urn:taxonomy:app:comments","code":"SE0012"}');
            e.status = 500;
            throw e;
          }
          return { ok: true, text: async () => "tx-1", json: async () => ({ results: { bindings: [] } }) };
        };
        const ok = await commit(mutation({
          label: "Start a discussion", graph: G.comments, del: [], ins: [
            { s: iri("urn:taxonomy:app:comments"), p: P("rdf:type"), o: P("tax:Discussion") }
          ]
        }));
        return {
          ok,
          grantPaths: calls.filter((c) => c.path.startsWith("/admin/permissions/user/")).map((c) => c.path),
          updateCount: calls.filter((c) => /\/update$/.test(c.path)).length
        };
      });
      expect(out.ok).toBe(true);
      /* Granted on its own account, not routed through a role or an admin
         dialog. */
      expect(out.grantPaths.length).toBe(2);
      /* One refused write, one marker-triple seed, one successful retry. */
      expect(out.updateCount).toBe(3);
    });

  test("does nothing for a vocabulary graph — access there stays a role decision",
    async ({ page }) => {
      const out = await page.evaluate(async () => {
        State.mode = "live"; State.db = "testdb";
        State.conn = Object.assign({}, State.conn, { user: "reader", authMode: "basic" });
        Perms.reset(); Perms.loaded = true; Perms.readable = true;
        const calls = [];
        const draft = schemeGraphs(schemeById("plant-conservation")).draft;
        Backend.request = async (o) => {
          calls.push({ method: o.method || "GET", path: o.path });
          const e = new Error(`User does not have permissions to update the named graph ${draft}`);
          e.status = 500;
          throw e;
        };
        const ok = await commit(mutation({
          label: "Edit", graph: draft,
          ins: [{ s: iri(allConcepts()[0]), p: P("skos:scopeNote"), o: lit("x", "en") }]
        }));
        return { ok, grantAttempted: calls.some((c) => c.path.startsWith("/admin/permissions/user/")) };
      });
      expect(out.ok).toBe(false);
      expect(out.grantAttempted).toBe(false);
    });
});

test.describe("A vocabulary keeps the role names it already has", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: SDG }); });

  test("an earlier family is kept rather than a second one started", async ({ page }) => {
    /* The live server had `tax_temp_vocab_edit` and `tax_temp_vocab_approve`
       on it from earlier sessions. Minting `taxonomy_temp_vocab_read` beside
       them would split one vocabulary's eight capabilities across two
       namings, and leave everybody already holding the old roles outside the
       new ones. */
    const prefix = await page.evaluate(async () => {
      State.mode = "live"; State.db = "testdb";
      const gs = schemeGraphs(schemeById("plant-conservation"));
      const real = Backend.request;
      Backend.request = async (o) => {
        if (o.path === "/admin/roles") return { json: async () => ({ roles: ["tax_plant_conservation_edit"] }) };
        if (/^\/admin\/permissions\/role\//.test(o.path)) {
          return { json: async () => ({ permissions: grantsForLevel("edit", gs).map((n) => ({
            action: n[0], resource_type: n[1],
            resource: n[1] === "named-graph" ? ["testdb", n[2]] : ["testdb"] })) }) };
        }
        return real(o);
      };
      const p = await settleRolePrefix("plant-conservation");
      Backend.request = real;
      return p;
    });
    expect(prefix).toBe("tax");
    expect(await page.evaluate(() => levelRoleName("read", "plant-conservation"))).toBe("tax_plant_conservation_read");
  });

  test("one of ours that lost its grants is still one of ours", async ({ page }) => {
    /* Repairing exactly this is what "Reset to the defaults" is for. Judged
       by what it is missing, an emptied role is indistinguishable from a
       stranger's — and calling it a stranger's renames the whole family
       instead of repairing the one role. */
    const prefix = await page.evaluate(async () => {
      State.mode = "live"; State.db = "testdb";
      const real = Backend.request;
      Backend.request = async (o) => {
        if (o.path === "/admin/roles") return { json: async () => ({ roles: ["taxonomy_plant_conservation_edit"] }) };
        if (/^\/admin\/permissions\/role\//.test(o.path)) return { json: async () => ({ permissions: [] }) };
        return real(o);
      };
      const p = await settleRolePrefix("plant-conservation");
      Backend.request = real;
      return p;
    });
    expect(prefix).toBe("taxonomy");
  });

  test("a role holding only part of what it should, on this vocabulary, is ours",
    async ({ page }) => {
      const prefix = await page.evaluate(async () => {
        State.mode = "live"; State.db = "testdb";
        const gs = schemeGraphs(schemeById("plant-conservation"));
        const real = Backend.request;
        Backend.request = async (o) => {
          if (o.path === "/admin/roles") return { json: async () => ({ roles: ["taxonomy_plant_conservation_edit"] }) };
          if (/^\/admin\/permissions\/role\//.test(o.path)) {
            /* Two of the dozen grants edit asks for, one of them naming this
               vocabulary's own draft graph. Nobody else holds that. */
            return { json: async () => ({ permissions: [
              { action: "READ", resource_type: "db", resource: ["testdb"] },
              { action: "WRITE", resource_type: "named-graph", resource: ["testdb", gs.draft] }] }) };
          }
          return real(o);
        };
        const p = await settleRolePrefix("plant-conservation");
        Backend.request = real;
        return p;
      });
      expect(prefix).toBe("taxonomy");
    });

  test("a stranger's role by that name is not an earlier family", async ({ page }) => {
    const prefix = await page.evaluate(async () => {
      State.mode = "live"; State.db = "testdb";
      const real = Backend.request;
      Backend.request = async (o) => {
        if (o.path === "/admin/roles") return { json: async () => ({ roles: ["tax_plant_conservation_edit"] }) };
        /* Theirs because of what it holds, not because of what it lacks. */
        if (/^\/admin\/permissions\/role\//.test(o.path)) {
          return { json: async () => ({ permissions: [
            { action: "READ", resource_type: "named-graph", resource: ["testdb", "urn:someone:else"] }] }) };
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
