const { test, expect } = require("@playwright/test");
const fs = require("fs");
const A = require("../helpers/app");

/**
 * The whole app is one inline <script>. A syntax error anywhere in it means
 * nothing runs at all — and every other spec then fails by *timing out*
 * waiting for `#app.ready`, which takes the suite from ~50s to over five
 * minutes and says nothing about the cause. This runs first and names it in
 * about a second.
 */
test.describe("The file is loadable at all", () => {
  test("the inline script parses", () => {
    const html = fs.readFileSync(A.APP_FILE, "utf8");
    const m = html.match(/<script>([\s\S]*)<\/script>/);
    expect(m, "no inline <script> found").toBeTruthy();
    // Function() compiles without executing — exactly the parse check we want.
    expect(() => new Function(m[1])).not.toThrow();
  });

  test("no stray control bytes", () => {
    const buf = fs.readFileSync(A.APP_FILE);
    // A NUL survives a text editor and a diff but breaks grep, and has slipped
    // in from a scripted edit before now.
    expect(buf.includes(0), "file contains a NUL byte").toBe(false);
  });

  test("the app boots and renders a tree", async ({ page }) => {
    await A.boot(page, { scheme: "plant-conservation" });
    expect((await A.treeRows(page)).length).toBeGreaterThan(0);
    expect(page.__errors).toEqual([]);   // boot() collects pageerror on this
  });
});
