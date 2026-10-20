# Chat access incident — 2026-10-21

The reported guild configures the AI chat role as `@everyone`. Its custom denial message is intentional and is preserved verbatim.

## Access checkpoint

- Recognize the implicit `@everyone` membership (role ID equals guild ID), even when Discord's cached role collection omits it. Apply this to direct access and context observation. Still require a resolved guild member; explicit restricted roles and channel restrictions remain enforced.
- Before sending a denial based on cached membership, force-refresh the requesting member and evaluate the current profile. A failed refresh is unavailable evidence, not proof of a permission denial; do not send the custom denial in that case.
- Emit content-free `chat.access.refreshed` cached/current reasons. Confirmed denials include `accessReason` and `memberRefresh` in `chat.route.skipped`; no role names, role IDs, or message bodies are logged.
- Regression checks cover implicit everyone, restricted everyone, explicit restrictions, channel restrictions, missing/stale member grants, failed membership lookup, and preservation of custom denial text. Focused access/routing/eligibility suites: 49 tests passed; changed-file lint and typecheck passed.

The supplied trace does not show the custom-denial delivery. It shows a different admitted direct turn suppressed during guarded-context validation after an eight-second validation deadline, with a later Discord GET rate-limit wait. Thus neither the screenshot nor that trace proves which cached access condition caused the displayed denials. The fixes cover reproducible false-denial paths and add the missing evidence for subsequent incidents; live confirmation still requires deployment and a new trace.
