# Static graphpaper adapters: verification record

2026-09-11, unreleased SDK 0.1.0 and engine 1.1.0.

Static adapters are implemented. Supported local Browser interaction and
responsive checks now have a real-browser witness; activating reduced motion
remains unverified. This record is not a claim of merge readiness, publication,
or Inbox adoption. The [ADR](ADR-GRAPHPAPER-FRONTEND-SDK.md) distinguishes
implemented APIs, consumer recommendations, and remaining proposals.

## Current continuation: repository and Browser access

Before file changes, the checkout was clean on
`codex/1.1.0-engine-projections`, HEAD
`f8c8a8de6a7980d005dfb84811d4f923d2478fc2`.

- The first normal @Browser request to `http://127.0.0.1:55829/` returned
  `net::ERR_CONNECTION_REFUSED`, not the prior saved-permission denial. No
  heading was available and no files were changed in that attempt.
- The user supplied `http://127.0.0.1:62510/`; normal @Browser access succeeded
  with heading **Support triage: static browser witness**. The prior
  saved-permission denial did not recur. No security setting was changed and
  no alternate browser, raw CDP, desktop-control, or HTTP-fetch bypass was used.
- The user-owned Terminal server was left running. Because the harness caches
  built assets at startup, agent-owned temporary witness servers at ports
  62709 and 62854 served the fixes through normal Browser access. These
  temporary servers are stopped after verification. The user's existing
  server retains its startup assets until the user restarts it.

## Browser findings and fixes

1. **Mouse selection:** at the recorded commit, clicks on the normalizer group
   and rectangle left selection empty while Enter worked. graphpaper 0.5.0
   captures the pointer on the SVG for panning; Chromium retargets the click
   there. The adapter now releases that capture for primary mouse presses on
   nodes, allowing the renderer's existing click handler to run. Real dragging
   still pans without selecting. No renderer fork or new selection API was
   added; touch/pen and background capture remain renderer-owned.
2. **Natural sizing:** the renderer's inline `width:100%` expanded a 704px
   figure to the desktop canvas width. The SDK now bounds the canvas by the
   server's natural-width variable. The drawing remains 704 × 1446 at desktop
   width and scales down on narrow screens.
3. **Details visibility:** at 390 × 844, the original absolute panel began at
   y=1138 after selection, entirely below the viewport. It now stays fixed in
   the viewport: a desktop side panel and a bottom sheet at <=680px. The body
   scrolls when needed, while the heading and close control stay visible.
4. **Key occlusion:** the floating key covered part of the on-call terminal.
   The key and zoom controls now occupy space below the drawing.

Regression coverage adds one browser-wiring case using graphpaper's real
interaction binder (mouse capture/target retention, drag suppression, untouched
other gestures, cleanup) and one shipped-CSS layout-contract case. These tests
are not substitutes for the measured browser geometry below. The private
witness adds deterministic race/destroy/remount controls and a bounded visible
request log, without adding SDK APIs or shipping the harness in either package.

## Actual Browser verification (2026-09-11)

Codex In-app Browser, the support-triage fixture, the pinned real graphpaper
0.5.0 renderer, and real ELK. Updated browser module/CSS bytes were served by
the temporary witness, ending at port 62854.

