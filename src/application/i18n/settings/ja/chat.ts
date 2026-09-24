import type { SettingsTextCatalog } from "../catalog.js";

export const jaChat: SettingsTextCatalog = {
  "chat": {
    title: "AI チャット",
    description: "ボットの話し方、できること、そしてキャラクター",
    messages: { paused: "注意：チャットボットがオフのため、オンにするまでこの変更は反映されません。" },
  },

  "chat.replies": { title: "返信", description: "ボットがいつ返事をし、どう断るか" },
  "chat.replies.mention-chat": { label: "メンションチャット", description: "AI チャットのロールを持つメンバーにメンションされたら返信する" },
  "chat.replies.mention-chat.enabled": { label: "チャットボット", description: "このサーバーの AI チャットをオンまたはオフにする" },
  "chat.replies.mention-chat.channels": { label: "チャットのチャンネル", description: "メンションチャットを許可するテキストチャンネル。空ならすべてのチャンネル" },
  "chat.replies.mention-chat.cooldown-seconds": { label: "クールダウン（秒）", description: "メンバーごとのリクエスト間隔" },

  "chat.replies.denied-message": { label: "拒否メッセージ", description: "権限のないメンバーがボットにメンションしたときの返事" },
  "chat.replies.denied-message.message": { label: "メッセージ", description: "権限のないメンバーに見せる遊び心のある返事" },
  "chat.replies.denied-message.link-url": {
    label: "リンク URL",
    description: "メッセージに添える https:// のリンクボタン。\"none\" で削除",
    messages: { "not-https": "リンクは https:// の URL にするか、\"none\" で削除してください。" },
  },
  "chat.replies.denied-message.link-label": { label: "リンクの表示名", description: "リンクボタンに表示する文字" },

  "chat.replies.ambient-replies": { label: "アンビエント返信", description: "名前を呼ばれたとき、反応や返信をするかボットが判断する" },
  "chat.replies.ambient-replies.enabled": { label: "アンビエント返信", description: "アンビエント返信をオンまたはオフにする" },
  "chat.replies.ambient-replies.cooldown-seconds": { label: "クールダウン（秒）", description: "チャンネルごとの判断の最短間隔" },

  "chat.replies.reaction-replies": {
    label: "リアクション返信",
    description: "チャット返信へのリアクションに応じて追加で返信する",
    messages: { "wait-order": "最短の待ち時間（{min}分）は最長（{max}分）より長くできません。" },
  },
  "chat.replies.reaction-replies.enabled": { label: "リアクション返信", description: "オンまたはオフ" },
  "chat.replies.reaction-replies.min-wait": { label: "最短待ち時間（分）", description: "最初のリアクション後の最短の待ち時間" },
  "chat.replies.reaction-replies.max-wait": { label: "最長待ち時間（分）", description: "最長の待ち時間。間のランダムな時間で判断" },
  "chat.replies.reaction-replies.min-reactions": { label: "最小リアクション数", description: "先に必要なリアクションの人数" },

  "chat.replies.history-reactions": { label: "履歴リアクション", description: "会話中に見える他のメッセージにボットがリアクションする" },
  "chat.replies.history-reactions.enabled": { label: "履歴リアクション", description: "オンまたはオフ" },

  "chat.abilities": { title: "機能", description: "返信中にモデルができること" },
  "chat.abilities.web-search": { label: "ウェブ検索", description: "必要に応じてモデルが公開ウェブを検索する" },
  "chat.abilities.web-search.enabled": { label: "ウェブ検索", description: "オンまたはオフ" },
  "chat.abilities.include-sources": { label: "出典を付ける", description: "返信にウェブの出典リンクを付ける" },
  "chat.abilities.include-sources.enabled": { label: "出典を付ける", description: "オンまたはオフ" },
  "chat.abilities.tool-calling": { label: "ツール呼び出し", description: "返信中にモデルがボットの機能を呼び出す" },
  "chat.abilities.tool-calling.enabled": { label: "ツール呼び出し", description: "オンまたはオフ" },
  "chat.abilities.image-input": { label: "画像入力", description: "Discord に添付された画像をモデルが見る" },
  "chat.abilities.image-input.enabled": { label: "画像入力", description: "画像入力をオンまたはオフにする" },
  "chat.abilities.image-input.max-images": { label: "画像の上限", description: "1 回のリクエストで受け付ける画像の最大数" },
  "chat.abilities.image-generation": { label: "画像生成", description: "メンションチャットでモデルが画像を生成する" },
  "chat.abilities.image-generation.enabled": { label: "画像生成", description: "オンまたはオフ" },

  "chat.abilities.tools": {
    label: "チャットツール",
    description: "モデルが呼び出せるツールと、このサーバーでの有効・無効",
    messages: {
      none: "登録されているチャットツールはありません。",
      heading: "🟢 有効 · 🔴 このサーバーでは無効",
    },
  },
  "chat.abilities.tool": {
    label: "ツールの有効・無効",
    description: "モデルのチャットツールをオンまたはオフにする",
    messages: {
      unknown: "ツール「{name}」が見つかりません。使えるツール：{available}。",
      done: "無効にしたチャットツール：{disabled}。",
    },
  },
  "chat.abilities.tool.name": { label: "ツール名", description: "ツール一覧に表示される名前" },
  "chat.abilities.tool.enabled": { label: "有効", description: "モデルが呼び出せるかどうか" },

  "chat.persona": { title: "キャラクター", description: "チャットでのボットの人物像" },
  "chat.persona.personality": { label: "性格", description: "キャラクターの性格（Markdown ファイル）" },
  "chat.persona.personality.file": {
    label: "性格ファイル",
    description: "personality.md をアップロード（ひな形はテンプレートの操作で入手）",
    messages: {
      lore: "性格をコンパイルしました：{count} 個のセクションを状況に応じた設定として扱い、関係するときだけ送ります——{headings}。常に使う内容は `##` セクションの外に出してください。",
    },
  },
  "chat.persona.use-default-personality": {
    label: "既定の性格を使う",
    description: "アップロードした性格を削除し、組み込みの性格を使う",
    messages: { done: "既定の性格を使います。" },
  },
  "chat.persona.examples": { label: "会話例", description: "キャラクターの口調で書いた会話の例" },
  "chat.persona.examples.file": { label: "会話例ファイル", description: "examples.md をアップロード（ひな形はテンプレートの操作で入手）" },
  "chat.persona.use-default-examples": {
    label: "会話例を削除",
    description: "アップロードした会話例を削除する",
    messages: { done: "アップロードした会話例を削除しました。" },
  },
  "chat.persona.template": {
    label: "ひな形ファイル",
    description: "編集してアップロードする personality.md か examples.md のひな形を送る",
    messages: { done: "ひな形 `{file}` です。編集してから `{command}` でアップロードしてください。" },
  },
  "chat.persona.template.kind": {
    label: "ファイル",
    description: "送るひな形",
    choices: { personality: "性格", examples: "会話例" },
  },
  "chat.persona.self-reference-image": { label: "自画像の参考", description: "ボットが自分を描くときの見た目" },
  "chat.persona.self-reference-image.image": { label: "画像", description: "PNG、JPEG、WebP、GIF（8 MB まで）" },
  "chat.persona.remove-self-reference-image": {
    label: "自画像の参考を削除",
    description: "アップロードした自画像の参考を削除する",
    messages: { done: "自画像の参考を削除しました。" },
  },
  "chat.persona.persona-drift": { label: "性格のゆらぎ", description: "実験的：キャラクターの気分や癖が少しずつ変わる" },
  "chat.persona.persona-drift.enabled": { label: "性格のゆらぎ", description: "オンまたはオフ" },
  "chat.persona.reset-persona-drift": {
    label: "性格のゆらぎをリセット",
    description: "変化した気分や癖を消して最初からやり直す",
    messages: {
      unavailable: "チャットサービスがないため、性格のゆらぎは使えません。",
      done: "性格のゆらぎをリセットしました。キャラクターは最初からやり直します。",
    },
  },
};
