# D&D Discord Activity UI and session flow

Status: design draft, 2026-10-01. Companion to [the parity and scene-flow plan](dnd-parity-and-scene-flow-plan.md), [the campaign panel spec](dnd-panel-spec.md), and [the campaign code structure](dnd-code-structure.md). This describes the proposed Activity experience; it is not implemented behavior.

## Product decision

The Activity is the live table surface for a campaign session. It shows the current scene and current state, and is where a player takes their turn. Discord remains the conversation and durable event log: narration, roll outcomes, scene art, and campaign history are still posted to the campaign's Adventure channel. The bot and campaign engine remain authoritative; the Activity is a client of the existing command bus.

The Activity must work when opened beside Discord chat, at narrow widths, and on mobile. It must not require the entire party to use it: Discord controls remain a usable fallback and submit to the same engine.

## Entry and campaign selection

### Recommended launch path

1. A member starts **D&D Table** from the campaign's Party or Adventure channel, or from the voice call used by the group.
2. Discord opens the Activity in that channel/call. The client authenticates the current user and asks the backend for campaigns that user may access in the launch context.
3. If exactly one eligible live campaign matches the guild and channel, open it directly. If more than one matches, show the campaign picker. If none match, show a clear empty state with **Open campaign hub** and **Try another channel** actions.
4. The first member who opens a campaign establishes the live table session for that Activity instance. Other members opening/joining the same Activity instance are placed into that same campaign. They do not independently create or select a different session.
5. A member who belongs to more than one campaign can use **Switch campaign** from the Activity header. Switching is allowed only to a campaign eligible in the same server and launch context; confirm before leaving a live view with an unsent form.

### Picker behavior

Use a compact card per eligible campaign:

```text
Choose a campaign

MOONLIT RUINS                 LIVE · EXPLORATION
Old Watchtower · Round 4      4 heroes · 3 here
[Join table]

SUNKEN TEMPLE                 PAUSED
Flooded Antechamber           Organizer paused
[View table]
```

Sort live and waiting campaigns first, then paused, then archived. Archived campaigns are available only through a separate **Past campaigns** view and are read-only. Show the current scene only if it is player-visible. Never reveal private DM notes, hidden scenes, or spoilers in picker cards.

If launch context is a server but not a campaign channel, list eligible campaigns in that server and ask the user to select one. If launch context is a DM or otherwise lacks a server, explain that this Activity needs to be launched from a campaign server channel. Do not ask users to paste campaign IDs.

### Shared session identity

The server resolves the campaign from authenticated Discord context and membership. Client-supplied campaign IDs are selectors only and are re-authorized on every read and write. The server associates clients with the same live table using the validated campaign plus Discord Activity instance context. If that context is missing or cannot be verified, require an explicit server-authorized campaign choice and do not infer access from a client-provided guild/channel ID.

Do not block joining just because the user has not selected a character yet. Let them enter as a read-only viewer, then show **Choose your hero** if they are a campaign member with an unassigned hero. Spectators can see only the campaign's public projection and cannot submit game actions.

## Live table layout

### Header and control ownership

The header identifies the table, with **team name** as the main title and **adventure name** in a smaller subtitle underneath. The scene/location belongs in the scene panel. Phase and round are separate compact elements beside the title block; never stitch them into a sentence using middle dots or bullets.

Example: **The Lantern Company**, subtitle **Moonlit Ruins**, then a sword/Combat state and Round 4. If team name is unset, use the existing campaign name as the title. Do not duplicate the same title as its own subtitle. `CampaignRecord.name` currently names the campaign; a distinct editable team name requires an explicit optional backend field, while adventure title already exists in the lobby projection and needs to reach the Activity view.

The upper right has a small, directly available **Safety** control and one overflow menu. Remove the duplicate **My Hero details** button: Details is available on the hero panel and selecting the own party tile also opens it. Safety remains accessible regardless of turn or open detail screen. The overflow menu contains only global navigation/settings: choose table, journal/history, appearance, and organizer options when authorized. Hero actions, spell management, and inventory stay inside the hero workspace. Hide unavailable menu entries rather than filling the header with inactive buttons.

