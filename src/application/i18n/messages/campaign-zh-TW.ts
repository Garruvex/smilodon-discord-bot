import type { TranslationCatalog } from "./en.js";

// Traditional Chinese (Taiwan) for the D&D campaign UI. DRAFT — pending
// review by a native speaker. Terms follow the campaign glossary.
export const campaignZhTW = {
  "campaign.pacing.live": "即時",
  "campaign.pacing.playByPost": "論壇式",
  "campaign.pacing.custom": "自訂",
  "campaign.language.en": "English",
  "campaign.language.zhTW": "繁體中文",

  "campaign.lobby.title": "{name} — 大廳",
  "campaign.lobby.subtitle": "{count} / {max} 位玩家 · {pacing} · {language}",
  "campaign.lobby.adventure": "冒險：{title}",
  "campaign.lobby.organizer": "主辦人：{user}",
  "campaign.lobby.memberReady": "{user} — {hero}，{class} — 已就緒",
  "campaign.lobby.memberCreating": "{user} — 正在選擇英雄",
  "campaign.lobby.empty": "還沒有人加入",
  "campaign.lobby.waitingPlayers": "至少需要 {min} 位玩家",
  "campaign.lobby.waitingReady": "等待所有人選好英雄",
  "campaign.lobby.readyToStart": "已就緒，主辦人可以開始冒險",
  "campaign.lobby.started": "冒險已經開始",
  "campaign.lobby.cancelled": "這個團務已取消",

  "campaign.button.join": "加入",
  "campaign.button.chooseHero": "我的英雄",
  "campaign.button.leave": "離開",
  "campaign.button.start": "開始冒險",

  "campaign.pick.prompt": "選擇你的英雄",
  "campaign.pick.option": "{hero} — {class}",
  "campaign.pick.none": "所有英雄都被選走了",

  "campaign.reply.joined": "你已加入 **{name}**，請在下方選擇英雄",
  "campaign.reply.left": "你已離開大廳",
  "campaign.reply.heroChosen": "你將扮演 **{hero}**",
  "campaign.reply.started": "冒險已經開始",
  "campaign.reply.cancelled": "團務已取消",

  "campaign.refusal.closed": "這個大廳已關閉",
  "campaign.refusal.full": "座位已滿",
  "campaign.refusal.notMember": "你還沒加入這個大廳，請先加入",
  "campaign.refusal.unknownHero": "這場冒險沒有那位英雄",
  "campaign.refusal.heroTaken": "已經有人選了那位英雄",
  "campaign.refusal.notOrganizer": "只有主辦人可以這麼做",
  "campaign.refusal.notEnoughPlayers": "人數還不夠，無法開始冒險",
  "campaign.refusal.notReady": "所有人都要先選好英雄才能開始",
  "campaign.refusal.invalidLimits": "人數上限設定無效",
  "campaign.refusal.notFound": "找不到這個團務",
  "campaign.refusal.notLobby": "這個團務已經不在大廳階段",
  "campaign.refusal.unknownAdventure": "沒有這場冒險",
  "campaign.refusal.languageUnavailable": "這場冒險沒有這個語言的版本",
  "campaign.refusal.invalidName": "團務名稱需要 2 到 60 個字",
  "campaign.refusal.nameTaken": "這個伺服器已有同名的進行中團務",
  "campaign.refusal.invalidPacing": "計時設定無效",
  "campaign.refusal.invalidHouseRules": "自訂規則無效",
} as const satisfies TranslationCatalog;
