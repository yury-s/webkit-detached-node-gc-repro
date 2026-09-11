# Detached DOM nodes survive a forced full GC on Apple Silicon macOS

A container's children are removed and a full GC is forced through the Inspector (`Heap.gc`), but
the detached `<button>` elements are still reachable — every `WeakRef` to them still derefs, and
stays that way across repeated GCs.

It is all-or-nothing: either everything is collected, or nothing is.

Which locator call precedes the removal may not be part of the trigger. On microsoft/playwright's
CI the failure is confined to one test — `expect should not leak`, 61 of 88 runs on
`macos-15-xlarge`, with the `click` / `fill` / `waitFor` equivalents 0 of 88 — but the one hit
reproduced in this repo landed on the `wait-for` variant instead.

## Run it

```sh
npm install
npx playwright install webkit
node repro.js
```

On an unaffected machine every variant prints `ok`. On an affected one:

```
variant     alive  verdict
expect         29  LEAK — all 25 detached buttons survived the GC
wait-for        4  ok
click           4  ok
```

The bug is all-or-nothing: 29 of 29 means nothing was collected — 2 static buttons registered
twice, plus all 25 dynamic ones. 4 is correct, since the two static buttons are still in the
document. A count a little above 4 is **not** this bug; a Playwright action holding on to its last
target shows up as exactly one extra
([microsoft/playwright#41462](https://github.com/microsoft/playwright/issues/41462)), so anything
below 25 is reported as `ok` with the surplus noted, matching the upstream test's own threshold.

`--variant=<name>` runs one variant, `--repeat=N` runs it N times. Exit code is 1 only on
wholesale retention.

### Reproduction rate

Flaky, and the rate depends enormously on the machine. A single green run proves nothing.

| Where | WebKit | Samples | Full retention |
| --- | --- | --- | --- |
| microsoft/playwright CI, `macos-15-xlarge` (6-core M1) | r2359+ | 88 runs | ~70% (61) |
| this repo, standard `macos-26` (3-core M1, 7 GB) | r2359 | 322 | **1** |
| this repo, standard `macos-15` | r2359 | 322 | 0 |
| this repo, `ubuntu-24.04-arm` | r2359 | 322 | 0 |
| this repo, every runner | r2336 | 966 | 0 |

GitHub's larger macOS runners are an org-level feature, so this repo can only reach the 3-core
standard ones, where the rate is ~0.3% — enough to confirm the failure exists, not enough to
bisect against. A 6-core `macos-15-xlarge` bot or a physical Apple Silicon machine is a far better
place to run this.

The `partial` outcomes the script reports are unrelated: `click` retained exactly one extra element
6 times across 1932 samples, on both the good and bad builds
([microsoft/playwright#41462](https://github.com/microsoft/playwright/issues/41462)).

## The browser is the variable, not Playwright

`@playwright/test@1.63.0` ships WebKit **r2359** (first bad) and `@1.62.0` ships **r2336** (last
good), so swapping the dependency swaps the browser under an identical script:

```sh
npm install --no-save @playwright/test@1.62.0 && npx playwright install webkit && node repro.js
npm install --no-save @playwright/test@1.63.0 && npx playwright install webkit && node repro.js
```

`.github/workflows/repro.yml` runs that pair across `macos-15`, `macos-26` (both Apple Silicon) and
`ubuntu-24.04-arm` — arm64 but 4 KB pages and not Darwin, which separates "arm64" from "Apple
Silicon macOS".

## Platform matrix

From Playwright's own CI, 88 runs per bot between 2026-09-02 and 2026-09-11:

| Platform | Result |
| --- | --- |
| macOS 15 arm64 | **61 / 88 failed** |
| macOS 26 arm64 | fails |
| macOS 15 x86_64 | 0 / 86 failed |
| Linux x86_64, Linux arm64, Windows, WSL | green |

Apple Silicon macOS is the only 16 KB-page platform in that list, which may or may not be
meaningful.

## Regression range

Bisected on the Playwright side to a single commit — the WebKit roll itself, with the last green
and first red runs one commit apart:

```
b34b23471  green
2dec18d7e  feat(webkit): roll to r2359   <-- first red
```

That roll moves WebKit from `a5b2b89dc868ae220dd41e28b3fdca48bf75ee90` (319949@main) to
`73a19c0d770b4597e51c8aad5a57efab8bf9eea1` (320228@main) — 279 commits, not yet bisected upstream.

Three GC-related commits in that range are the obvious first places to look:

- 320112@main `[JSC] Introduce JSC WarmUpThread for MarkedBlocks` — adds a helper thread handing
  out pre-faulted `MarkedBlock`s, explicitly premised on "system page size is 16KB (on Darwin at
  least) and MarkedBlock size is also 16KB", i.e. the Apple Silicon case.
- `[JSC] Make MarkedSpace::stopAllocating faster` — new `BitSet::clearEachNthBit` driving
  `m_newlyAllocated`.
- `[JSC] Update profile concurrently from GC marker threads`.

Suspects by proximity and subject matter only; none confirmed.

## Narrowing it further

The variants exist to reduce this without a WebKit build, and each outcome points somewhere
different:

- **`dom-style`, `dom-event` or `dom-both` also leaks** — the bug is reachable from plain DOM calls
  (`getComputedStyle` + `getBoundingClientRect`, and/or a bubbling composed `CustomEvent`) in the
  main world, and converts directly into a LayoutTest using `GCController.collect()` with no
  Playwright at all.
- **only the Playwright variants leak** (`expect`, `wait-for`, `click`) — the trigger needs
  something those share and the `dom-*` variants lack: they run in an isolated world through the
  injected script, whereas `dom-*` runs in the main world. This is where the evidence currently
  points, since the one observed hit was on `wait-for`.
- **`none` leaks** — the assertion is irrelevant and the repro is much smaller than this.

JSC options can be A/B'd on a failing machine without rebuilding WebKit: prefixing an option with
`__XPC_` forwards it to the WebContent XPC service, so

```sh
__XPC_JSC_useWarmUpMarkedBlocks=false node repro.js --variant=expect
```

tests the first suspect directly. (The forwarding is verified: `__XPC_JSC_useJIT=false` slows a hot
in-page loop 4x.)

## Origin

Reduced from `tests/page/page-leaks.spec.ts` › `expect should not leak` in
[microsoft/playwright](https://github.com/microsoft/playwright), which counts the same WeakRefs
across two isolated worlds and so reports 58 rather than 29.
