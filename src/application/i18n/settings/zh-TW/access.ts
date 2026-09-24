import type { SettingsTextCatalog } from "../catalog.js";

export const zhTWAccess: SettingsTextCatalog = {
  "access": { title: "存取權限", description: "身分組、權限與稽核紀錄" },

  "access.roles": {
    label: "存取身分組",
    description: "哪些身分組可以管理設定、控制音樂、使用 AI 聊天，或受到限制",
  },
  "access.roles.administrator": {
    label: "機器人管理員",
    description: "可管理伺服器設定，並擁有所有音樂控制權限",
    messages: { required: "至少要保留一個機器人管理員身分組。" },
  },
  "access.roles.music-controller": {
    label: "音樂控制者",
    description: "可使用 /play、待播清單指令、面板控制與文字點歌",
    messages: { required: "音樂功能已啟用，至少要保留一個音樂控制者身分組。" },
  },
  "access.roles.chatbot": {
    label: "AI 聊天",
    description: "聊天機器人功能開啟時，可提及機器人進行 AI 聊天",
    messages: { required: "聊天機器人已啟用，至少要保留一個聊天機器人身分組（或先關閉聊天機器人功能）。" },
  },
  "access.roles.restricted": { label: "受限制", description: "禁止使用音樂與聊天機器人功能（機器人擁有者例外）" },

  "access.admin-panel": { label: "管理面板", description: "這個設定面板所在的頻道，建議只讓機器人管理員看得到" },
  "access.admin-panel.channel": { label: "面板頻道", description: "放置管理設定面板的文字頻道" },

  "access.repair-panel": {
    label: "修復面板",
    description: "移除這個面板並依順序重新發布",
    messages: {
      "done": "已重新發布管理面板。",
      "no-panel": "尚未設定管理面板頻道。",
    },
  },

  "access.audit-log": { label: "稽核紀錄", description: "記錄設定與初始設定變更的頻道" },
  "access.audit-log.channel": { label: "稽核紀錄頻道", description: "接收稽核紀錄的文字頻道；留空則關閉稽核紀錄" },

  "access.access": { label: "存取權限摘要", description: "各存取群組的身分組，以及群組可以做什麼" },

  "access.audit": {
    label: "最近的變更",
    description: "稽核紀錄中最近的設定與初始設定變更",
    messages: {
      "unavailable": "稽核紀錄目前無法使用。",
      "not-configured": "尚未設定稽核紀錄頻道。請用 `/settings-access audit-log channel:<頻道>` 設定。",
      "empty": "目前還沒有稽核紀錄。",
      "heading": "最近的稽核紀錄：",
    },
  },
  "access.audit.count": { label: "筆數", description: "要顯示最近幾筆紀錄（預設 10）" },
};
