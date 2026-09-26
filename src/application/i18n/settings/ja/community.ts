import type { SettingsTextCatalog } from "../catalog.js";

export const jaCommunity: SettingsTextCatalog = {
  "community": { title: "コミュニティ", description: "独立したコミュニティ機能。" },

  "community.language": {
    label: "言語",
    description: "このサーバーで翻訳に対応しているボットのメッセージに使う言語を設定します。",
  },
  "community.language.language": { label: "言語", description: "使用する言語。" },

  "community.timezone": {
    label: "タイムゾーン",
    description: "誕生日など、このサーバーの日付に使うIANAタイムゾーンを設定します。",
  },
  "community.timezone.zone": {
    label: "タイムゾーン",
    description: "IANAタイムゾーン名。例：\"America/New_York\"、\"Asia/Taipei\"。",
    messages: { unknown: "「{zone}」は認識できるIANAタイムゾーン名ではありません（例：\"America/New_York\"）。" },
  },

  "community.birthdays": {
    label: "誕生日",
    description: "誕生日の自動告知を設定します。",
    messages: { "needs-channel": "オンにする前に、誕生日を告知するチャンネルを設定してください。" },
  },
  "community.birthdays.enabled": { label: "誕生日の告知", description: "誕生日の告知をオン／オフします。" },
  "community.birthdays.channel": { label: "告知チャンネル", description: "誕生日の告知を投稿するテキストチャンネル。" },

  "community.reminders": { label: "リマインダー", description: "メンバーが個人用リマインダーを設定できるかどうかを設定します。" },
  "community.reminders.enabled": { label: "リマインダー", description: "/remind コマンドをオン／オフします。" },

  "community.welcome": { label: "参加・退出メッセージ", description: "メンバーの参加・退出を告知するチャンネルを設定します。" },
  "community.welcome.join-channel": { label: "ウェルカムチャンネル", description: "新メンバーのウェルカムカードを投稿する場所。空ならオフ。" },
  "community.welcome.leave-channel": { label: "退出チャンネル", description: "メンバー退出のメッセージを投稿する場所。空ならオフ。" },

  "community.link-fix": {
    label: "リンク修正",
    description: "対応プラットフォームのリンクを自動で書き換える設定をします。",
    messages: { "needs-channel": "オンにする前に、監視するチャンネルを1つ以上追加してください。" },
  },
  "community.link-fix.enabled": { label: "リンク修正", description: "リンクの自動書き換えをオン／オフします。" },
  "community.link-fix.channels": { label: "監視チャンネル", description: "書き換え可能なリンクを監視するテキストチャンネル。" },
  "community.link-fix.twitter": { label: "Twitter/X", description: "Twitter/Xのリンク修正をオン／オフします。" },
  "community.link-fix.threads": { label: "Threads", description: "Threadsのリンク修正をオン／オフします。" },
  "community.link-fix.tiktok": { label: "TikTok", description: "TikTokのリンク修正をオン／オフします。" },
  "community.link-fix.instagram": { label: "Instagram", description: "Instagramのリンク修正をオン／オフします。" },
  "community.link-fix.reddit": { label: "Reddit", description: "Redditのリンク修正をオン／オフします。" },
  "community.link-fix.bilibili": { label: "Bilibili", description: "Bilibiliのリンク修正をオン／オフします。" },

  "community.nsfw": { label: "NSFWコマンド", description: "このサーバーでのNSFW画像コマンドをオン／オフします。" },
  "community.nsfw.enabled": {
    label: "NSFWコマンド",
    description: "NSFW画像コマンドを許可します（年齢制限チャンネルでのみ使用可能）。",
  },

  "community.member-data": {
    label: "メンバーデータ",
    description: "メンバーが退出したあと、そのデータを保持するか削除するかを設定します。",
  },
  "community.member-data.retain": {
    label: "退出メンバーのデータを保持",
    description: "true：メンバーが戻ったときのためにデータを保持します。false：退出時に削除します。",
  },
};
