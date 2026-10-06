# D&D engine and Discord UX fix plan

Review date: 2026-09-30. This records planned fixes, not completed implementation.

## 1. Combat choices must match engine legality

Confirmed with temporary reproduction tests; existing campaign suite passed 2,100 tests across 113 files.

- Quickened Spell: account for armed metamagic when calculating action cost and presenting spells after an action is spent (`domain/campaign/combat/turn-rules.ts:374`).
- Twinned Spell: expose the effective target count, including metamagic, in the turn view (`application/campaign/views/turn-view.ts:129`).
- Innate and item-charge spells: derive available casting levels from their use pool, rather than ordinary spell slots; do not offer unsupported upcasts (`domain/campaign/combat/turn-rules.ts:380`).
- Share effective casting rules between validation and presentation. Verify legal choices remain selectable through the actual Discord handlers, including resource exhaustion.

## 2. Adventure upload, language and library management

Agreed direction from the review:

- Hub → Adventures → Upload → confirm adventure language → validate and review → add to library.
- Offer English and Traditional Chinese. Prefill from file metadata; handle missing or conflicting metadata explicitly. Selecting a language labels an edition and does not translate its content.
- Keep interface language separate from adventure/game language.
- Add a persistent adventure browser with title, language editions, version, uploader, status, and actions. Make pending drafts recoverable after the private upload screen is dismissed.
- Filter the game adventure picker by game language; changing language must reconcile the chosen adventure before creation.
- Permit the uploader to manage their own uploads. Explicitly support server owner, Discord Administrator, configured bot administrator, and DnD Admin for server-wide adventure management. Game-organizer status alone grants no ownership of other people's adventures. Retain module-access restrictions and guild isolation.
- Add Remove from library with a confirmation naming the edition/version and affected games. Hide removed entries from new-game selection and release their active catalog quota, while retaining versions needed by existing games and lobbies across restart. Define restore behavior without exceeding quota.
- Existing discard only works for pending drafts; approved entries currently cannot be removed and consume the default 20-entry allowance indefinitely.
- Keep upload entry permissions explicit; ordinary-player uploads are a separate policy decision from ownership of existing uploads.

Validation: both languages; metadata mismatch; owner/admin/uploader/non-owner roles; cross-guild denial; pending and approved removal; quota recovery; existing-game continuity after removal and restart.

## 3. Preserve the exact adventure players joined

Confirmed by source inspection:

- `CampaignLobbyService.start()` loads `document(id, language)`, which resolves the latest edition, but persists the original record's version pin. Hero selection also consults the latest document.
- Resolve the pinned version for lobby hero lists, hero selection, starting state, and later joins. Extend the document lookup to include version; never silently substitute a newer document.
- `UploadedAdventureLibrary.latest()` uses insertion order, not version ordering. Adding a version with only one language can also make another language's earlier edition disappear from new-game selection. Define explicit published defaults per language, stable across restart, and allow version inspection/selection.

Validation: create a version-1 lobby, publish version 2 with different hero/scene IDs, then select heroes and start the original lobby; verify all state and narration use version 1. Publish a new English edition while preserving a playable Chinese edition.

## 4. Approval must refer to the draft actually reviewed

Confirmed by source inspection:

- `AdventureCatalog.submit()` replaces an existing pending draft with the same key, including its uploader, without checking ownership. Approval controls identify only the key. An old private review can therefore approve replacement content if the reviewer has admin rights.
- Require ownership/admin authorization for replacement, show that a replacement is occurring, and bind review controls to a revision or content hash. Reject stale approval and show the updated review.
- Preserve a clear uploader/ownership policy rather than silently transferring ownership through replacement.

Validation: two administrators upload different content under the same ID/version/language, then use the first review; stale content must not be approved.

## 5. Complete the discovery and review UI

Confirmed by source inspection; proposed UX changes:

