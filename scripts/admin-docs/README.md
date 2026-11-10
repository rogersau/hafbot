# Admin documentation screenshots

The capture script renders the production admin SPA against fictional, deterministic API fixtures.
It never signs in to Discord or reads live customer data.

Run `pnpm exec playwright install chromium` once on a new development machine, then use:

- `pnpm docs:screenshots` to update checked-in screenshots.
- `pnpm docs:screenshots:check` to capture into `.artifacts/admin-docs` and fail when visual changes
  exceed the small tolerance for live status text and browser anti-aliasing. Failed comparisons also
  write a `.diff.png` image.

Add scenarios to `scenarios.mjs`. Each scenario declares its route, viewport, capture locator,
output image, and every `/admin/api/*` response needed to render that state. Missing responses fail
the capture so newly introduced UI dependencies cannot silently reach external services.

An optional `annotations` array places numbered markers relative to stable CSS selectors. Give each
marker a number and short label, then provide the matching numbered explanation beside the image in
the customer documentation. A missing annotation target fails the capture instead of producing a
misleading image.

For stable comparisons, update and check screenshots with the same operating system and Playwright
version. CI is intended to be the canonical Linux rendering environment.
