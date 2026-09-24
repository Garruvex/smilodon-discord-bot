import type { SettingsTextCatalog } from "../catalog.js";

export const jaAccess: SettingsTextCatalog = {
  "access": { title: "アクセス", description: "ロール、権限、監査ログ" },

  "access.roles": {
    label: "アクセスロール",
    description: "設定の管理、音楽の操作、AI チャットを使えるロールと、制限されるロール",
  },
  "access.roles.administrator": {
    label: "ボット管理者",
    description: "/settings を管理でき、音楽コントローラーの権限もすべて持つ",
    messages: { required: "ボット管理者ロールを少なくとも 1 つ残す必要があります。" },
  },
  "access.roles.music-controller": {
    label: "音楽コントローラー",
    description: "/play、キューのコマンド、パネル操作、テキストでのリクエストを使える",
    messages: { required: "音楽機能が有効なため、音楽コントローラーのロールを少なくとも 1 つ残す必要があります。" },
  },
  "access.roles.chatbot": {
    label: "AI チャット",
    description: "チャットボット機能がオンのとき、ボットにメンションして AI チャットできる",
    messages: { required: "チャットボットが有効なため、チャットボットのロールを少なくとも 1 つ残す必要があります（先にチャットボット機能をオフにしてください）。" },
  },
  "access.roles.restricted": { label: "制限", description: "音楽とチャットボット機能を使えない（ボット所有者は例外）" },

  "access.admin-panel": { label: "管理パネル", description: "この設定パネルを置くチャンネル。ボット管理者だけが見られるようにしてください" },
  "access.admin-panel.channel": { label: "パネルのチャンネル", description: "管理設定パネルを置くテキストチャンネル" },

  "access.repair-panel": {
    label: "パネルを修復",
    description: "このパネルを削除して、順番どおりに投稿し直す",
    messages: {
      "done": "管理パネルを投稿し直しました。",
      "no-panel": "管理パネルのチャンネルが設定されていません。",
    },
  },

  "access.audit-log": { label: "監査ログ", description: "設定と初期設定の変更を記録するチャンネル" },
  "access.audit-log.channel": { label: "監査ログのチャンネル", description: "監査ログを受け取るテキストチャンネル" },

  "access.access": { label: "アクセスの概要", description: "各アクセスグループのロールと、そのグループでできること" },

  "access.audit": {
    label: "最近の変更",
    description: "監査ログにある最近の設定と初期設定の変更",
    messages: {
      "unavailable": "監査ログは現在利用できません。",
      "not-configured": "監査ログのチャンネルが設定されていません。`/settings-access audit-log channel:<チャンネル>` で設定してください。",
      "empty": "監査ログはまだありません。",
      "heading": "最近の監査ログ：",
    },
  },
  "access.audit.count": { label: "件数", description: "表示する最近の件数（既定は 10）" },
};
