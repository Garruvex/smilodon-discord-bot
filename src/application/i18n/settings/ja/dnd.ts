import type { SettingsTextCatalog } from "../catalog.js";

export const jaDnd: SettingsTextCatalog = {
  "dnd": { title: "D&D", description: "AI が進行する D&D キャンペーン：スイッチ、ゲームの表示場所、管理する人。" },

  "dnd.campaigns": { label: "D&D キャンペーン", description: "サーバーで AI が進行する D&D キャンペーンを実行できるかどうかを設定します。" },
  "dnd.campaigns.enabled": { label: "D&D キャンペーン", description: "/dnd コマンドとゲームのハブをオン／オフします。" },

  "dnd.status": {
    description: "ゲームのハブ、DnD Admin ロール、進行中のゲーム数を表示します。",
    messages: {
      unavailable: "このボットでは D&D を利用できません。",
      setUp: "**設定済みです。** ゲームはハブに表示されます。",
      notSetUp: "**まだ設定されていません。** 下の「D&D を設定」を使うと、D&D カテゴリと #dnd-games のハブが作られます。",
      none: "未設定",
      hub: "ハブのチャンネル：{channel}",
      role: "DnD Admin ロール：{role}",
      games: "終了していないゲーム：{count}",
      modelReady: "AI ダンジョンマスター：準備完了。",
      modelMissing: "AI ダンジョンマスター：このボットでは**未設定**（CAMPAIGN_MODEL）のため、ゲームを開始できません。",
    },
  },

  "dnd.setup": {
    label: "D&D を設定",
    description: "D&D カテゴリ、#dnd-games のハブ、DnD Admin ロールを作るか、確認して修復します。",
    messages: {
      unavailable: "このボットでは D&D を利用できません。",
      permissions: "D&D に必要な権限がボットにありません：{missing}。",
      done: "D&D を設定しました。ゲームのハブは {channel} です。足りないものは作り直しました。",
    },
  },

  "dnd.hub-channel": {
    label: "ハブを移す",
    description: "ゲームのハブと「ゲームを作成」ボタンを、#dnd-games ではなく選んだチャンネルに置きます。",
    messages: {
      unavailable: "このボットでは D&D を利用できません。",
      permissions: "D&D に必要な権限がボットにありません：{missing}。",
      done: "ゲームのハブを {channel} に移しました。操作メッセージと各ゲームのメッセージを投稿しました。",
    },
  },
  "dnd.hub-channel.channel": { label: "チャンネル", description: "ハブに使うテキストチャンネル。メンバーは閲覧のみです。" },

  "dnd.admin-role": {
    label: "DnD Admin ロール",
    description: "すべてのゲームを作成・管理できるロールを選びます。",
    messages: {
      unavailable: "このボットでは D&D を利用できません。",
      notSetUp: "先に「D&D を設定」を実行してから、ロールを選んでください。",
      done: "{role} のメンバーがゲームを作成・管理できるようになりました。",
    },
  },
  "dnd.admin-role.role": { label: "ロール", description: "このサーバーで D&D を運営するロール。" },

};
