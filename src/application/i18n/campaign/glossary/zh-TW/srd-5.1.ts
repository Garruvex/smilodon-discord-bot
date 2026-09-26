import type { Glossary } from "../../../../../domain/campaign/rules/content-registry.js";

// Terms follow the plan's terminology survey (docs/dnd-dm-bot-plan.md §7):
// the Traditional-script community term by default, with recorded product
// decisions (倒地 for Prone; 失能 for Incapacitated, pending the BG3 check).
// Spell names below are drafts until the glossary survey covers them.
export const zhTwSrd51Glossary: Glossary = {
  language: "zh-TW",
  names: {
    "condition:incapacitated": "失能",
    "condition:prone": "倒地",
    "condition:frightened": "恐懼",
    "condition:poisoned": "中毒",
    "condition:unconscious": "昏迷",
    "spell:sacred-flame": "聖火術",
    "spell:cure-wounds": "治療傷勢",
    "spell:healing-word": "治療真言",
    "spell:bless": "祝福術",
    // Weapon and monster names are drafts until the terminology survey covers them.
    "item:longsword": "長劍",
    "item:shortsword": "短劍",
    "item:scimitar": "彎刀",
    "item:mace": "硬頭錘",
    "item:morningstar": "釘頭錘",
    "item:shortbow": "短弓",
    "item:bite": "啃咬",
    "monster:goblin": "哥布林",
    "monster:wolf": "狼",
    "monster:bugbear": "熊地精",
  },
};