Use a muted red header accent and a sword/Combat label while combat is active. This is distinct from a gold border/pointer plus **Current turn** on the active party tile, **Your turn** above the own-hero controls, and a short **Up next** indicator. During another hero's turn, the own-hero panel remains browseable and says whose turn it is. Urgent danger/reactions and low HP have their own local notices; do not flood the whole interface with bright red.

### Desktop / wide Activity

```text
┌────────────────────────────────────────────────────────────────────┐
│ The Lantern Company [Exploration] [Round 4]   [Safety icon] [⋯]   │
│ Moonlit Ruins                                                       │
├────────────────────────────────────────────────────────────────────┤
│ YOUR HERO — MIRA                          │ OLD WATCHTOWER          │
│ [Portrait]  HP 18/24    AC 16              │                         │
│ Bless: concentrating                     │       SCENE ART         │
│ L1 slots 2/4   L2 slots 1/2               │                         │
│ [Action icon] [Spell icon] [Feature icon] │ Encounter context       │
│ Pinned choices → target → preview        │                         │
├───────────────────────────────────────────┴────────────────────────┤
│ [Mira tile]           [Borin tile]           [Elin tile]            │
│ [Nox tile]            [Thorn tile]           [Vale tile]            │
├────────────────────────────────────────────────────────────────────┤
│ Latest public result                  [Open Discord history ↗]     │
└────────────────────────────────────────────────────────────────────┘
```

Scene art is the visual anchor, not a frequently re-rendered background. Reuse the campaign's stored scene asset; retain a stable fallback illustration or textured color when none exists. Show a short public scene description and a compact recent-event strip. Keep long narration, full roll math, and history in Discord, with an **Open Discord history** link/button.

The preferred layout puts **Your Hero** in the main workspace, with the scene as a smaller adjacent context panel and six party tiles immediately below. Your hero takes the larger share of usable width and is the first interactive content on mobile. Keep the portrait, vitals, and current task together; avoid a narrow sidebar that requires opening menus for every cast. Pending checks, reactions, clarification, and scene agreements take priority over the normal action chooser.

### Narrow / mobile layout

Stack in this order: compact campaign header; own-hero summary and current task; six party tiles; collapsible scene context. Expanding spells or a character detail screen reduces the art to a scene-title header so controls have space. Use one primary action button and put secondary actions under **More**. Menus and confirmations use full-width sheets. Safety stays directly accessible. Never require hover, drag, or a wide map to submit a normal action.

### Visual hierarchy

- Scene art and title establish where the party is.
- The current phase and next required action are always explicit in text.
- One primary action is visually strongest; secondary actions are grouped nearby.
- Roster presence/readiness uses text and icons, not color alone.
- Party members show exact HP under the existing public hero policy; enemies show only public health bands. Private notes and owner-only controls stay in the player's view.
- Respect the campaign's `en` or `zh-TW` language and the existing campaign panel terminology.

## Player flows

### Exploration action

Exploration has a dedicated screen state. The own-hero workspace stays prominent, but its task is **What do you do?**, not **Your turn**: in collecting mode several active heroes can submit concurrently. The header uses a quiet exploration accent and a separate round label. Hide combat initiative, enemy HP, turn budgets, and End Turn. Keep own HP/conditions and accessible spell/resource inspection because those still matter outside combat.

The adjacent scene panel shows location art, a short revealed description, and inspectable visible subjects: NPCs, doors, clues, and objects only when the backend supplies them. Suggestions are player choices, not guaranteed outcomes or unrestricted commands. A card such as **Inspect the bell rope** opens an intent preview, then submits through Act. Custom Action accepts free text; Speak is a separate dialogue flow and does not fill the round submission.

Party tiles show **Thinking**, **Submitted**, **Passed**, or **Away** using icons/short accessible labels. Show one aggregate status such as **2 of 5 actions submitted**; do not call it readiness if it is counting gameplay submissions. A server deadline may be displayed locally as a countdown, with server-authoritative expiration. No timer means no ticking placeholder.

After submission, replace the chooser with the saved intent and permitted **Edit / Withdraw** actions until close. A pending roll or clarification takes priority. During resolution, say **The DM is resolving the round**, retain read-only browsing/Safety, and disable late submissions. Do not repeatedly call the model just because clients are connected. Round reopening comes from committed engine state.

