# Test harness

Playwright + Chromium driving `../taxonomy_manager.html` through a real browser.

```bash
npm install          # first time only
npx playwright install chromium
npm test
```

`npm run test:headed` to watch it, `npm run test:ui` for Playwright's runner,
`npm run report` for the last HTML report.

The suite tests the `taxonomy_manager.html` beside this directory — so from a
worktree it tests that worktree's copy. `TAXONOMY_HTML=/path/to/other.html npm
test` aims it elsewhere, which is how a new test is checked against the version
it was written for, before the fix landed.

**`developer-docs/TESTING.md` is the document to read** — what is covered, why
those things, how the harness drives the app, and what it deliberately cannot
reach. This file is just the commands.
