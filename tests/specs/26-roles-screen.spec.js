const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * The Roles screen, and the checklists that grant through it.
 *
 * Three things went wrong here in the same way: the screen said something the
 * server did not mean.
 *
 * A part-granted level drew as an unticked box, so pressing Apply after only
 * *reading* the screen revoked every partial grant on it. Ticking "Edit the
 * draft" left "See the draft" unticked, which is the opposite of what editing
 * had just granted. And the team list was built from this app's roles alone,
 * so the administrator reading it — who holds their access as a superuser —
 * was not on it.
 */

/** Run something in the page as a live session, with the server stubbed out. */
const asLive = (page, fn, arg) => page.evaluate(async (x) => {
  State.mode = "live";
  State.db = "testdb";
  State.conn = Object.assign({}, State.conn, { user: "lead", endpoint: "https://example.test:5820" });
  return eval(`(${x.fn})`)(x.arg);
}, { fn: fn.toString(), arg: arg === undefined ? null : arg });

test.describe("A capability includes the ones it already covers", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  test("editing the draft already means seeing the draft", async ({ page }) => {
    expect(await asLive(page, () => levelsImpliedBy(["edit"]))).toContain("follow");
  });

  test("and seeing the release, because an editor reads it", async ({ page }) => {
    expect(await asLive(page, () => levelsImpliedBy(["edit"]))).toContain("read");
  });

  test("importing carries seeing the draft with it", async ({ page }) => {
    expect(await asLive(page, () => levelsImpliedBy(["import"]))).toContain("follow");
  });

  test("seeing the release does not smuggle in seeing the draft", async ({ page }) => {
    /* Different graphs, and the whole reason "See the draft" exists as its own
       capability: a reader of an unpublished vocabulary sees nothing. */
    expect(await asLive(page, () => levelsImpliedBy(["read"]))).not.toContain("follow");
    expect(await asLive(page, () => levelsImpliedBy(["follow"]))).not.toContain("read");
  });

  test("nothing implies itself", async ({ page }) => {
    /* Read from the app, not written out here: a capability added later must
       be covered by this invariant, and a hardcoded list would quietly skip
       it — which is exactly what happened when `discuss` was added. */
    const keys = await page.evaluate(() => ACCESS_LEVELS.map((l) => l.key));
    expect(keys.length).toBeGreaterThan(1);
    for (const k of keys) {
      expect(await asLive(page, (x) => levelsImpliedBy([x]), k), k).not.toContain(k);
    }
  });

  test("an implied box is ticked and locked, and still counts as granted", async ({ page }) => {
    const out = await asLive(page, () => {
      document.body.insertAdjacentHTML("beforeend",
        `<div id="lvprobe">${levelChecklist(["read"])}</div>`);
      const scope = document.getElementById("lvprobe");
      const sync = wireLevelChecklist(scope);
      const box = (k) => scope.querySelector(`[data-lvl="${k}"]`);
      box("edit").checked = true; sync();
      const r = {
        followTicked: box("follow").checked,
        followLocked: box("follow").disabled,
        editStillOn: box("edit").checked && !box("edit").disabled,
        counted: [...scope.querySelectorAll("[data-lvl]")].filter(b => b.checked).map(b => b.dataset.lvl)
      };
      // and unticking the one that covers it hands control back
      box("edit").checked = false; sync();
      r.followAfter = { ticked: box("follow").checked, locked: box("follow").disabled };
      scope.remove();
      return r;
    });
    expect(out.followTicked).toBe(true);
    expect(out.followLocked).toBe(true);
    expect(out.editStillOn).toBe(true);
    expect(out.counted).toEqual(expect.arrayContaining(["read", "follow", "edit"]));
    expect(out.followAfter).toEqual({ ticked: false, locked: false });
  });
});

