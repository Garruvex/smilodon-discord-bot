# Chat incident review follow-ups — 2026-10-21

The installed Discord.js role-manager getter always inserts the guild ID into its role-cache collection, even when the everyone role object is unavailable. The original everyone-cache explanation was not a demonstrated production cause. The explicit everyone check is defensive; confirmed production denial causes must come from the new access diagnostics.

## Access

Mention execution and uncached reply routing share a resolver. Cached denials are checked against a fresh member lookup with a two-second caller deadline. Concurrent denied checks for the same guild/member share the underlying request, including after caller timeout; completed results are not cached as authorization. The pending-request map is bounded to 256 entries. Configuration is reread after lookup. Existing cached grants retain their prior behavior and downstream guard checks still apply.

Unknown membership emits `access_unavailable`, not `access_denied`, and uses the existing opt-in private-note path with localized text. Verified denials preserve the server's custom message. Lazy reply authorization avoids reading target messages without access; the four-second routing deadline also prevents a late authorization result from initiating a target fetch. Already-dispatched SDK requests may still finish after application timeouts.

## Context transport

Validation and session checks use individual reads for fewer than four requested IDs. Larger sets use at most three fresh pages, each anchored at the newest dependency outside the preceding page's range. Missing messages within an already fetched window are individually rechecked instead of triggering repeated page fetches. All existing author, scope, forgetting, provenance, deadline and source-work checks remain mandatory. Dispersed sources beyond three pages still use individual reads and may hit the existing deadlines.

Regression coverage includes simulated REST delays, multiple authors, distant dependency groups, tiny sets, page bounds, real Discord.js everyone-cache behavior, concurrent stalled membership requests, configuration changes during lookup, and uncached replies with pings disabled.

## Release identity

`npm run stack:up` obtains Git HEAD, passes it as an image build argument, and starts the stack with `--no-build` only after a successful build. The runtime image exposes `BUILD_SHA` and the OCI revision label. Missing Git metadata stays explicitly unknown. The SHA denotes the base commit; release builds should use a clean checkout. No Docker build, deployment, live messages, or server settings were changed during this work.

The deployment wrapper uses only Node built-ins so Docker-only hosts do not need TypeScript tooling or installed development dependencies. Validation: **4,707 tests passed / 7 skipped**, typecheck, changed-file ESLint, script syntax, and whitespace checks passed. After making the wrapper dependency-free, its three deployment-planning tests were rerun successfully. These tests inject a command runner; they do not build images or start containers.
