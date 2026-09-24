import type { SettingsTextCatalog } from "../catalog.js";

export const jaMusic: SettingsTextCatalog = {
  "music": { title: "音楽", description: "音楽パネルと再生の動作。" },

  "music.panel": { label: "音楽パネル", description: "音楽パネルを更新します。", messages: { preview: "プレビュー：" } },
  "music.panel.channel": { label: "パネルのチャンネル", description: "音楽コントロールチャンネル。" },
  "music.panel.progress-style": {
    label: "プログレスバー",
    description: "プログレスバーの見た目。",
    choices: { standard: "標準", yohta: "Yohta", custom: "カスタム", none: "時間のみ" },
    messages: {
      "yohta-missing": "このボットにはYohtaプリセットが用意されていません。不足：{missing}。",
      "custom-missing": "カスタムを選ぶ前に、/settings-music progress-emojis で絵文字を設定してください。",
    },
  },
  "music.panel.progress-length": { label: "プログレスバーの長さ", description: "プログレスバーの長さ。" },

  "music.idle-image": { label: "アイドル画像", description: "何も再生していないときに音楽パネルに表示する画像。" },
  "music.idle-image.file": {
    label: "画像ファイル",
    description: "保存して使うPNG、JPEG、WebP、GIFの待機画像をアップロードします。",
  },
  "music.idle-image.url": {
    label: "画像URL",
    description: "固定のHTTPSアイドル画像URL。",
    messages: { "not-https": "アイドル画像のURLは https:// で始まる必要があります。" },
  },

  "music.default-idle-image": {
    label: "デフォルト画像を使う",
    description: "内蔵のSmilodonアイドル画像を使用します。",
    messages: { done: "アイドル画像を内蔵のデフォルトに戻しました。" },
  },

  "music.progress-emojis": {
    label: "カスタム進行絵文字",
    description: "カスタムプログレスバーの絵文字を設定し、カスタムに切り替えます。",
    messages: {
      done: "カスタム進行絵文字を保存しました。プログレスバーはこれを使います。",
      "no-guild": "サーバー内でのみ使えます。",
    },
  },
  "music.progress-emojis.completed": {
    label: "再生済み部分",
    description: "再生済み部分に使うカスタム絵文字。絵文字を貼り付けるか、サーバー内の名前を入力します。",
  },
  "music.progress-emojis.remaining": {
    label: "未再生部分",
    description: "未再生部分に使うカスタム絵文字。絵文字を貼り付けるか、サーバー内の名前を入力します。",
  },
  "music.progress-emojis.playing": { label: "現在位置（再生中）", description: "再生中の現在位置に使うカスタム絵文字。" },
  "music.progress-emojis.paused": { label: "現在位置（一時停止中）", description: "一時停止中の現在位置に使うカスタム絵文字。" },
  "music.progress-emojis.ending": { label: "終端", description: "終端用の絵文字（任意）。削除するには 'none' を入力します。" },

  "music.volume": { label: "音量", description: "音量の上限などを更新します。" },
  "music.volume.default": { label: "デフォルトの音量", description: "デフォルトの音量。" },
  "music.volume.maximum": { label: "最大音量", description: "最大音量。" },
  "music.volume.button-step": { label: "音量ボタンの幅", description: "パネルのボタン1回あたりの調整量。" },

  "music.lifecycle": { label: "退出と一時停止", description: "キューやチャンネルが空になったときの動作を更新します。" },
  "music.lifecycle.empty-queue-action": {
    label: "キューが終わったとき",
    description: "キューが終わったときの動作。",
    choices: { disconnect: "切断する", stay_connected: "接続したままにする" },
  },
  "music.lifecycle.queue-delay-seconds": {
    label: "キュー終了後の待ち時間（秒）",
    description: "キューが空になってから動作するまでの待ち時間。",
  },
  "music.lifecycle.empty-channel-action": {
    label: "全員が退出したとき",
    description: "全員が退出したときの動作。",
    choices: { continue: "再生を続ける", pause: "一時停止", disconnect: "切断する" },
  },
  "music.lifecycle.channel-grace-seconds": { label: "無人時の猶予（秒）", description: "動作するまでの猶予時間。" },
  "music.lifecycle.resume-when-occupied": {
    label: "誰かが戻ったら再開",
    description: "自動一時停止のあと、誰かが戻ってきたときに再開するかどうか。",
  },

  "music.dj-mode": {
    label: "DJモード",
    description: "ミュージックコントローラーのロールがどこからでも再生を操作できるようにします。",
  },
  "music.dj-mode.enabled": { label: "DJモード", description: "DJモードを有効にするかどうか。" },

  "music.open-queue-requests": {
    label: "オープンリクエスト",
    description: "ボットのボイスチャンネルに参加していなくても、誰でも曲をキューに追加できるようにします。",
  },
  "music.open-queue-requests.enabled": {
    label: "オープンリクエスト",
    description: "ボイスチャンネルに参加していなくても曲を追加できるようにするかどうか。",
  },

  "music.autoqueue-vote": {
    label: "次の曲の投票",
    description: "オートキューが次に再生する曲をリスナーの投票で決められるようにします。",
  },
  "music.autoqueue-vote.enabled": {
    label: "次の曲の投票",
    description: "リスナーが投票するかどうか。オフの場合はオートキューが自動で選びます。",
  },
  "music.autoqueue-vote.bar-style": {
    label: "投票バーの見た目",
    description: "投票バーの見た目。",
    choices: { squares: "カラーの四角", thin: "細いバー（プログレスバーと同じ）" },
  },
  "music.autoqueue-vote.options": { label: "候補の曲数", description: "候補にする曲の数。" },
};
