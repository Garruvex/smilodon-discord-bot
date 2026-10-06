import type { SettingsTextCatalog } from "../catalog.js";

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
      "no-log": "ℹ️ ログチャンネル（または監査ログ）が未設定のため、処置は報告されません",
      "log": "✅ 報告は {channel} に送られます",
      "log-unavailable": "⚠️ ログチャンネルに送信できません",
    },
  },
};
