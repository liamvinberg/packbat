# Web scaffold notes

## Static output

The deployable static site is emitted to `apps/web/dist/client` by `pnpm -C apps/web build`. The build also emits a
server bundle to `apps/web/dist/server`; the static deploy does not need it.

## Package versions

- `@fontsource-variable/archivo` 5.2.8
- `@fontsource/space-mono` 5.2.9
- `@tanstack/react-router` 1.170.18
- `@tanstack/react-start` 1.168.28
- `react` 19.2.7
- `react-dom` 19.2.7
- `@tailwindcss/vite` 4.3.2
- `tailwindcss` 4.3.2
- `vite` 8.1.4
- `@types/react` 19.2.17
- `@types/react-dom` 19.2.3
- `typescript` 7.0.2

The three type packages are compiler-only dev dependencies required by the specified `tsc` script. They do not add
runtime behavior.

## TanStack Start 1.168 prerender configuration

The installed version uses `prerender.enabled`, `prerender.autoStaticPathsDiscovery`, and `prerender.crawlLinks` on
the `tanstackStart` Vite plugin. Static route discovery emits both `/docs` (the layout) and `/docs/` (its index) to
the same `docs/index.html`, so `/docs/` is excluded from the generated sitemap to keep its canonical eight URLs.

The plain `/404` route is prerendered to `dist/client/404.html` and excluded from the sitemap. The static host must
map misses to `/404.html` at deploy time. The root `notFoundComponent` remains responsible for client-side misses.
