import type { SettingsTextCatalog } from "../catalog.js";

const windows = { "10s": "10秒", "30s": "30秒", "1m": "1分", "5m": "5分" };
const actions = { timeout: "タイムアウト", kick: "キック", ban: "BAN" };
const deleteWindows = { "off": "オフ", "10m": "直近10分", "30m": "直近30分", "1h": "直近1時間" };
const timeouts = { "1h": "1時間", "1d": "1日", "7d": "7日", "28d": "28日" };

export const jaSecurity: SettingsTextCatalog = {
  "security": { title: "セキュリティ", description: "乗っ取られたアカウントやスパムボットを自動で検知します" },

  "security.trap": {
    label: "トラップチャンネル",
    description: "誰も投稿しないはずのチャンネル。投稿したアカウントは自動で処置されます",
    messages: { "needs-channel": "オンにする前にチャンネルを設定してください（create-channel も使えます）" },
  },
  "security.trap.enabled": { label: "トラップチャンネル", description: "トラップチャンネルのオン/オフを切り替えます" },
  "security.trap.channel": { label: "チャンネル", description: "監視するチャンネル。create-channel か use-channel なら案内も投稿されます" },
  "security.trap.action": {
    label: "処置",
    description: "投稿したアカウントへの処置です",
    choices: { timeout: "タイムアウト", kick: "キック", ban: "BAN" },
  },
  "security.trap.delete-history": {
    label: "直近のメッセージを削除",
    description: "投稿者の他のメッセージをどこまで遡って削除するか。オフならチャンネル内の1件のみ",
    choices: { "off": "オフ", "10m": "直近10分", "30m": "直近30分", "1h": "直近1時間" },
  },
  "security.trap.timeout-duration": {
    label: "タイムアウトの長さ",
    description: "処置がタイムアウトのときの長さです",
    choices: { "1h": "1時間", "1d": "1日", "7d": "7日", "28d": "28日" },
  },

  "security.spam": { label: "チャンネル横断スパム", description: "同じメッセージを短時間に複数のチャンネルへ投稿するアカウントを検知します" },
  "security.spam.enabled": { label: "チャンネル横断スパム", description: "スパム検知のオン/オフを切り替えます" },
  "security.spam.channels": { label: "チャンネル数", description: "同じメッセージが何個の別チャンネルに届いたら対象にするか（2-10）" },
  "security.spam.window": { label: "期間", description: "どれくらいの短時間で起きたら対象にするか", choices: windows },
  "security.spam.action": { label: "処置", description: "該当したアカウントへの処置です", choices: actions },
  "security.spam.delete-history": {
    label: "直近のメッセージを削除",
    description: "繰り返されたメッセージのほかに、どこまで遡って削除するか",
    choices: deleteWindows,
  },
  "security.spam.timeout-duration": { label: "タイムアウトの長さ", description: "タイムアウトの長さです", choices: timeouts },

  "security.links": {
    label: "リンク検査",
    description: "ブロック対象のサイト、偽装アドレス、他サーバーの招待を含む投稿を削除します",
  },
  "security.links.enabled": { label: "リンク検査", description: "リンク検査のオン/オフを切り替えます" },
  "security.links.action": {
    label: "処置",
    description: "投稿したアカウントへの処置。「メッセージを削除」は投稿のみ削除します",
    choices: { delete: "メッセージを削除", ...actions },
  },
  "security.links.delete-history": {
    label: "直近のメッセージを削除",
    description: "削除以外の処置のとき、他のメッセージをどこまで遡って削除するか",
    choices: deleteWindows,
  },
  "security.links.timeout-duration": { label: "タイムアウトの長さ", description: "タイムアウトの長さです", choices: timeouts },
  "security.links.blocked-domains": {
    label: "ブロックするサイト",
    description: "常に拒否するサイト。カンマか空白で区切ります。none で空にします",
    messages: {
      "invalid": "「{entry}」はサイト名ではありません。example.com の形式で入力してください",
      "too-many": "サイトが多すぎます。最大 {max} 件です",
    },
  },
  "security.links.allowed-domains": {
    label: "許可するサイト",
    description: "怪しく見えても拒否しないサイト。none で空にします",
    messages: {
      "invalid": "「{entry}」はサイト名ではありません。example.com の形式で入力してください",
      "too-many": "サイトが多すぎます。最大 {max} 件です",
    },
  },
  "security.links.suspicious": {
    label: "怪しいアドレス",
    description: "ブランドを装うアドレス、文字種を混ぜたアドレス、IP直指定のリンクも拒否します",
  },
  "security.links.invites": { label: "他サーバーの招待", description: "他のDiscordサーバーへの招待も拒否します" },

  "security.raid": { label: "レイド対策", description: "多数のアカウントが一斉に参加したことを検知し、対処もできます" },
  "security.raid.enabled": { label: "レイド対策", description: "レイド対策のオン/オフを切り替えます" },
  "security.raid.joins": { label: "参加人数", description: "期間内に何人参加したらレイドとみなすか（3-50）" },
  "security.raid.window": { label: "期間", description: "その期間の長さです", choices: windows },
  "security.raid.action": {
    label: "処置",
    description: "参加者への処置。「通知のみ」は管理者に知らせるだけです",
    choices: { alert: "通知のみ", ...actions },
  },
  "security.raid.account-age-days": {
    label: "作成から何日未満のみ",
    description: "作成から指定日数未満のアカウントだけを処置します。0なら全員（0-30）",
  },
  "security.raid.timeout-duration": { label: "タイムアウトの長さ", description: "タイムアウトの長さです", choices: timeouts },

  "security.create-channel": {
    label: "トラップチャンネルを作成",
    description: "ありふれた名前のチャンネルを作り、すべての言語で案内を投稿します",
    messages: {
      "no-guild": "サーバーがまだ読み込まれていません。少し待ってからもう一度お試しください",
      "missing-permission": "チャンネルを作るには「チャンネルの管理」権限が必要です",
      "failed": "チャンネルを作成できませんでした。権限を確認してからもう一度お試しください",
      "done": "{channel} を作成し、案内を投稿しました。準備ができたらトラップチャンネルをオンにしてください",
    },
  },
  "security.use-channel": {
    label: "既存のチャンネルを使う",
    description: "すでにあるチャンネルを使い、すべての言語で案内を投稿します",
    messages: {
      "missing": "チャンネルを選んでください",
      "not-text": "通常のテキストチャンネルを選んでください",
      "no-access": "{channel} を見て、送信し、メッセージを管理できる権限が必要です",
      "failed": "{channel} に案内を投稿できませんでした",
      "done": "{channel} を使うことにし、案内を投稿しました。準備ができたらトラップチャンネルをオンにしてください",
    },
  },
  "security.use-channel.channel": { label: "チャンネル", description: "トラップとして使うテキストチャンネル" },

  "security.exempt": {
    label: "除外ロール",
    description: "処置しないロール。オーナー、ボット管理者、スタッフは常に除外されます",
  },
  "security.exempt.roles": { label: "除外ロール", description: "対象外にするロール" },

  "security.log": { label: "セキュリティログ", description: "処置の報告先。未設定なら監査ログのチャンネルを使います" },
  "security.log.channel": { label: "ログチャンネル", description: "セキュリティ報告を送るテキストチャンネル" },

  "security.status": {
    description: "トラップチャンネルが機能する状態か確認します",
    messages: {
      "heading": "**セキュリティの状態**",
      "no-guild": "サーバーがまだ読み込まれていません。少し待ってからもう一度お試しください",
      "on": "✅ トラップチャンネルはオンです",
      "off": "ℹ️ トラップチャンネルはオフです",
      "no-channel": "⚠️ チャンネルが設定されていません",
      "channel-missing": "⚠️ トラップチャンネルが存在しません。設定し直してください",
      "channel": "✅ {channel} を監視しています",
      "everyone-cannot-post": "⚠️ メンバーが {channel} に投稿できないため何も検知できません。全員が見て送信できるようにしてください",
      "bot-no-access": "⚠️ {channel} を見たりメッセージを管理したりできません",
      "missing-permission": "⚠️「{action}」に必要な {permission} 権限がありません",
      "missing-sweep-permission": "⚠️「メッセージの管理」権限がないため、投稿者の他のメッセージを削除できません",
      "spam-missing-delete": "⚠️「メッセージの管理」権限がないため、スパム投稿を削除できません",
      "links-missing-delete": "⚠️「メッセージの管理」権限がないため、拒否対象のリンクを含む投稿を削除できません",
      "no-log": "ℹ️ ログチャンネル（または監査ログ）が未設定のため、処置は報告されません",
      "log": "✅ 報告は {channel} に送られます",
      "log-unavailable": "⚠️ ログチャンネルに送信できません",
    },
  },
};