Travel appears as a compact **Where next?** section containing only revealed reachable destinations from the server. Selecting a destination previews a proposed party move; it does not immediately change the scene. The pending-move state displays whichever agreement/objection policy the engine actually supports. Rest likewise uses the existing supported command and timing checks, not an unvalidated rest button.

The visual prototype may use example subjects/destinations to explore layout; a future backend projection is required for structured scene subjects/suggestions beyond the existing `PanelView`. Keep suggestions and spell inspection separate from current-turn `TurnView`, which can be null outside combat.

1. Player selects **Act**; show their hero and the legal action choices returned by the application view.
2. Suggestions open a preview. **Custom action** opens a text field. Nothing is committed by selecting a suggestion.
3. Preview shows the intent, likely check/cost if known, and **Submit action** / **Back**.
4. After submit, show the saved status and attributed intent. If the engine needs a check or clarification, show that next step; do not locally decide outcomes.
5. Revision push refreshes the state. If the client missed pushes, it refetches the latest revision on reconnect/resume.

### Speak

**Speak** opens a short dialogue composer. It posts the character-voiced line to Discord using the existing delivery path, but does not consume the round action. Clearly distinguish Speak from **Act** for consequential actions.

### Combat turn

Show initiative order, active hero, current actor, visible enemies with zone and health band, and the active player's remaining budget. **Act** opens legal actions and targets, then a server-generated preview, then **Roll**. Roll presentation in the Activity may stage the already-saved result, but the saved result and Discord roll/history line are canonical. Reactions appear only to eligible responders. **End turn** is explicit and server-validated.

Revealed enemies use compact portrait/name tiles beside the scene with a broad health-band indicator, public conditions, and an active-turn marker. Display **Unhurt / Hurt / Bloodied / Down** alongside the indicator; do not draw a precise percentage from hidden HP. Selecting an attack/spell highlights legal targets using these same tiles. Exact enemy HP requires an explicit supported table policy and an authorized server projection; it is not a client visibility toggle.

### Pending scene move

Show destination, proposer, reason, and party agreement state. Eligible members can **Agree** or **Stay / object** according to the engine's chosen rule. Forced moves are clearly labeled and announced before the scene changes. On commit, update art/title once and retain the departure/arrival summary in Discord history.

### Private character views

**Details** on the own-hero panel opens the full character workspace described below. Selecting another party portrait opens that hero's public inspect view. Private data is fetched per user and never sent over a shared broadcast. Re-check membership, proxy access, and permissions when submitting, not only when opening the view.

## Party portraits and information hierarchy

The table needs enough character information to coordinate healing, turns, and support without opening every sheet. It also needs an uncluttered scene. Use three levels of detail:

| Surface | Visible information | Interaction |
| --- | --- | --- |
| Party tiles | Hero portrait/initials, hero name with **You** on self, exact HP and max HP, separate temporary HP when present, current turn marker, round submission/away status, one important public condition | Select a hero to inspect owner identity, class/level and secondary details; selecting another hero never changes which character you control |
| Your Hero panel | Own portrait/name, HP/temporary HP, AC, speed/zone where useful, conditions, concentration, action budget during combat, ordinary and Pact slot counts, class resource counts, a few pinned actions/spells | Browse or preview actions; open Details; handle pending rolls/reactions |
| Character detail screen | Full sheet, spellbook, features/resources, inventory/equipment, notes, advancement and available management operations | Authorized server actions, with previews where required |

Use the hero portrait as the primary icon, with initials when unavailable. Owner display name is secondary identity; a second full-size Discord avatar adds noise. Label class icons with text. Portrait assets are cached and do not regenerate when HP changes.

HP is a bar plus `current / maximum`; temporary HP is a separate `+N temporary` badge rather than added to current HP. At zero HP, show **Down**, **Stable**, or death-save successes/failures only when the server provides that public state. Fallen/dead heroes receive a distinct text state. Show a turn pointer and **Your turn** label instead of relying on a glowing border.

