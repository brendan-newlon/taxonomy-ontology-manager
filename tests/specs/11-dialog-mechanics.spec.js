const { test, expect } = require("@playwright/test");
const A = require("../helpers/app");

/**
 * The dialog mechanics behind the reported "I can't add new concepts".
 *
 * The searchable picker's list used to sit in the flow of the dialog, so
 * opening it made the dialog taller and closing it made it shorter. Pressing
 * the primary button closed the list (the field blurred), the dialog shrank,
 * the button moved out from under the pointer, and the release landed on the
 * backdrop — which dismissed the dialog with nothing done. Two independent
 * defences are asserted here: the list no longer resizes the dialog, and a
 * click that began inside the dialog never dismisses it.
 */
test.describe("Dialog mechanics", () => {
  test.beforeEach(async ({ page }) => { await A.boot(page, { scheme: "plant-conservation" }); });

  const geometry = (page) => page.evaluate(() => {
    const ok = document.getElementById("mOk").getBoundingClientRect();
    const m = document.querySelector(".modal").getBoundingClientRect();
    return { okTop: Math.round(ok.top), modalTop: Math.round(m.top), modalH: Math.round(m.height) };
  });

  test("opening a picker does not move the dialog or its buttons", async ({ page }) => {
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New concept");
    await page.fill("#mText", "Geometry check");
    const closed = await geometry(page);

    await page.click("#mBroader");
    await page.waitForSelector("#mBroader_list .pick-opt");
    const open = await geometry(page);

    expect(open).toEqual(closed);
  });

  test("pressing Create while the broader list is open still creates the concept", async ({ page }) => {
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New concept");
    await page.fill("#mText", "Created with the list open");
    await page.click("#mBroader");                       // browse, then change your mind
    await page.waitForSelector("#mBroader_list .pick-opt");
    await page.click("#mOk");
    await page.waitForTimeout(120);

    expect(await A.conceptByLabel(page, "Created with the list open")).toBeTruthy();
    expect(await A.modalOpen(page)).toBe(false);
  });

  test("the same holds for a picker that was pre-filled from the tree", async ({ page }) => {
    const parent = A.sdg("freshwater");
    await A.rightClick(page, parent);
    await A.clickMenu(page, "child");
    await A.waitModal(page, "New concept");
    await page.fill("#mText", "Aquifer recharge zone");
    await page.click("#mBroader");
    await page.waitForSelector("#mBroader_list .pick-opt");
    await page.click("#mOk");
    await page.waitForTimeout(120);

    const c = await A.conceptByLabel(page, "Aquifer recharge zone");
    expect(c).toBeTruthy();
    expect(await A.broaderOf(page, c)).toEqual([parent]);
    expect(await A.treeHas(page, c)).toBe(true);
  });

  test("a press that starts inside the dialog never dismisses it", async ({ page }) => {
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New concept");
    await page.fill("#mText", "Still here");

    // press on a field, release out on the backdrop — a slipped click, or a drag
    // that began as a text selection
    await page.evaluate(() => {
      const bg = document.querySelector(".modal-bg");
      const f = document.getElementById("mText");
      const opt = { bubbles: true, cancelable: true };
      f.dispatchEvent(new MouseEvent("mousedown", opt));
      bg.dispatchEvent(new MouseEvent("mouseup", opt));
      bg.dispatchEvent(new MouseEvent("click", opt));
    });
    await page.waitForTimeout(60);

    expect(await A.modalOpen(page)).toBe(true);
    expect(await page.inputValue("#mText")).toBe("Still here");
    await A.modalCancel(page);
  });

  test("a genuine backdrop click still dismisses the dialog", async ({ page }) => {
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New concept");
    await page.evaluate(() => {
      const bg = document.querySelector(".modal-bg");
      const opt = { bubbles: true, cancelable: true };
      bg.dispatchEvent(new MouseEvent("mousedown", opt));
      bg.dispatchEvent(new MouseEvent("mouseup", opt));
      bg.dispatchEvent(new MouseEvent("click", opt));
    });
    await page.waitForTimeout(60);
    expect(await A.modalOpen(page)).toBe(false);
  });

  test("Escape still closes a dialog", async ({ page }) => {
    await page.click("#btnNewConcept");
    await A.waitModal(page, "New concept");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
    expect(await A.modalOpen(page)).toBe(false);
  });

  test("choosing a picker row enables a button that was gated on it", async ({ page }) => {
    await A.clickRow(page, A.sdg("sustainable-agriculture"));
    await A.selectTab(page, "relations");
    await A.addRelation(page, "broader");
    expect(await A.okDisabled(page)).toBe(true);

    // free text nobody picked is not an answer
    await page.fill("#mTarget", "nothing like this exists");
    expect(await A.okDisabled(page)).toBe(true);

    await A.pick(page, "mTarget", "Natural resources");
    expect(await A.okDisabled(page)).toBe(false);
  });

  test("a picker low in a scrolling dialog is not clipped by it", async ({ page }) => {
    await A.reveal(page, A.sdg("forests"));
    await A.rightClick(page, A.sdg("forests"));
    await A.clickMenu(page, "dep");                   // a long dialog whose body scrolls
    await A.waitModal(page, "Deprecate concept");
    await page.click("#mRepl");
    await page.waitForSelector("#mRepl_list .pick-opt");

    const seen = await page.evaluate(() => {
      const l = document.getElementById("mRepl_list");
      const r = l.getBoundingClientRect();
      // how many rows are actually painted, not merely positioned
      const rows = [...l.querySelectorAll(".pick-opt")].filter((o) => {
        const b = o.getBoundingClientRect();
        return b.top >= r.top - 1 && b.bottom <= r.bottom + 1 &&
          document.elementFromPoint(b.left + 20, b.top + b.height / 2)?.closest(".pick-opt") === o;
      });
      return { height: Math.round(r.height), rows: rows.length };
    });
    expect(seen.height).toBeGreaterThan(150);         // the full list, not two rows
    expect(seen.rows).toBeGreaterThan(4);
    await A.modalCancel(page);
  });

  test("an open picker never covers the dialog's own buttons", async ({ page }) => {
    const check = async () => page.evaluate(() => {
      const l = document.querySelector(".pick.open .pick-list").getBoundingClientRect();
      const f = document.querySelector(".modal-foot").getBoundingClientRect();
      return l.bottom <= f.top + 1;
    });

    await page.click("#btnNewConcept");
    await A.waitModal(page, "New concept");
    await page.click("#mBroader");
    await page.waitForSelector("#mBroader_list .pick-opt");
    expect(await check()).toBe(true);
    await A.modalCancel(page);

    await A.reveal(page, A.sdg("forests"));
    await A.rightClick(page, A.sdg("forests"));
    await A.clickMenu(page, "dep");
    await A.waitModal(page, "Deprecate concept");
    await page.click("#mRepl");
    await page.waitForSelector("#mRepl_list .pick-opt");
    expect(await check()).toBe(true);
    await A.modalCancel(page);
  });

  test("a picker with no room below opens upwards", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 520 });
    await A.reveal(page, A.sdg("forests"));
    await A.rightClick(page, A.sdg("forests"));
    await A.clickMenu(page, "dep");
    await A.waitModal(page, "Deprecate concept");
    await page.click("#mRepl");
    await page.waitForSelector("#mRepl_list .pick-opt");
    const geo = await page.evaluate(() => {
      const l = document.getElementById("mRepl_list").getBoundingClientRect();
      const i = document.getElementById("mRepl").getBoundingClientRect();
      return { listTop: l.top, listBottom: l.bottom, inputTop: i.top, inputBottom: i.bottom, h: innerHeight };
    });
    // wherever it went, it is on screen and it is not on top of its own field
    expect(geo.listTop).toBeGreaterThanOrEqual(0);
    expect(geo.listBottom).toBeLessThanOrEqual(geo.h);
    expect(geo.listTop >= geo.inputBottom || geo.listBottom <= geo.inputTop).toBe(true);
    await A.modalCancel(page);
  });

  test("keyboard accelerators work after clicking a concept, with no extra click", async ({ page }) => {
    await A.reveal(page, A.sdg("mangrove"));
    await A.clickRow(page, A.sdg("mangrove"));
    await page.keyboard.press("F2");
    await page.waitForSelector("#tree input.rename", { timeout: 5_000 });
    await page.keyboard.press("Escape");
  });
});