| Check | Observed result |
| --- | --- |
| ELK and visual layout | Mounted with ELK; 12 SVG node groups and 21 edge groups; no overlapping node rectangles or NaN/Infinity geometry. Desktop SVG 704 × 1446. Upper and lower graph screenshots inspected. Key starts below SVG, with terminal labels unobscured. |
| Mouse and pan/zoom | Clicking a drawn node selects it with `source: pointer`, adds `aria-current`, and opens matching details. A 50 × 40 px drag changes viewBox from `0 0 704 1446` to `-50 -40 704 1446`, with no selection. Zoom-in changes viewBox width to 586.6667; Fit restores 704. |
| Keyboard and panel | Enter on normalizer and Space on outage signal select with `source: keyboard` and focus the panel. Tab reaches the close button; Escape and close hide the panel, clear the node hash, and focus the selected SVG node. Tab from normalizer reaches outage signal. Narrow-screen Escape also restores focus. |
| Deep links | Loading `#tab=policy&filter=open&node=normalize` selects normalizer. Selecting outage signal changes only `node`; clear retains `#tab=policy&filter=open`. Missing IDs and duplicate `node` parameters select nothing and leave their hash unchanged. Non-null history-state preservation remains covered by the automated test, not this UI harness. |
| Wrong identity | A canned response with the wrong graph version shows only “Details for this version are unavailable.” Restoring correct identity renders sealed details. |
| Slow A / fast B | Log: Started #1 normalize delay=650; Started #2 outage-signal delay=0; Received #2; Received #1. Panel remains outage-signal after #1 arrives. |
| Stale same-node response | Log: Started #3 normalize mismatch=1 delay=650; Started #4 normalize mismatch=0 delay=0; Received #4; Received #3. Valid normalizer details remain after the older wrong-identity response. |
| Destroy with pending response | Request #5 arrives after destroy; panel count remains 0, hydration attribute absent, zoom controls absent, all 12 original server SVG nodes retained. Enter on the restored node does not select. |
| Remount and stale old mount | Ordinary remount selects the retained valid hash. Race #7 (old mount, wrong identity, delayed) and #8 (new mount, valid) arrives #8 then #7; valid details remain, exactly one panel, hydrated marker IDs use the new mount suffix. |
| Responsive | Checked 1280 × 900, 390 × 844, 680 × 900, 681 × 900, 320 × 700, and 320 × 480. At 680px the sheet spans the width; at 681px the side panel is 440px wide. No horizontal page overflow at 390px or 320px. At 320 × 480 the sheet is 312px high; body client/scroll heights are 250/308px. |
| Reduced motion | Browser query is false (“no preference”). CSSOM contains the SDK rules disabling panel/node animation, transitions, and smooth scrolling under the reduce query. Activating that query was **not** verified: the Browser advertises only visibility and viewport overrides. No OS preference was changed. |
| Console | No warning/error logs returned during the final Browser witness. |

Individual checkbox actions took longer than 650ms in one attempted manual
race, so that attempt is not evidence of overlapping responses. The later
synchronous race controls and observed out-of-order logs above supply that
evidence.

## Automated verification at the end of the static-adapter phase

`npm run build && npm run release:manifest && npm run check` exited **0**
on the final source and shipped README bytes:

- Engine: **295 passed**, zero failed/cancelled/skipped/todo.
- SDK: **94 passed**, zero failed/cancelled/skipped/todo (41 core,
  21 browser-wiring, 15 server/assets, and 17 viewer-data cases).
- Exact payloads remain **132 engine files / 34 SDK files**, independently
  manifested; the SDK and private witness remain excluded from the engine.
- Reproducible archives, raw-NUL guards, import boundaries, offline packed
  installs, runtime/strict TypeScript consumption, real ELK server rendering,
  and complete local viewer asset closure checks passed.
- Engine archive SHA-256:
  `a26c6911e344994faf25aca2fb56e079725092882fed72c8718a3fefd04c5a7b`.
- SDK archive SHA-256:
  `52513cedf51db6931ce927a618e03b4dcde46215a671f1000f5563ac76b49517`.
- `node --check scripts/serve-graphpaper-witness.mjs` and `git diff --check`
  exited 0. Engine source/built modules/schemas, graph fixtures and seals,
  and SDK model goldens have no diff.
- The final verification-record update only records these results and is
  outside both payloads. The temporary witness servers were stopped with
  Ctrl-C (exit 130); the user-owned server was not stopped or restarted.

The preliminary ordered gate reached SDK tests and failed the newly added
mouse regression because its fake DOM lacked `parentNode`, which graphpaper's
real binder uses to walk from the rectangle to its node. Adding the DOM alias
corrected the test fixture; the subsequent targeted packed SDK check passed
94/94 tests. No application failure was hidden by that test correction.

No fresh-clone gate is claimed for these uncommitted changes. The previously
reported fresh-clone success at f8c8a8d is historical. No commit, push, merge,
or publication was performed.

## Remaining limitations and recommended next slice