test.describe("Reading the Roles screen changes nothing", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  /** Drive applyAccessChanges over one role in a known state, and see what it sends. */
  const apply = (page, held, want) => page.evaluate(async (x) => {
    State.mode = "live"; State.db = "testdb";
    const gs = schemeGraphs(schemeById(State.schemeId));
    /* A role holding exactly what one capability needs, plus part of another. */
    const perms = grantsForLevels(x.held, gs).map(n => ({
      action: n[0], resource_type: n[1],
      resource: n[1] === "named-graph" ? ["testdb", n[2]] : ["testdb"]
    }));
    ACCESS_STATE = { gs, roles: [{ name: "r", perms }], changes: [] };
    const was = levelsHeldBy(perms, gs);
    const sent = [];
    const real = Backend.request;
    Backend.request = async (o) => {
      sent.push({ method: o.method, path: o.path, body: o.body ? JSON.parse(o.body) : null });
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    };
    try {
      await applyAccessChanges(ACCESS_LEVELS.map(lv => ({
        role: "r", key: lv.key, was: was[lv.key],
        on: x.want ? x.want.indexOf(lv.key) >= 0 : was[lv.key] === "full"
      })));
    } finally { Backend.request = real; }
    return { was, sent };
  }, { held, want });

  test("opening it and pressing Apply sends nothing", async ({ page }) => {
    const { sent } = await apply(page, ["edit"], null);
    expect(sent).toHaveLength(0);
  });

  test("a part-granted level is not revoked just for being left alone", async ({ page }) => {
    /* "edit" grants some of what "approve" needs, so approve reads as part —
       and drew as an unticked box. Leaving it alone must send no delete. */
    const { was, sent } = await apply(page, ["edit"], null);
    expect(Object.values(was)).toContain("partial");         // the state that used to bite
    expect(sent.filter((r) => /\/delete$/.test(r.path))).toHaveLength(0);
  });

  test("unticking something that was fully granted does revoke it", async ({ page }) => {
    const { sent } = await apply(page, ["edit"], []);
    expect(sent.filter((r) => /\/delete$/.test(r.path)).length).toBeGreaterThan(0);
  });

  test("ticking a part-granted level grants the rest of it, and only the rest", async ({ page }) => {
    const { sent } = await apply(page, ["edit"], ["edit", "approve"]);
    const puts = sent.filter((r) => r.method === "PUT");
    expect(puts.length).toBeGreaterThan(0);
    expect(sent.filter((r) => /\/delete$/.test(r.path))).toHaveLength(0);
    // nothing it already held is re-sent
    const approved = `urn:taxonomy:scheme:plant-conservation:approved`;
    expect(puts.some((p) => (p.body.resource || [])[1] === approved)).toBe(true);
  });

});

