const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * People.
 *
 * Roles were reachable from the app and people were not: the access panel
 * could create a role and grant it exactly what a job needs, then told you to
 * go and run `stardog-admin user grant-role` in a terminal. Half the work a
 * taxonomy lead does when someone joins left the app.
 *
 * Everything here runs against a stubbed transport. The same paths were run
 * against a live Stardog on 2026-08-28 — role created, five grants applied,
 * the person added to the role, and a second authenticated session that had
 * seen nothing at all could then read the vocabulary (STARDOG-API-CALLS §8.3).
 */

/** Stand in for the server, and record every request the app makes. */
const withServer = (page, fn, responses) => page.evaluate(async (x) => {
  const seen = [];
  const real = Backend.request;
  Backend.request = async (o) => {
    const path = o.path;
    seen.push({
      method: o.method || "GET", path,
      body: o.body && typeof o.body === "string" ? JSON.parse(o.body) : null
    });
    const hit = Object.keys(x.responses).find((k) => path === k || path.startsWith(k));
    const payload = hit ? x.responses[hit] : {};
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  State.mode = "live";
  State.db = "testdb";
  State.conn = Object.assign({}, State.conn, { user: "lead", endpoint: "https://example.test:5820" });
  let result = null, error = null;
  try { result = await eval(`(${x.fn})`)(); } catch (e) { error = String(e.message || e); }
  finally { Backend.request = real; }
  return { seen, result, error };
}, { fn: fn.toString(), responses: responses || {} });

test.describe("Reading the team", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("an account comes back as one object, not six requests", async ({ page }) => {
    const { seen, result } = await withServer(page, () => Team.get("ana"), {
      "/admin/users/ana": {
        enabled: true, superuser: false, roles: ["tax_x_contributor"],
        permissions: [
          { action: "READ", resource_type: "db", resource: ["testdb"], explicit: true },
          { action: "WRITE", resource_type: "named-graph", resource: ["testdb", "g"] }
        ]
      }
    });
    expect(seen).toHaveLength(1);
    expect(result.roles).toEqual(["tax_x_contributor"]);
    // only the direct grants — a role's grants belong to the role, not the person
    expect(result.explicit).toHaveLength(1);
    expect(result.explicit[0]).toMatchObject({ action: "READ", type: "db" });
  });

  test("setting roles sends the whole list, because the request replaces it", async ({ page }) => {
    const { seen } = await withServer(page, () => Team.addRole("ana", "b"), {
      "/admin/users/ana": { enabled: true, roles: ["a"], permissions: [] }
    });
    const put = seen.find((r) => r.method === "PUT");
    expect(put.path).toBe("/admin/users/ana/roles");
    expect(put.body.roles).toEqual(["a", "b"]);        // not just the new one
  });

  test("a role someone already has is not re-sent", async ({ page }) => {
    const { seen } = await withServer(page, () => Team.addRole("ana", "a"), {
      "/admin/users/ana": { enabled: true, roles: ["a"], permissions: [] }
    });
    expect(seen.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  test("taking a role away keeps the others", async ({ page }) => {
    const { seen } = await withServer(page, () => Team.removeRole("ana", "b"), {
      "/admin/users/ana": { enabled: true, roles: ["a", "b", "c"], permissions: [] }
    });
    expect(seen.find((r) => r.method === "PUT").body.roles).toEqual(["a", "c"]);
  });

  test("the team is read from roles, not from every account on the server", async ({ page }) => {
    const { seen } = await withServer(page, async () => {
      const roles = await fetchRolesWithGrants();
      for (const r of roles) await Team.usersOf(r.name);
      return roles.length;
    }, {
      "/admin/roles": { roles: ["r1", "r2"] },
      "/admin/permissions/role/": { permissions: [] },
      "/admin/roles/r1/users": { users: ["ana"] },
      "/admin/roles/r2/users": { users: ["ben"] }
    });
    // 1 role list + 2 role grants + 2 role memberships = 5, whatever the server's user count
    expect(seen).toHaveLength(5);
    expect(seen.some((r) => r.path === "/admin/users")).toBe(false);
  });
});

test.describe("What a capability needs", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  const grants = (page, keys) => page.evaluate((k) =>
    grantsForLevels(k, schemeGraphs(schemeById(State.schemeId))).map(needLabel), keys);

  test("every capability starts by being able to reach the database at all", async ({ page }) => {
    // measured live: every named-graph grant is worthless without these
    const db = await page.evaluate(() => State.db);
    for (const key of ["read", "follow", "edit", "import", "approve", "publish", "rules"]) {
      const g = await grants(page, [key]);
      expect(g, key).toContain(`READ db:${db}`);
      expect(g.some((x) => x.startsWith("READ metadata:")), key).toBe(true);
    }
  });

  /* A role that can publish and cannot read what it publishes is a role
     nobody can use. The panel used to offer exactly that as an alternative to
     reading, which is what made "Publish" look like a substitute for "See it"
     rather than something you hold as well. */
  test("every capability can read whatever it acts on", async ({ page }) => {
    expect(await grants(page, ["publish"])).toEqual(
      expect.arrayContaining([expect.stringMatching(/^READ .*:approved$/)]));
    expect(await grants(page, ["approve"])).toEqual(
      expect.arrayContaining([expect.stringMatching(/^READ .*:draft$/)]));
    expect(await grants(page, ["rules"])).toEqual(
      expect.arrayContaining([expect.stringMatching(/^READ .*:draft$/)]));
  });

  test("anything that changes the vocabulary can write the change log", async ({ page }) => {
    // invariant 5: the change and its audit event commit together, so a
    // capability that cannot write the log cannot do its job at all
    for (const key of ["edit", "import", "approve", "publish", "rules"]) {
      const g = await grants(page, [key]);
      expect(g, key).toContain("WRITE urn:taxonomy:app:audit");
    }
  });

  test("reading capabilities write nothing", async ({ page }) => {
    for (const key of ["read", "follow"]) {
      expect((await grants(page, [key])).some((x) => x.startsWith("WRITE")), key).toBe(false);
    }
  });

  test("seeing the release and seeing the draft are different grants", async ({ page }) => {
    const read = await grants(page, ["read"]);
    const follow = await grants(page, ["follow"]);
    expect(read.some((x) => x.includes(":published"))).toBe(true);
    expect(read.some((x) => x.includes(":draft"))).toBe(false);
    expect(follow.some((x) => x.includes(":draft"))).toBe(true);
  });

  test("importing carries the draft, the log and the provenance graph with it", async ({ page }) => {
    const g = await grants(page, ["import"]);
    expect(g.some((x) => x.includes(":incoming"))).toBe(true);
    expect(g.some((x) => x.includes(":provenance"))).toBe(true);
    expect(g).toContain("WRITE urn:taxonomy:app:loads");
  });

  test("a set of capabilities is the union of them, once each", async ({ page }) => {
    const all = await grants(page, ["read", "follow", "edit", "import", "approve", "publish", "rules"]);
    expect(new Set(all).size).toBe(all.length);
    for (const key of ["read", "follow", "edit"]) {
      for (const one of await grants(page, [key])) expect(all).toContain(one);
    }
  });

  test("no grant is ever a wildcard", async ({ page }) => {
    // there is no partial wildcard in Stardog, and `*` means every graph on
    // the server. A provisioning tool that reaches for one has given the farm away.
    const all = await grants(page, ["read", "follow", "edit", "import", "approve", "publish", "rules"]);
    for (const x of all) expect(x).not.toContain("*");
  });

  test("a role name says which vocabulary and which capability", async ({ page }) => {
    const { names, allOurs } = await page.evaluate(() => {
      const names = ACCESS_LEVELS.map((l) => levelRoleName(l.key));
      return { names, allOurs: names.every(isTaxonomyRole) };
    });
    /* Asked of the app, not spelled out: the prefix is settled per database
       and an older one still carries `tax_`. */
    expect(names).toContain(await A.roleName(page, "edit", "plant-conservation"));
    expect(allOurs).toBe(true);
    expect(await page.evaluate(() => isTaxonomyRole("cloud"))).toBe(false);
    expect(await page.evaluate(() => isTaxonomyRole("sd_auto_sysadmin"))).toBe(false);
  });
});

test.describe("Setting someone up", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("it creates the role, grants what the job needs, and adds the person", async ({ page }) => {
    const { seen } = await withServer(page, () => setAccess("ana", ["read", "follow"]), {
      "/admin/users/ana": { enabled: true, roles: [], permissions: [] }
    });
    const created = seen.filter((r) => r.path === "/admin/roles" && r.method === "POST");
    const want = [await A.roleName(page, "read", "plant-conservation"), await A.roleName(page, "follow", "plant-conservation")];
    expect(created.map((r) => r.body.rolename)).toEqual(want);

    const grants = seen.filter((r) => r.path.startsWith("/admin/permissions/role/"));
    expect(grants.length).toBeGreaterThanOrEqual(5);
    expect(grants.every((g) => g.method === "PUT")).toBe(true);
    // a named-graph grant is a [database, graph] pair, not a joined string
    const ng = grants.filter((g) => g.body.resource_type === "named-graph");
    expect(ng.length).toBeGreaterThan(0);
    ng.forEach((g) => {
      expect(Array.isArray(g.body.resource)).toBe(true);
      expect(g.body.resource).toHaveLength(2);
      expect(g.body.resource[0]).toBe("testdb");
    });

    const assigned = seen.find((r) => r.path === "/admin/users/ana/roles");
    expect(assigned.body.roles).toEqual(want);
  });

  test("a role that is already there is not an error", async ({ page }) => {
    const { error } = await page.evaluate(async () => {
      const real = Backend.request;
      Backend.request = async (o) => {
        if (o.path === "/admin/roles" && o.method === "POST") { const e = new Error("role exists"); e.status = 409; throw e; }
        return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      };
      State.mode = "live"; State.db = "testdb";
      let error = null;
      try { await ensureLevelRole("read", schemeGraphs(schemeById(State.schemeId))); }
      catch (e) { error = String(e.message || e); }
      finally { Backend.request = real; }
      return { error };
    });
    expect(error).toBeNull();
  });

  test("a grant that is refused is reported, not swallowed", async ({ page }) => {
    const failed = await page.evaluate(async () => {
      const real = Backend.request;
      Backend.request = async (o) => {
        if (o.path.startsWith("/admin/permissions/role/")) {
          const e = new Error("Permission [[grant], [named-graph]] denied"); e.status = 403; throw e;
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      };
      State.mode = "live"; State.db = "testdb";
      try { return (await ensureLevelRole("read", schemeGraphs(schemeById(State.schemeId)))).failed; }
      finally { Backend.request = real; }
    });
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.join(" ")).toMatch(/denied/);
  });
});

test.describe("What the administrator is allowed to do", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("each ability is reported on its own, so a partial admin gets a list", async ({ page }) => {
    const can = await page.evaluate(async () => {
      const real = Backend.request;
      Backend.request = async (o) => {
        if (o.path === "/admin/users") { const e = new Error("denied"); e.status = 403; throw e; }
        if (o.path === "/admin/roles") return { ok: true, json: async () => ({ roles: [] }), text: async () => "{}" };
        return { ok: true, json: async () => ({}), text: async () => "{}" };
      };
      State.mode = "live"; State.db = "testdb";
      Perms.loaded = true;
      Perms.entries = [{ action: "CREATE", type: "role", resources: ["*"] }];
      try { return await Team.probe(); } finally { Backend.request = real; Perms.reset(); }
    });
    expect(can.listUsers).toBe(false);
    expect(can.listRoles).toBe(true);
    expect(can.createRole).toBe(true);
    expect(can.createUser).toBe(false);
  });

  test("an ability that could not be read is unknown, not refused", async ({ page }) => {
    const can = await page.evaluate(async () => {
      const real = Backend.request;
      Backend.request = async () => ({ ok: true, json: async () => ({ roles: [], users: [] }), text: async () => "{}" });
      State.mode = "live"; State.db = "testdb";
      Perms.reset();                       // the endpoint never answered
      try { return await Team.probe(); } finally { Backend.request = real; }
    });
    expect(can.createUser).toBeNull();
    expect(can.assignRole).toBeNull();
    expect(can.listUsers).toBe(true);      // this one was actually tried
  });
});

test.describe("A reader on a vocabulary nobody has published", () => {
  test("the app can tell an empty release from a missing permission", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    // measured live: a correctly granted reader saw zero graphs, because the
    // published graph held zero statements. The permission was not the problem.
    const empty = await page.evaluate(async () => {
      const real = Caps.countGraph;
      Caps.countGraph = async () => 0;
      try { return await publishedIsEmpty(schemeGraphs(schemeById(State.schemeId))); }
      finally { Caps.countGraph = real; }
    });
    expect(empty).toBe(true);
  });

  test("and says so rather than guessing when it cannot count", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const unknown = await page.evaluate(async () => {
      const real = Caps.countGraph;
      Caps.countGraph = async () => { throw new Error("nope"); };
      try { return await publishedIsEmpty(schemeGraphs(schemeById(State.schemeId))); }
      finally { Caps.countGraph = real; }
    });
    expect(unknown).toBeNull();
  });
});
