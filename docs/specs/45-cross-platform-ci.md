# #45 Cross-platform CI: build and test on Windows, macOS and Linux

Issue: #45 · Milestone: Phase 2 · Desktop app core · Requirements: platforms · Stories: —

## Goal

A pull request shows whether Windows and Linux still build, test and launch the app, and macOS is checked
often enough to catch drift, without spending the free GitHub Actions minutes on a three-system run every time.

## Scope

- In: the verify workflows, npm and Electron caching, the headless smoke launch on each system, and the status
  badge in `README.md`.
- Out: installers and signing (#46). The smoke launch is the existing unpacked `electron . --smoke` run, not a
  packaged build. Live provider tests stay out of CI (they spend API money and need keys).

## Design

The owner chose this schedule on 2026-11-27. Linux minutes count 1×, Windows 2× and macOS 10×, and the free
plan includes 2,000 minutes a month. All three systems on every pull request and again on `main` would pass
that. So:

- **Every pull request** runs Ubuntu and Windows: install, `npm run verify`, then the smoke launch. There is
  no second run on a merge to `main`, except when the merge itself changes `verify.yml` or `verify-os.yml`,
  so the badge on `main` updates when CI changes.
- **macOS** runs on a pull request only when the diff touches `.github/workflows/` or `app/src/main/platform/`.
  It also runs every Monday at 07:15 UTC, and whenever someone presses Run workflow. That is the on-demand
  button for platform work the path filter did not catch.
- One called workflow, `.github/workflows/verify-os.yml`, does the work for a single runner. `verify.yml` calls
  it for `ubuntu-latest` and `windows-latest`. `verify-macos.yml` calls it for `macos-latest`.

Each job:

1. Check out the repo and set up Node 24.
2. Cache npm (the three lockfiles) and the Electron download (`ELECTRON_CACHE`).
3. `npm ci` at the root, in `server/`, and in `app/`. The Electron binary is downloaded. CI does not set
   `ELECTRON_SKIP_BINARY_DOWNLOAD`.
4. `npm run verify`: Biome, typecheck, gateway tests (including the provider contract) and app tests. Live
   tests live in `server/test/live/` and are not part of `npm test`.
5. On Linux, install the libraries Electron needs and `xvfb`. Package names use the `t64` variants when the
   runner's apt cache has them.
6. `electron-vite build`, then `electron . --smoke`. The app already exits 0 after printing `smoke: ok <n> bots`,
   or 1 on failure or after 30 s. Linux runs that under `xvfb-run -a` with `--no-sandbox` and `--disable-gpu`,
   because the hosted runner has no display and no Chromium sandbox setup. The renderer's own sandbox
   (`webPreferences.sandbox`) stays on. Windows and macOS launch Electron directly. The window is not shown
   in smoke mode.

A job that is still going after 20 minutes is cancelled. The aim is under 15 minutes per system.

## Interfaces

| File | When it runs |
| --- | --- |
| `.github/workflows/verify-os.yml` | Called, not triggered on its own |
| `.github/workflows/verify.yml` | Every pull request; Run workflow; push to `main` only if `verify.yml` or `verify-os.yml` changed |
| `.github/workflows/verify-macos.yml` | Pull requests that change `.github/workflows/**` or `app/src/main/platform/**`; Mondays 07:15 UTC; Run workflow |

Smoke command, from `app/` after the build: `node ./node_modules/electron/cli.js . --smoke`. That is the same
launch as `electron . --smoke`. Calling the cli with `node` keeps the arguments intact. Linux CI adds
`--no-sandbox`, `--disable-gpu` and `--disable-dev-shm-usage`, and runs it under `xvfb-run`.

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| A pull request shows a pass or fail for Windows and for Linux | The two checks on this pull request |
| macOS is checked weekly, on demand, and when platform or CI files change | `verify-macos.yml` triggers. This pull request changes the workflows, so it runs macOS once |
| Install, typecheck, unit and contract tests run on each system | `npm run verify` in `verify-os.yml`. Contract tests are `server/test/providers.contract.test.ts`, which `npm test` includes. Live tests are not |
| The unpacked app launches headless (Linux under Xvfb) | The smoke step. Packaged installers are #46 |
| npm installs are cached | `actions/setup-node` `cache: npm` and `actions/cache` on `ELECTRON_CACHE` |
| Status badge in `README.md` | The verify and macOS badges at the top of the readme |
| Each system finishes in under 15 minutes | The run times on this pull request. A cold Electron download may land near that line; later runs use the cache |

## Risks and open questions

- The original issue asked for all three systems on every pull request. That schedule would use on the order of
  15,000 billable minutes a month at the current pace. The owner picked the schedule in this spec instead.
- Please keep the Actions spending limit at $0, so a month that goes past the included minutes stops the runs
  instead of charging.
- Linux library names differ across Ubuntu releases. The install step checks apt for the `t64` names and falls
  back to the older ones. A missing library still fails the smoke launch, with Electron's loader error in the log.
- `--no-sandbox` is Linux CI only. It turns off the Chromium process sandbox the hosted image cannot set up.
  It does not turn off the app's renderer sandbox.
- The first macOS run is this pull request. If it fails, the fix stays in this branch.