test.describe("Putting the roles back", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  /** Stub the role list, and record what the reset sends. */
  const reset = (page, rolePerms) => page.evaluate(async (x) => {
    State.mode = "live"; State.db = "testdb";
    const sent = [];
    const real = Backend.request;
    Backend.request = async (o) => {
      sent.push({ method: o.method, path: o.path, body: o.body ? JSON.parse(o.body) : null });
      if (o.path === "/admin/roles") return { ok: true, json: async () => ({ roles: Object.keys(x.rolePerms) }), text: async () => "{}" };
      const m = o.path.match(/^\/admin\/permissions\/role\/([^/]+)$/);
      if (m && (o.method || "GET") === "GET")
        return { ok: true, json: async () => ({ permissions: x.rolePerms[decodeURIComponent(m[1])] || [] }), text: async () => "{}" };
      return { ok: true, json: async () => ({}), text: async () => "{}" };
    };
    try { return { out: await resetTaxonomyRoles(), sent }; } finally { Backend.request = real; }
  }, { rolePerms });

  const NG = (action, graph) => ({ action, resource_type: "named-graph", resource: ["testdb", graph] });

  test("a role that is already right is not touched", async ({ page }) => {
    const perms = await page.evaluate(() => {
      State.db = "testdb";
      return grantsForLevel("read", schemeGraphs(schemeById(State.schemeId))).map(n => ({
        action: n[0], resource_type: n[1],
        resource: n[1] === "named-graph" ? ["testdb", n[2]] : ["testdb"]
      }));
    });
    const READ = await A.roleName(page, "read", "plant-conservation");
    const { out, sent } = await reset(page, { [READ]: perms });
    expect(out.repaired).toEqual([]);
    expect(out.granted + out.revoked).toBe(0);
    expect(sent.filter((r) => r.method === "PUT" || /\/delete$/.test(r.path))).toHaveLength(0);
  });

  test("a grant that was added by hand comes back off", async ({ page }) => {
    const perms = await page.evaluate(() => {
      State.db = "testdb";
      return grantsForLevel("read", schemeGraphs(schemeById(State.schemeId))).map(n => ({
        action: n[0], resource_type: n[1],
        resource: n[1] === "named-graph" ? ["testdb", n[2]] : ["testdb"]
      }));
    });
    const stray = NG("WRITE", "urn:taxonomy:scheme:plant-conservation:draft");
    const READ = await A.roleName(page, "read", "plant-conservation");
    const { out, sent } = await reset(page, { [READ]: perms.concat([stray]) });
    expect(out.revoked).toBe(1);
    const del = sent.find((r) => /\/delete$/.test(r.path));
    expect(del.body).toMatchObject({ action: "WRITE", resource_type: "named-graph" });
    expect(del.body.resource[1]).toBe("urn:taxonomy:scheme:plant-conservation:draft");
  });

  test("a grant that went missing is put back", async ({ page }) => {
    const READ = await A.roleName(page, "read", "plant-conservation");
    const { out } = await reset(page, { [READ]: [] });
    expect(out.granted).toBeGreaterThan(0);
    expect(out.repaired).toEqual([READ]);
  });

  test("a role this app did not create is never changed", async ({ page }) => {
    const { sent } = await reset(page, { some_other_role: [NG("ALL", "anything")] });
    /* Reading every role's grants is how the list is built, so a GET is fine.
       Nothing may be written to one. */
    const wrote = sent.filter((r) => r.path.includes("some_other_role")
      && (r.method === "PUT" || r.method === "POST"));
    expect(wrote).toHaveLength(0);
  });

  test("a wildcard grant is left where it is", async ({ page }) => {
    const wild = { action: "ALL", resource_type: "named-graph", resource: ["*"] };
    const READ = await A.roleName(page, "read", "plant-conservation");
    const { sent } = await reset(page, { [READ]: [wild] });
    expect(sent.filter((r) => /\/delete$/.test(r.path))).toHaveLength(0);
  });

  test("a role that does not exist is reported, not created", async ({ page }) => {
    const { out, sent } = await reset(page, {});
    /* One per capability, read from the app rather than written down here: a
       new capability must not make this test say the wrong thing quietly. */
    const levels = await page.evaluate(() => ACCESS_LEVELS.length);
    expect(out.absent.length).toBe(levels);
    expect(sent.filter((r) => r.path === "/admin/roles" && r.method === "POST")).toHaveLength(0);
  });
});

test.describe("Who is on the team", () => {
  test("the person reading the screen is on it", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    const out = await page.evaluate(async () => {
      State.mode = "live"; State.db = "testdb";
      State.conn = Object.assign({}, State.conn, { user: "lead", endpoint: "https://x.test" });
      const real = Backend.request;
      Backend.request = async (o) => {
        if (o.path === "/admin/roles") return { ok: true, json: async () => ({ roles: [] }), text: async () => "{}" };
        if (o.path === "/admin/users") return { ok: true, json: async () => ({ users: ["lead", "someone-else"] }), text: async () => "{}" };
        if (o.path === "/admin/users/lead")
          return { ok: true, json: async () => ({ enabled: true, superuser: true, roles: [], permissions: [] }), text: async () => "{}" };
        return { ok: true, json: async () => ({}), text: async () => "{}" };
      };
      Perms.loaded = true;
      Perms.entries = [{ action: "ALL", type: "*", resources: ["*"] }];
      try { await openTeamPanel(); } finally { Backend.request = real; Perms.reset(); }
      const modal = document.querySelector(".modal") || document.body;
      const table = modal.querySelector("table.reltable");
      const out = { text: modal.textContent, team: table ? table.textContent : "" };
      document.getElementById("mCancel") && document.getElementById("mCancel").click();
      return out;
    });
    expect(out.text).toContain("lead");
    expect(out.text).toMatch(/administrator of this server/);
    /* An account with nothing to do with any taxonomy is not on the team --
       it is only in the box for searching the directory, which is where a new
       colleague is found. */
    expect(out.team).not.toContain("someone-else");
    expect(out.team).toContain("lead");
  });
});
