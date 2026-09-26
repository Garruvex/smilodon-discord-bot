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
      notSetUp: "**まだ設定されていません。** 下でハブのチャンネルを選ぶか、使いたいチャンネルで /dnd setup を実行してください。",
      none: "未設定",
      hub: "ハブのチャンネル：{channel}",
      role: "DnD Admin ロール：{role}",
      games: "終了していないゲーム：{count}",
      modelReady: "AI ダンジョンマスター：準備完了。",
      modelMissing: "AI ダンジョンマスター：このボットでは**未設定**（CAMPAIGN_MODEL）のため、ゲームを開始できません。",
    },
  },

  "dnd.hub-channel": {
    label: "ハブのチャンネル",
    description: "D&D カテゴリを設定し、ゲームのハブと「ゲームを作成」ボタンをこのチャンネルに置きます。",
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
      notSetUp: "先にハブ（ハブのチャンネル）を設定してから、ロールを選んでください。",
      done: "{role} のメンバーがゲームを作成・管理できるようになりました。",
    },
  },
  "dnd.admin-role.role": { label: "ロール", description: "このサーバーで D&D を運営するロール。" },

  "dnd.repair": {
    label: "D&D を修復",
    description: "カテゴリ、ハブ、DnD Admin ロール、各ゲームのカードを確認し、足りないものを作り直します。",
    messages: {
      unavailable: "このボットでは D&D を利用できません。",
      permissions: "D&D に必要な権限がボットにありません：{missing}。",
      done: "D&D を確認し、足りないものを作り直しました。",
    },
  },
};
