# Chat access incident — 2026-10-21

The reported guild configures the AI chat role as `@everyone`. Its custom denial message is intentional and is preserved verbatim.

## Access checkpoint

- Recognize the implicit `@everyone` membership (role ID equals guild ID), even when Discord's cached role collection omits it. Apply this to direct access and context observation. Still require a resolved guild member; explicit restricted roles and channel restrictions remain enforced.
- Before sending a denial based on cached membership, force-refresh the requesting member and evaluate the current profile. A failed refresh is unavailable evidence, not proof of a permission denial; do not send the custom denial in that case.
- Emit content-free `chat.access.refreshed` cached/current reasons. Confirmed denials include `accessReason` and `memberRefresh` in `chat.route.skipped`; no role names, role IDs, or message bodies are logged.
- Regression checks cover implicit everyone, restricted everyone, explicit restrictions, channel restrictions, missing/stale member grants, failed membership lookup, and preservation of custom denial text. Focused access/routing/eligibility suites: 49 tests passed; changed-file lint and typecheck passed.

The supplied trace does not show the custom-denial delivery. It shows a different admitted direct turn suppressed during guarded-context validation after an eight-second validation deadline, with a later Discord GET rate-limit wait. Thus neither the screenshot nor that trace proves which cached access condition caused the displayed denials. The fixes cover reproducible false-denial paths and add the missing evidence for subsequent incidents; live confirmation still requires deployment and a new trace.

## Validation transport checkpoint

Each guarded-context validation pass may prime its transport cache from one new Discord REST history page, anchored immediately after the newest dependency. Newer traffic cannot push the dependency out of this page. The page is fetched anew for each pass, not reused from the previous pass or Discord's message cache.

Every retained source still passes the existing fresh author/role, scope, forget, origin/provenance, and representation checks. Missing or older dependencies require individual forced reads; a page omission never proves deletion. A failed page invalidates the pass. The eight-second phase deadline, cumulative work budget, bounded validation passes, and cancellation behavior remain unchanged. This reduces individual message GET pressure for nearby context; distant sources, membership requests, and provenance expansion can still encounter rate limits or deadlines.

New adapter/lease tests verify one page for 40 history messages plus the current source on each validation pass; fresh membership on every pass; edit, deletion, revocation, and foreign scope rejection; forced reads for unreturned dependencies; and fail-closed page failures. Full suite: **4,694 passed / 7 skipped**. Final typecheck, changed-file lint, and whitespace checks passed. No live settings, deployment, Discord messages, or production data were changed.