- Replace the next-adventure cycle button with a searchable/selectable or paginated list. Show language, version, premise, and suitable party information before choosing.
- `/dnd new` currently has no adventure option and always selects the default. Route it to the same wizard or expose equivalent adventure selection.
- `renderReview()` truncates its full content to 1,900 characters after appending warnings. Long previews can hide warnings while keeping Approve available. Put validation status first and provide paginated details or a downloadable report so all warnings remain accessible.
- Provide an upload template/example and field-level validation guidance in the upload flow, not just a YAML/JSON attachment prompt.

Validation: long previews with warnings, maximum catalog size, both language editions, parity between hub and slash-command creation, and returning to an unfinished review.

## Delivery order

1. Fix combat projection mismatches and adventure version continuity.
2. Add revision-bound draft decisions and authorized library removal with persistence support.
3. Build the library browser, language-aware upload/creation flow, and complete review screens.
4. Resolve scene image availability, ordering and organizer controls (section 6).
5. Establish canonical world and party continuity across narration and images (section 7).
6. Make character creation respect the chosen game/UI language (section 8).
7. Exercise Discord payload limits and end-to-end journeys: upload → approve → create → join → start → update/remove adventure → restart → continue.

Use focused regression tests for each confirmed issue, then the campaign suite and repository-required checks. Source review and fake-interaction tests do not replace live Discord acceptance testing.

## 6. Scene image generation and Discord feedback

Current trigger path: `recordOpening` requests the starting scene image after recording the opening; a `transitionScene` story effect requests the destination scene image; natural 1/20 checks can request an automatic moment image after narration. The organizer's Illustrate control requests a *moment* for the latest narrated round. Redo Picture targets the last successfully posted picture, which may be a scene, monster, hero, or moment. The background image worker resolves the pinned adventure version, builds a brief from public scene text and available party portraits, generates an image, saves it, and posts it as a bare attachment in the adventure post. Text play continues while the image job runs.

Confirmed gaps and changes:

- Image generation is optional (`CAMPAIGN_IMAGE_MODEL` plus API key). The engine and organizer controls still queue images when the image worker is absent. Expose capability to the command/UI layer: hide or disable image actions with a localized reason, and avoid accumulating jobs when there is no worker. Define whether queued jobs should run if the feature is enabled later.
- The organizer's labels do not reveal the scope: Illustrate means the latest narrated *moment*, not the current scene; Redo Picture means whichever image posted last. Offer explicit **Illustrate current scene**, **Illustrate latest moment**, and **Redo [subject]**, with the target shown before submission.
- The organizer gets a success message when a job is accepted, although generation and posting may fail later. Show queued, generating, posted, skipped, or failed state and offer retry for recoverable failures. Explain automatic scene-image behavior in the game setup/manage UI.
- A scene-transition request is queued before the Narrator tells that round. Its prompt uses the destination scene's public description, and the worker may post the image later, away from the narration. Decide whether the image should be tied to the corresponding narration/card, and whether it should wait until the new scene is actually told. The opening request already follows its recorded narration.
- Discord posting drops the scene caption and sends only a file named `scene.<extension>`. Include an accessible localized caption or scene identifier and keep a stable link/message ID so the game can surface or replace an image without an unexplained new attachment. Prevent stale images from visually suggesting the party is still in an earlier scene.
- Scene images are generated once per scene subject; revisiting a scene reuses the old completion state and produces no current depiction. Define a deliberate refresh action when the scene meaningfully changes, with a clear cost warning if generation is billed.

Validation: image provider absent and later enabled, opening and transition timing, failure/retry feedback, multilingual caption, late image after moving again, revisit, restart after generation but before Discord post, and exact-image redo rather than last-posted ambiguity.

## 7. Story, party and time continuity

Current strengths: the engine persists the scene ID, characters, member availability, health/resources, clues, flags, encounter history, ledger and event log. The narrator receives a public view of the current state plus recent rounds and summaries. The image worker uses the pinned adventure version and public scene text.