Round submission, game availability (**Away**), and Activity connection presence (**Viewing table**) are separate facts. Closing the Activity must not mark a hero away or trigger autopilot. A Discord-only player can still be **Submitted** even though they are not viewing the Activity.

The baseline is **six equally sized hero tiles**, with explicit column counts at breakpoints: three columns/two rows at normal desktop width, two columns/three rows when narrow, and one column only when two cards cannot remain legible. Do not use auto-fit expansion that makes a small party's cards oversized or makes six cards arbitrarily narrow. Additional heroes continue into rows; six is a design minimum, not a hard membership limit.

Preferred tile: a cropped portrait on the left; name and numeric HP on the right; a thin health bar and one important condition/turn marker below. Keep owner, level, AC, secondary conditions, and resource lists in inspection. The own-hero tile says **You**, and the current actor gets a clear turn indicator. Tile selection inspects; it never changes the controlled hero.

Party tile identity has three layers: the hero's chosen portrait, a quiet class emblem, and the hero's name/health. The preferred tile uses a cropped portrait on the left and an oversized low-contrast class emblem toward the opposite edge. The emblem gives the party a game-like identity without adding a repeated class label. It must never compete with the face or numeric HP. Use one shared tile surface and palette, not six unrelated class colors.

Alternative tile: use the class emblem as the main faded backdrop while keeping a small distinct portrait. A portrait crop may tint the background, but a blurred face must not be the only way to recognize a hero. Reserve stable empty space behind text; avoid heavy blur on each state refresh. Race/ancestry belongs in Details by default: it is less useful for moment-to-moment decisions than class, and should not force a generic racial appearance over the player's chosen portrait. Multiclass heroes use a selected primary emblem rather than stacking several symbols; class/level details remain inspectable.

Default tile contents: portrait, name, a smaller race/class-level subtitle (for example **Wood Elf Cleric 3**, without separators), HP bar with numerical HP, and at most one urgent icon/status. Hide routine **Waiting**, owner name, full condition lists, and resource counters until inspection. Show **Away**, downed state, and the active-turn marker when they matter. The own-hero tile can show **You**. Clicking a tile reveals detail in the existing workspace rather than expanding all six cards.

Smoothness comes from stable component placement and progressive disclosure. Keep six tile sizes stable through HP updates, preserve scroll/focus and selected spell through revision refetches, and preserve art while new art loads. Use short 120–180 ms interaction transitions and a modest health-bar transition after a committed update. Do not animate inferred damage, loop turn indicators, or replay old roll animations on reconnect. Honor reduced-motion settings and show urgent reactions immediately. The primary task area starts with a few pinned choices; full search, descriptions, and filters belong in the spellbook view.

## Compact controls, icons, and reusable UI

Avoid metadata sentences stitched together with middle dots. Put campaign name, phase badge, and round counter in separate layout elements. Keep development preview labels outside the product header. Use spacing and hierarchy instead of repeated separators.

Use the existing Game-icons glyphs for action, spell, move, shield, heal, potion, and roll. Category controls may be compact icon buttons with localized accessible names, focus/hover tooltips, selected state, and a touch-visible name on selection. Keep spell names, target identities, critical confirmations, and ambiguous conditions in text. A category glyph such as a magic swirl does not uniquely identify a spell. Frequent pinned spells can become icon tiles with short names; reveal costs/descriptions in the selected preview rather than repeating them on every row.

Default task area shows a compact action/category dock and a short pinned list. Search and filters appear inside the spell browser. Inventory appears only in Details; **Use item** takes the player there. Keep HP and resource numerals visible; icons replace repeated labels, not the information needed to make decisions.

Recommended web foundation: React with a lightweight build setup, selected shadcn/ui components and Radix primitives for dialogs, tabs, popovers, tooltips, focus management, and keyboard interaction. Apply the campaign's own styling rather than importing a generic dashboard layout. shadcn/ui is editable component source under MIT; Radix offers unstyled accessible primitives. A 2D game engine is not needed for this UI and should be evaluated separately if a movable tactical map becomes a requirement. See [shadcn introduction](https://ui.shadcn.com/docs), [MIT license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md), and [Radix accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility).

