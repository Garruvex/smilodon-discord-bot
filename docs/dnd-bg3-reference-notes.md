# BG3 reference notes

Research date: 2026-09-26. Companion to [the DM bot plan](dnd-dm-bot-plan.md), §4 and §7.

## Evidence policy

- **Official verified:** an original Traditional Chinese game string matched to its English concept, with game build and localization handle or readable tooltip evidence. No glossary row currently meets this standard in this research pass.
- **Guide:** a published guide uses the term. It may paraphrase, convert Simplified Chinese, or use a fan translation; this does not establish official wording.
- **Unverified:** leave the BG3 value unresolved. Keep an authored project label so glossary work does not block the harness.

Prefer verified BG3 terminology unless it misrepresents the SRD 5.1 mechanic. Store exceptions, such as the chosen 倒地 label, as explicit product decisions. A BG3 term does not authorize importing its mechanics or full translated descriptions.

## Published terminology evidence

The identifiers below are used in the main glossary. They identify secondary evidence, not official localization certification.

| ID | Source | Wording observed |
| --- | --- | --- |
| B1 | [Komica community BG3 entry](https://newkomica-kari.fandom.com/zh-tw/wiki/柏德之門3) | Fighter 戰士; Rogue 遊蕩者. |
| B2 | [League Funny combat guide](https://www.league-funny.com/gaming/article-276309) | 聖武士, 邪術師, 熟練項加值. |
| B3 | [PinoGamer Barbarian guide](https://pinogamer.com/16487) | 失能, 附贈動作, 倒伏. This supports comparison candidates only; it does not confirm the game's exact condition labels. |
| B4 | [Elker: combat interface guide](https://vocus.cc/article/64dcd7c8fd8978000185e01c) | 法術位 and 戲法 in prose; the article also uses 法術環位, demonstrating that guide wording is not a string database. |
| B5 | [KiroKiro Bard guide](https://kirokiro.cc/games/108796) | 萬事通 as a Bard feature. Official English/Traditional Chinese string pairing remains to be checked. |

Do not merge Rogue's class label with the Thief subclass label. Do not map Cure Wounds to Healing Word based on a similar translated name. For Grappled and Hit Dice, first determine whether BG3 has a matching exposed concept at all; an absent equivalent is acceptable.

## How to finish official verification

Steam records BG3 in an `X:\SteamLibrary` library on this machine, but that drive was unavailable during this research pass. Installed-game tooltips and original localization files could not be inspected. Public translation-fix repositories found during research describe extraction but do not supply the original Traditional Chinese strings needed here.

When original files are accessible:

1. Record the game build and use the original `English` and `ChineseTraditional` localization resources, excluding translation mods.
2. Match localized strings by localization handle, then check the referenced class, condition, resource, or spell. Matching text alone is insufficient when several strings use similar names.
3. Alternatively, inspect readable English and Traditional Chinese tooltips for the same concept and record build, locale, and screenshot reference. A third-party screenshot needs enough context to distinguish original localization from mods.
4. Record each entry's stable bot ID, English name, official BG3 term, evidence status, source/handle, build, date, chosen project label, and reason for any exception.
5. Update only entries with evidence. Mark concepts with no BG3 equivalent as such after checking; retain the project's SRD-based translation.

[Larian's localization documentation](https://docs.baldursgate3.game/index.php?title=Adding_Localisation) describes the localization system. The [BG3 Traditional Chinese fixing tool](https://github.com/LukeHong/BG3_zh-tw_fixing_tool) describes matching original localization files and generating fan corrections; its corrected output must not be treated as original official wording.

## Mechanics evidence is separate

The [potions](https://bg3.wiki/wiki/Potions), [Shove](https://bg3.wiki/wiki/Shove), and [high-ground](https://bg3.wiki/wiki/High_ground_rules) pages are community mechanics references. They support the candidate options in §4, with in-game verification still required before shipping the preset.

High ground is a flat attack-roll modifier, not advantage. A cost-only SRD shove option is an adaptation, not a complete reproduction of BG3 shove. Keep any range, elevation, or shove simplifications visible in the preset description.
