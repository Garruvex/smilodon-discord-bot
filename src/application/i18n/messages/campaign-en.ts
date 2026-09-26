// D&D campaign messages (English is the source; other languages fall back to
// it). Kept in their own file so the campaign UI can grow without bloating
// the main catalog; en.ts spreads this in. Button labels stay short (about 12
// characters), and a message with {placeholders} becomes a function.
export const campaignEn = {
  "campaign.pacing.live": "Live",
  "campaign.pacing.playByPost": "Play-by-post",
  "campaign.pacing.custom": "Custom",
  "campaign.language.en": "English",
  "campaign.language.zhTW": "繁體中文",

  "campaign.lobby.title": "{name} — Lobby",
  "campaign.lobby.subtitle": "{count} / {max} players · {pacing} · {language}",
  "campaign.lobby.adventure": "Adventure: {title}",
  "campaign.lobby.organizer": "Organizer: {user}",
  "campaign.lobby.memberReady": "{user} — {hero}, {class} — Ready",
  "campaign.lobby.memberCreating": "{user} — Choosing a hero",
  "campaign.lobby.empty": "Nobody has joined yet.",
  "campaign.lobby.waitingPlayers": "Waiting for at least {min} players.",
  "campaign.lobby.waitingReady": "Waiting for everyone to choose a hero.",
  "campaign.lobby.readyToStart": "Ready. The organizer can start the adventure.",
  "campaign.lobby.started": "The adventure has begun.",
  "campaign.lobby.cancelled": "This campaign was cancelled.",

  "campaign.button.join": "Join",
  "campaign.button.chooseHero": "My Hero",
  "campaign.button.leave": "Leave",
  "campaign.button.start": "Start Adventure",

  "campaign.pick.prompt": "Choose your hero",
  "campaign.pick.option": "{hero} — {class}",
  "campaign.pick.none": "Every hero is taken.",

  "campaign.reply.joined": "You joined **{name}**. Choose your hero below.",
  "campaign.reply.left": "You left the lobby.",
  "campaign.reply.heroChosen": "You will play **{hero}**.",
  "campaign.reply.started": "The adventure has begun.",
  "campaign.reply.cancelled": "The campaign was cancelled.",

  "campaign.refusal.closed": "This lobby is closed.",
  "campaign.refusal.full": "The table is full.",
  "campaign.refusal.notMember": "You are not in this lobby. Join first.",
  "campaign.refusal.unknownHero": "That hero is not in this adventure.",
  "campaign.refusal.heroTaken": "Someone else already chose that hero.",
  "campaign.refusal.notOrganizer": "Only the organizer can do that.",
  "campaign.refusal.notEnoughPlayers": "More players are needed before the adventure can start.",
  "campaign.refusal.notReady": "Everyone must choose a hero before the adventure can start.",
  "campaign.refusal.invalidLimits": "The player limits are not valid.",
  "campaign.refusal.notFound": "That campaign no longer exists.",
  "campaign.refusal.notLobby": "This campaign is no longer in the lobby.",
  "campaign.refusal.unknownAdventure": "That adventure is not available.",
  "campaign.refusal.languageUnavailable": "That adventure is not available in this language.",
  "campaign.refusal.invalidName": "Campaign names must be 2 to 60 characters.",
  "campaign.refusal.nameTaken": "Another unfinished campaign on this server already has that name.",
  "campaign.refusal.invalidPacing": "Those timers are not valid.",
  "campaign.refusal.invalidHouseRules": "Those house rules are not valid.",
} as const satisfies Record<string, string>;
