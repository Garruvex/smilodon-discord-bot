# Implementation alignment ledger

Work follows the [contextual participation plan](chat-contextual-participation-plan-2026-10-21.md) and [flow audit](chat-flow-state-audit-2026-10-21.md). This ledger is checked against source and observable execution, not test totals alone. Production remains unchanged; a deployed pilot requires separate evidence.

| Requirement | State | Evidence / remaining work |
| --- | --- | --- |
| Final action owns text and every reaction | Implemented locally | Service authorizes immutable effect snapshots; all three Discord callbacks consume them. Invalid-evidence regression proves no callback or text delivery. Target binding survives finalization. |
| One resolved effective turn plan | Implemented locally | Central resolver drives execution, reports, context strategy and guarded deadlines. Removed adapter flow/candidate flags. Missing/mismatched guard or invalid contextual prerequisites fail closed before model work. |
| Guarded reactions receive preflight | Implemented locally | Typed reaction link binds the bot target and authorized reactors. Real service/runtime cases cover reply, emoji, abstention, invalid links, revocation, changed source, budgets and shadow. Adapter coverage follows. |
| Source proof distinct from exchange meaning | Implemented locally | Wire revision 4 offers distinct same-speaker exchanges and independent bot-reference links. Unlinked compatibility proposals cannot inherit another speaker's exchange. Model interpretation still requires semantic acceptance. |
| Context projection preserves authorized anchors | Existing, re-audit pending | Verify decision and generator source identity after migration. |
| All modes share lifecycle/deadline/effect invariants | Pending | Retain legitimate explicit-request obligations; remove accidental mode omissions. |
| Remove unwired migration residue | Pending | Refresh hook, unreachable count-first reader branch, obsolete authority fields and no-op settings; move useful assertions before deletion. |
| Actual adapter-to-effect tests | Pending | Current guarded matrix is not proof of both runner routes. Cover configuration, shadow, failure and delivery seams. |
| Current-version replay has meaningful acceptance gates | Pending | Revisioned cross-speaker negatives; semantic/effect gates separate from validity; final provider evidence. |
| Universal memory/summary/image/tool guard | Separate source-migration track | Keep excluded sources closed until their source/subject/audience provenance migration is complete; do not claim full universal-source completion. |
| Final reread of plan and audit | Pending | Map every acceptance item to implementation/evidence or an explicit external gate. |

Checkpoint 1 validation: 209 existing focused tests plus 62 effect/guarded tests after adding regression coverage; typecheck and changed-file lint passed. No Discord sends or production settings changes.

Checkpoint 2 validation: 4,813 passed / 7 skipped; typecheck and changed-file lint passed. `contextual=false` is now explicitly a legacy-decision configuration, not a claim about the runner. Legacy-context and guarded-context variants remain intentional compatibility strategies selected by one plan, not optional port presence.

Checkpoint 3 validation: 4,825 passed / 7 skipped; typecheck and changed-file lint passed. Eight-case experimental wire-4 smoke (`contextual-live-link-smoke-2026-10-21.json`, before final prompt simplification) missed no required same-speaker replies but had one invalid decision and weak other labels. This is not release acceptance. Final fixture/scoring revisions and a full provider run remain required.
