import type { SettingsTextCatalog } from "../catalog.js";

export const zhTWDnd: SettingsTextCatalog = {
  "dnd": { title: "D&D", description: "由 AI 主持的 D&D 團務：開關、遊戲顯示的位置，以及誰能管理" },

  "dnd.campaigns": { label: "D&D 團務", description: "設定伺服器是否能進行由 AI 主持的 D&D 團務" },
  "dnd.campaigns.enabled": { label: "D&D 團務", description: "開啟或關閉 /dnd 指令與遊戲大廳" },

  "dnd.status": {
    description: "顯示遊戲大廳、DnD Admin 身分組，以及進行中的遊戲數量",
    messages: {
      unavailable: "這個機器人無法使用 D&D",
      setUp: "**已設定完成。** 遊戲會顯示在大廳。",
      notSetUp: "**尚未設定。** 請在下方選擇大廳頻道（或在想用的頻道執行 /dnd setup）",
      none: "未設定",
      hub: "大廳頻道：{channel}",
      role: "DnD Admin 身分組：{role}",
      games: "未結束的遊戲：{count}",
      modelReady: "AI 地下城主：已就緒",
      modelMissing: "AI 地下城主：這個機器人**尚未設定**（CAMPAIGN_MODEL），因此無法開團",
    },
  },

  "dnd.hub-channel": {
    label: "大廳頻道",
    description: "設定 D&D 分類，並把遊戲大廳與「建立遊戲」按鈕放在這個頻道",
    messages: {
      unavailable: "這個機器人無法使用 D&D",
      permissions: "機器人缺少 D&D 所需的權限：{missing}",
      done: "遊戲大廳現在位於 {channel}，控制訊息與每個遊戲的訊息都已重新張貼",
    },
  },
  "dnd.hub-channel.channel": { label: "頻道", description: "大廳使用的文字頻道，成員只能閱讀" },

  "dnd.admin-role": {
    label: "DnD Admin 身分組",
    description: "選擇可以建立並管理所有遊戲的身分組",
    messages: {
      unavailable: "這個機器人無法使用 D&D",
      notSetUp: "請先設定大廳（大廳頻道），再選擇身分組",
      done: "{role} 的成員現在可以建立並管理遊戲",
    },
  },
  "dnd.admin-role.role": { label: "身分組", description: "在這個伺服器主持 D&D 的身分組" },

  "dnd.repair": {
    label: "修復 D&D",
    description: "檢查分類、大廳、DnD Admin 身分組與每個遊戲的卡片，並補回缺少的部分",
    messages: {
      unavailable: "這個機器人無法使用 D&D",
      permissions: "機器人缺少 D&D 所需的權限：{missing}",
      done: "已檢查 D&D，缺少的部分都已重新建立",
    },
  },
};
