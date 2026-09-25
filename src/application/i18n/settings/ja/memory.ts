import type { SettingsTextCatalog } from "../catalog.js";

const memoryModes = {
  shared: "共有：記憶の範囲はモデルが判断",
  isolated: "分離：記憶はこのチャンネルだけ",
  session_only: "その場のみ：長期の記憶は書かない",
  disabled: "無効：記憶を読み書きしない",
};

export const jaMemory: SettingsTextCatalog = {
  "memory": { title: "記憶", description: "ボットが読み返し、覚えておくこと" },
  "memory.channel-history": { label: "チャンネル履歴", description: "チャンネルの最近のメッセージを返信の文脈に使う" },
  "memory.channel-history.enabled": { label: "チャンネル履歴", description: "チャンネル履歴をオンまたはオフにする" },
  "memory.channel-history.limit": { label: "メッセージ数", description: "含める最近のメッセージの数" },

  "memory.memory-mode": {
    label: "チャンネルの記憶モード",
    description: "チャンネルの記憶をどう分離するか設定する",
    messages: {
      missing: "チャンネルとモードを選んでください。",
      done: "{channel} の記憶モードを「{mode}」にしました。",
    },
  },
  "memory.memory-mode.channel": { label: "チャンネル", description: "設定するチャンネル" },
  "memory.memory-mode.mode": { label: "モード", description: "チャンネルの記憶モード", choices: memoryModes },

  "memory.context-daily": { label: "毎日の要約", description: "1 日 1 回要約して記憶に入れるチャンネル" },
  "memory.context-daily.channels": {
    label: "チャンネル",
    description: "毎日要約するテキストチャンネル",
    messages: { unavailable: "チャンネルを要約できるチャットサービスがないため、オンにできません。" },
  },

  "memory.context-scan": {
    label: "履歴スキャン",
    description: "チャンネルの過去の履歴を一度読み、要約を記憶に入れる",
    messages: {
      unavailable: "チャンネルを要約できるチャットサービスがないため、キューに入れられません。",
      missing: "スキャンするチャンネルを選んでください。",
      "in-progress": "このチャンネルのスキャンはすでにキューにあるか実行中です。バックグラウンドの状態を確認してください。",
      completed: "このチャンネルのスキャンは完了しています。もう一度実行するには「やり直す」をオンにしてください。",
      queued: "{channel} を一度きりの履歴スキャンのキューに入れました。バックグラウンドで実行されます。進捗は状態で確認できます。",
      restarted: "{channel} のスキャンをやり直します。履歴を読み直して要約し直します。進捗は状態で確認できます。",
    },
  },
  "memory.context-scan.channel": { label: "チャンネル", description: "スキャンするチャンネル" },
  "memory.context-scan.seed-days": { label: "読む日数", description: "初回に遡る日数（既定は 7）" },
  "memory.context-scan.restart": { label: "やり直す", description: "完了したスキャンを最初から実行し直す" },

  "memory.context-remove": {
    label: "要約をやめる",
    description: "チャンネルをスキャンと毎日の一覧から外す。書いた記憶は残る",
    messages: {
      missing: "チャンネルを選んでください。",
      done: "{channel} はもうスキャンも要約もされません。書き込み済みの記憶は残ります。",
    },
  },
  "memory.context-remove.channel": { label: "チャンネル", description: "要約をやめるチャンネル" },

  "memory.context-status": {
    label: "バックグラウンドの状態",
    description: "スキャンや要約の対象チャンネルと、それぞれの前回の実行状況",
    messages: {
      "provider-available": "サービス：利用可能",
      "provider-unavailable": "サービス：利用不可",
      "chatbot-enabled": "チャットボット：オン",
      "chatbot-paused": "チャットボット：オフ（オンにするまで処理しません）",
      "seed-days": "初回に読む日数：{days}",
      "none-configured": "スキャンや毎日の要約に設定されたチャンネルはありません。",
      "channel-not-configured": "このチャンネルはスキャンにも毎日の要約にも設定されていません。",
      "scan": "スキャン：{state}",
      "scan-cursor": "スキャンの位置：{cursor}",
      "daily": "毎日：{state}",
      "daily-cursor": "毎日の位置（処理中）：{cursor}",
      "daily-high-water": "毎日の要約済み：{at} まで",
      "last-success": "前回の成功：{at}",
      "last-error": "⚠️ 前回のエラー（{code}）：{error}",
      "state-queued": "キュー待ち",
      "state-running": "実行中",
      "state-complete": "完了",
      "state-failed": "失敗",
      "state-enabled": "オン",
    },
  },
  "memory.context-status.channel": { label: "チャンネル", description: "1 つのチャンネルだけ表示する" },
};