Confirmed gaps: neither `CampaignState` nor `AdventureBible` has a canonical campaign time of day or weather. `context-assembler.ts` lists the scene and party but has no authoritative time/weather to give the narrator. `ImageWorker.partyFor()` reads whichever members are present and whichever equipment/portraits they have when the background job runs, rather than when the scene was entered. Its scene brief uses the authored public description (plus the opening narration only for the starting scene), so a transitioned scene picture may omit meaningful changes established in the resolved round. Narration may mention a time or look that is not saved as structured state.

Required design:

- Introduce a small canonical `WorldState`: campaign day/time of day, location/scene, weather and lighting where relevant, plus durable scene facts. Store it through events and persistence; initialize it from the adventure. Avoid deriving in-world time from Discord timestamps or play-by-post waiting.
- Advance time only through validated story actions with explicit durations or organizer decisions: travel, rest, waiting, scene transitions and authored effects. Define what combat rounds do to elapsed time. State the selected time rules in the adventure/house-rule contract.
- Keep a snapshot or immutable reference for each narrated beat and picture request: scene/version, in-world time, lighting/weather, participating characters, their visual descriptions/portrait versions and the public facts established by that beat. A slow job must paint the requested moment, even if the party later moves, changes gear or goes away.
- Build the narrator and image briefs from the same canonical public snapshot. Model prose may enrich atmosphere, but a durable claim such as sunrise, a storm, an NPC arrival or a party member leaving must be committed as an event before later narration treats it as fact.
- Surface concise time and location on the adventure card, and expose a timeline/recap that distinguishes established facts from narration. Let the organizer correct a mistaken time or scene fact through an audited command instead of editing prose alone.
- Preserve image and narration associations by event/round ID. When narration is regenerated or corrected, mark the earlier image stale and offer a new picture explicitly; never silently show contradictory art.

Validation: time advances through rest/travel and survives restart; idle real-world delay does not change game time; a queued dusk image remains dusk after a later dawn scene; a player who joins/leaves or changes gear after the request does not appear incorrectly; image and narration cite the same scene facts; corrections propagate to future prompts without rewriting the event history.

## 8. Character-creator language

Confirmed behavior: `CharacterLibraryComponentHandler.languageOf()` maps the individual Discord client's interaction locale to `en` or `zh-TW` on every click and modal submit. The hub's My Characters/New Character entry and `/dnd characters` use it. They do not read the campaign language or a user-selected language. Chinese strings and glossary names exist and are covered by a Chinese-locale test, so the primary issue is language selection, not wholesale missing translations. A few small labels, such as the ability code beside a skill, are still built as raw English abbreviations.

Required UX contract:

- Entry from a game or its party panel starts in that game's chosen language. Entry from the server hub uses an explicit user-selected UI language where available, then the server default, then the Discord client locale. `/dnd characters` follows the same personal/server fallback and offers a visible language switch.
- Carry the chosen UI language through the entire private creator session, including class/race/skills, naming modal, validation, import/export notices, portrait flow, and return to the library. Do not recalculate from `interaction.locale` on every step; switching Discord client language mid-flow should not unexpectedly change the screen.
- Keep stable internal IDs and exported character data language-neutral. A saved character can be viewed in another language without rewriting its build or name. Keep player-written name/backstory untouched.
- Use localized class/race/skill/ability names, menu placeholders, error text, and modal labels; audit any raw IDs or English abbreviations that reach the screen. Preserve the game's language when a saved hero is selected or leveled in the game.
- Because the personal library can be opened outside any campaign, let the person change its display language directly and remember that preference if persistence is available. Make the active language visible on the opening screen.

Validation: English Discord client in a Chinese game and Chinese client in an English game; hub and slash entry; all builder steps and modal submission; a mid-flow locale change; saved/imported character displayed in both languages; no change to stored build IDs or player text.