- Activate reduced motion in a Browser that supports the preference and
  inspect selection/panel behavior. The current witness does not establish
  screen-reader behavior, touch/pen gestures, or cross-browser compatibility.
- Compact labels scale down at narrow widths; zoom and scrolling remain
  available. This is a fixture witness, not a universal large-graph or
  consumer-host layout guarantee. Hosts with transformed ancestors need to
  check their fixed-panel containing block in their own integration.
- A signed-in deployed consumer witness, authorization/catalog correctness,
  Inbox adoption, and new-candidate fresh-clone verification remain separate.
- Recommended next slice: finish the reduced-motion witness, review these
  static fixes (including the graphpaper compatibility shim), then obtain user
  approval for a commit and run fresh-clone verification at that candidate.
  Runtime overlays, metrics, proposal diagrams, `update`, and goal scopes
  remain proposed. P8 and P7 were deferred during this Browser slice; the
  subsequent user-requested implementation is recorded in
  [P7/P8 contracts and verification](IMPLEMENTED-P7-P8.md). The results above
  describe the static-adapter phase, before those engine changes.

## Historical automated checks (2026-09-10)

`npm run build && npm run release:manifest && npm run check` exited 0:

- Engine: 295 passed, 0 failed, cancelled, skipped, or todo.
- SDK: 92 passed, 0 failed, cancelled, skipped, or todo (41 existing core
  cases, 20 browser-wiring, 14 server/assets, and 17 viewer-data cases).
- Exact payloads: 132 engine files and 34 SDK files, separate manifests.
- Reproducible archives, raw-NUL guards, import boundaries, offline packed
  installs, runtime and strict TypeScript export checks passed.
- Both graphpaper's built-in layout and real ELK rendered server figures.
  Inert JSON, layout-failure redaction/fallback, asset ETags, and the complete
  local browser module dependency set passed their checks.
- `git diff --check` exited 0. Engine source/artifacts, graph fixtures,
  presentation/goal seals, and existing SDK model goldens were unchanged.
- The private witness script passed syntax and local HTTP smoke checks:
  real ELK SSR, eight asset routes/ETags, browser module syntax, exact canned
  details and wrong-identity refusal, and 404/405 routes. Its temporary server
  was stopped afterward (intentional SIGTERM, exit 143); no browser interaction
  was performed by this HTTP check.

The clean-candidate fresh-clone gate is run after committing; its exact commit
and result are reported in the handoff. That gate permits dependency fetching
only during `npm ci --ignore-scripts`, then runs verification offline.

## Preliminary failures, corrected before the passing gate

- TypeScript reported TS2345: `DiagramModel` was not assignable to the
  renderer's `DiagramModelInput`. The strict model validator now returns the
  validated intersection required by the public renderer entry points.
- A new viewer-data test initially passed 16/17 cases. Its sparse parameter
  array correctly failed earlier with `node details requires dense arrays
  without extra keys`; a dense array now exercises the intended parameter
  record rejection. The final suite passes 17/17.
- The SDK boundary check exited 1 with `ambient browser/process/effect
  capability is outside the static core: Function`. It now permits only the
  intrinsic `Function.prototype` inequality used to stop capability lookup;
  dynamic code construction remains forbidden.
- A packed check during final source edits exited 1 with `SDK manifest digest
  mismatch for src/browser.ts`. The complete ordered build/manifest/check was
  rerun after edits settled, with current generated bytes.
- Independent review reproduced an empty injected layout drawing zero nodes,
  an incomplete edge point emitting `NaN` in SVG, and overlapping canvas
  ownership/duplicate hydrated marker IDs. Shared layout admission, canvas
  ownership checks, and per-mount marker IDs now have regression coverage.

## Running the private witness

After building, run `node scripts/serve-graphpaper-witness.mjs` from the
repository root. The private development harness prints an ephemeral
`127.0.0.1` URL and serves the support-triage figure, real ELK, SDK assets,
and canned local details. Visible controls exercise selection, teardown,
remount, delayed responses, wrong graph identity, and deterministic races;
the request log shows arrival order. It uses no provider, credentials, store,
or pipeline execution and is excluded from both payloads. The asset set is
cached at startup, so a changed build needs a new harness process.