Asset policy: the project's existing `assets/campaign/icons/CREDITS.md` records Game-icons artists and modifications; maintain a reachable Credits screen and carry those notices with bundled assets. [Game-icons](https://game-icons.net/about.html) permits use with artist attribution under CC BY 3.0. [D&D SRD 5.1](https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf) licenses the material contained in that document under CC BY 4.0; it does not grant a general license for official book art, D&D Beyond portraits, or branding. Reuse the project's own portraits/art and select separately licensed image packs. [Kenney asset packs](https://kenney.nl/support) are a CC0 option for generic game UI/assets, subject to each pack's included license. Evaluate a pack's visual fit before adding it; CC0 availability alone is not a reason to include extra decoration.

## Your Hero panel and action workspace

### Visual reference review: D&D and FF7

Reviewed 2026-10-01. The earlier previews explored layout using basic controls; they were not a finished fantasy game skin. The asset/license review and visual reference review are separate work.

| Reference / proposed direction | What we want to borrow | Adaptation for our Activity |
| --- | --- | --- |
| D&D Beyond character customization | Distinct hero portrait, portrait frame, background/theme customization; see [official customization guide](https://www.dndbeyond.com/posts/1003-how-to-customize-your-character-sheet-on-d-d) | Use original/licensed portrait art and a quiet class emblem; full sheet remains Details |
| D&D Beyond Maps | Campaign context and character-linked tokens/sheets; see [official Maps guide](https://www.dndbeyond.com/posts/1570-d-d-beyond-maps-how-to-start-playing-today) | Keep shared scene and own-hero actions close together; a tactical map is a separate feature |
| FF7-inspired command interface | Proposed design borrowing compact party vitals, clear selected command, and progressive command-to-target selection; reference [publisher's FF7 page](https://store.steampowered.com/app/3837340/FINAL_FANTASY_VII/) | Keep D&D's slots, actions, conditions, and dice semantics; no fabricated MP/ATB/limit gauges |
| Fantasy tabletop skin | Warm charcoal/parchment surfaces, restrained metal-like borders, subtle class symbolism, portrait-led identity | Suggested visual default, paired with the compact command flow |
| JRPG command-menu skin | Cool translucent-looking panels, tighter frames, stronger selection pointer, compact command rows | Alternative for comparison; recreate the visual treatment with original CSS/assets |

Recommended direction: **fantasy tabletop appearance with a compact command flow**. The main workspace shows the own hero, vitals, and a short icon-led choice list. Choosing a command replaces that list with relevant choices; selecting a spell opens targets and cost preview. Use a breadcrumb/back control so the UI never requires action categories, a full spell list, target list, and confirmation to be permanently expanded together. The six-party tiles persist across those steps.

Keep serif styling for short hero/scene titles only, and readable sans-serif typography for controls and numbers. Frames should be sparse and light enough to work beside Discord at narrow width. Avoid heavy parchment textures behind small text, elaborate corners on every button, and decorative resource meters unrelated to engine state.

Reusable asset candidates: [Kenney Fantasy UI Borders](https://kenney.nl/assets/fantasy-ui-borders) and [UI Pack Adventure](https://kenney.nl/assets/ui-pack-adventure), alongside the already bundled Game-icons. These are candidates to inspect for visual fit, not newly installed dependencies. Use their included licenses and preserve the source manifest. Official D&D customization assets and FF7 art/UI files are visual references, not automatically reusable assets; neither the SRD license nor a publisher screenshot supplies blanket permission to redistribute them.

Keep the own-hero summary visible while browsing **Actions**, **Spells**, and **Features**. The full inventory is accessible only in Details; **Use item** opens the Inventory tab with currently usable items emphasized. Equipped weapon attacks may appear as actions, but there is no pack/loot/gold list on the table.

During combat show action, bonus action, movement, and reaction as labeled budgets from the engine. During exploration show the current submission and **Act / Edit**, **Speak**, **Pass** instead. A player's panel remains inspectable outside their turn, with **Borin's turn — browse your options** and an explicit reason casting/submission is unavailable. A pending reaction overrides the normal task area with the trigger, deadline, legal options, and Decline.

Limited resources display name and remaining/maximum uses. Slots and resources are read-only counters; spending, recovery, rest, and correction are engine commands. A numeric counter is not a manual edit field. If a projection cannot supply live remaining state, show **Unavailable** rather than assuming a full resource pool.

### Spell browsing and casting

Use one row per spell, not a separate row for every upcast level. The row shows localized name, spell level/cantrip, action cost, concentration marker, supported range/target summary, and whether it can be used now. Expand a row to see its actual rules description and supported mechanics. Do not present unsupported spell catalog entries as executable.

The spell browser offers search by localized name, level filters, **Usable now**, and **Pinned**. Pinned spells/actions are personal shortcuts; pinning does not prepare, learn, spend, or grant a spell. Store these preferences separately from campaign mechanics and never infer legality from them.

Casting sequence:

1. Select a spell. The server supplies legal choices and their unavailable reasons.
2. Select a legal slot level in the preview. Cantrips and innate casts are explicitly marked **No slot**. Show ordinary slots and Pact Magic separately with their own remaining counts and rest recovery labels. If the engine chooses the resource pool automatically, describe its choice instead of offering a client-controlled pool selector.
3. Choose legal targets or destination. Target tiles use party portraits/name and HP for allies, and public name/health band/zone for foes. A self-only spell preselects self; area/multi-target spells respect the server's target limit.
4. Preview spell, slot/resource cost, target, action cost, and applicable concentration replacement consequence. If the backend cannot yet supply a consequence, add it to the contract before presenting that preview as complete.
5. Explicit **Cast / Roll** submits once. Selecting a spell, changing a slot, inspecting a target, or pinning never spends resources. Keep the draft on a stale rejection and ask for a fresh review after refetch.

Concentration appears in the persistent own-hero summary with the active spell/effect name when provided. Starting another concentration effect shows a replacement notice before submission. Ending concentration is shown only when an authorized backend command exists. Do not build a local toggle that merely changes the displayed state.

### Spellbook management boundary

The current `spellbookOf()` grants sheet spells plus eligible implemented class-list spells, with no separate known/prepared cap. The Activity should call this list **Available spells**, not imply that a prepared-spell editor exists. UI labels such as `HeroView.prepared` alone are not evidence of a preparation mechanic.

For the first version, spell management means browsing the available list, viewing descriptions, pinning favorites, choosing targets/upcast levels, and tracking remaining slots/concentration. Actual learning, preparing, replacing spells, or wizard spellbook additions need separate domain commands, class-specific constraints, persisted choices, rest/advancement timing, and server validation. Show those editing controls only when the backend explicitly advertises support; do not change the rules as a side effect of designing the Activity.

## Character detail screen

Open an in-Activity detail workspace with **Back to table**, the character identity, and tabs. Keep a compact current-turn/pending-reaction notice visible; inspection does not hide an urgent response. Opening a detail view never pauses the game.

| Tab | Contents |
| --- | --- |
| Overview | Portrait, race/class levels, HP/temporary HP, AC, speed, abilities/modifiers, skill/save bonuses, current conditions and concentration |
| Spells | Full available list, descriptions, slot pools, pinned spells; prepare/learn controls only after domain support |
| Features | Passive traits and limited resources with remaining uses; legal activations route through the same action preview |
| Inventory | Worn gear, weapons, pack counts, personal gold, and authorized party stash/purse view; equip/use/offer operations only if provided by the backend |
| Notes | Public character description separately from owner-private notes/journal, with explicit audience labels |
| Progress | XP/level, pending advancement choices, library save/proxy management only when authorized and supported |

Keep inventory in this workspace, including loot details. Choosing **Use item** from a turn may enter this tab, but it still requires an action preview and server validation. Viewing another party member shows their public sheet and only tabs/fields allowed by policy; it does not expose private notes, preferences, or owner-only management controls. Authorized proxy control requires a clearly labeled **Acting for Borin** mode, rechecked on submission.

## Backend view contracts for the richer UI

Existing `HeroView` supplies most vitals, conditions, inventory, spell slots/Pact slots, and feature counters. `PanelView` supplies round/roster/combat state. `TurnView` supplies legal spell variants/targets and action budgets, but can be null outside an actionable turn. Keep browseable character/spell data separate from current-turn legality so a player can read their sheet while waiting.

Before wiring the live UI, add explicit projections for portrait asset references, owner display labels, public condition details, concentration and durations where known, display spell descriptions, unavailable reasons, and supported management operations. Do not render raw resource maxima as remaining uses. Restrict enemy projections to public health bands at the server boundary even if an internal targeting view contains numeric HP.

The Activity frontend can be designed now against fixtures for exploration, own turn, another hero's turn, reaction, downed hero, exhausted slots, pending move, pause, and disconnected state. Each fixture must be labeled as design data in the development preview; the production UI consumes authenticated projections only.

## Synchronization and Discord traffic

- Activity reads are snapshots tagged with campaign revision. Push carries only campaign identity and revision; each client fetches its own public/private view.
- Never broadcast a hidden roll, private journal entry, secret note, or another player's private sheet.
- Every Activity action is submitted with a command ID and routed to the existing controller/command bus. The server derives user identity from the verified session, validates campaign membership, and preserves idempotency.
- While at least one Activity client is active for a campaign, the Discord live panel enters **Activity active** mode and stops routine refresh edits. It retains functional fallback buttons, but does not keep repainting after Activity revisions. A fallback action posts/edits only what the existing Discord control requires; Activity clients receive the new revision.
- On Activity disconnect, keep the panel quiet during a short reconnect grace period. After the final client is absent past that grace period, render the latest state once and resume normal panel refreshes. Activity reopen always fetches a full current snapshot.
- Durable narration, result lines, safety notifications, and required history stay in Discord. Do not mirror each live Activity refresh as a Discord message.
- Count edits, sends, and 429s separately during the prototype. Success means a measurable reduction in live-panel edits per round without losing required history or fallback usability.

## Empty, error, and recovery states

| Situation | Activity response |
| --- | --- |
| No eligible campaign | Explain launch context; offer campaign hub / try another channel |
| Campaign paused | Show pause reason if public; show read-only state and who can resume |
| User is not a member | Show public spectator view if allowed; otherwise deny with a join/request-access path |
| No hero assigned | Read-only view plus **Choose your hero** |
| Stale action/revision | Preserve draft, refresh state, explain what changed, ask the player to review again |
| Network lost | Keep last snapshot visibly marked stale; disable writes; retry and refetch on reconnect |
| Discord delivery delayed | Show committed state with a delivery-pending indicator; never resubmit the action to retry a Discord post |
| Archived campaign | Read-only scene, roster, and public history links |

Errors should say whether the action was saved. A timeout after submission must query command status or retry the same idempotency key; it must never issue a fresh command ID blindly.

## Prototype scope and acceptance

Build in this order:

1. Launch context, authenticated campaign discovery, direct entry for one match, and picker for multiple matches.
2. Read-only live table with scene art, party portraits/HP/status, own-hero vitals/resources, character detail tabs, revision reconnect, and Discord-history link.
3. One exploration action end to end through the existing command bus, including duplicate submission and stale revision behavior.
4. Discord panel quiet/resume behavior and counters for edits, sends, and 429s.
5. Combat turn with spell search/pinning/slot selection/target previews, scene agreement, Speak, and authorized inventory operations after the narrow path is proven. Preparation/learning rules remain a separate backend feature.

Acceptance for the first prototype: two members launch/join one table from the same campaign context; both see the same public revision; each sees only their own private view; one can submit a valid action and the other sees the committed update without a routine Discord panel edit; a Discord-only member can still use the fallback; reconnect recovers the current state without duplicate actions.

## Open product decisions

1. Whether starting the Activity from an Adventure channel auto-starts the shared table session or only joins an already-running session. Proposed: first eligible member opens it; subsequent members join the same instance.
2. How long the no-client reconnect grace period should be. Proposed: short and configurable; choose from pilot observations.
3. Whether a spectator sees the scene art and public roster when the campaign is open-table. Proposed: yes, but no private sheets, journal, or action controls.
4. Whether staged dice animation is worth building in the Activity. Proposed: preserve the existing saved-result timing and prioritize responsive controls first.
