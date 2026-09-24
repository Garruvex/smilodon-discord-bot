import type { CommandDescriptionCatalog } from "./catalog.js";

// DRAFT Japanese (ja) translations of the slash-command descriptions — pending
// review by a native speaker. The trailing comment on each line is the English
// source for that entry. Keys are the command's path (see
// commandDescriptionKey in ./catalog.ts); command and option NAMES are not
// localized, only their descriptions.
export const jaCommandDescriptions = {
  "birthday": "このサーバーでの誕生日告知を管理します。", // Manages birthdays for this server's announcements.
  "birthday/set": "自分の誕生日を設定します。", // Sets your birthday.
  "birthday/set:month": "誕生月。", // Birth month.
  "birthday/set:day": "誕生日の日にち。", // Birth day.
  "birthday/set:user": "代わりに他のメンバーの誕生日を設定します（ボット管理者のみ）。", // Set another member's birthday instead (bot administrators only).
  "birthday/view": "メンバーの誕生日を表示します。", // Shows a member's birthday.
  "birthday/view:user": "調べるメンバー。省略すると自分になります。", // The member to look up; defaults to you.
  "birthday/remove": "自分の誕生日を削除します。", // Removes your birthday.
  "birthday/remove:user": "代わりに他のメンバーの誕生日を削除します（ボット管理者のみ）。", // Remove another member's birthday instead (bot administrators only).
  "birthday/next": "次に誕生日を迎えるメンバーを表示します。", // Shows whose birthday is coming up next.
  "birthday/next:public": "自分だけでなく全員に見えるように表示します。", // Show this to everyone instead of just you.
  "boosts": "サーバーブーストの履歴を表示します。", // Shows server boost history.
  "boosts/history": "メンバーのブースト履歴と累計ブースト期間を表示します。", // Shows a member's boost timeline and total time boosted.
  "boosts/history:user": "調べるメンバー。省略すると自分になります。", // The member to look up; defaults to you.
  "boosts/leaderboard": "現在のブースターを、連続ブースト期間が長い順に表示します。", // Shows the server's current boosters, longest streak first.
  "boosts/leaderboard:public": "自分だけでなく全員に見えるように表示します。", // Show this to everyone instead of just you.
  "clean": "このチャンネルにあるボットの最近のメッセージを削除します。", // Deletes the bot's recent messages in this channel.
  "clean:count": "確認する最近のメッセージ数（デフォルト：100）。", // How many recent messages to scan (default 100).
  "customize": "チャットボットがあなたと接する方法をカスタマイズします。ボットの個性やルールは変わりません。", // Customize how the chatbot interacts with you specifically. Its identity and rules stay the same.
  "customize/set": "Markdownファイルでカスタマイズ内容を設定または置き換えます。", // Sets or replaces your customization from a Markdown file.
  "customize/set:file": "ボットにどう接してほしいかを書いた .md ファイル。", // A .md file describing how you'd like the bot to interact with you.
  "customize/view": "このサーバーでの現在のカスタマイズ内容を表示します。", // Shows your current customization in this server.
  "customize/clear": "このサーバーでのカスタマイズ内容を消去します。記憶には影響しません。", // Clears your customization in this server. Does not affect memory.
  "dice": "サイコロを1個以上振ります。", // Rolls one or more dice.
  "dice:sides": "サイコロ1個あたりの面の数（デフォルト6）。", // Number of sides per die (default 6).
  "dice:count": "振るサイコロの数（デフォルト1）。", // Number of dice to roll (default 1).
  "8ball": "マジック8ボールに質問します。", // Ask the magic 8-ball a question.
  "8ball:question": "何を聞きたいですか？", // What do you want to ask?
  "help": "使えるコマンドの一覧、または特定コマンドの詳細を表示します。", // Lists available commands, or shows details for one.
  "help:command": "詳細を見たいコマンド名。", // A command name to view details for.
  "memory": "チャットからボットがあなたについて覚えている内容を確認・消去します。", // View or clear what the bot remembers about you from chat.
  "memory/list": "このサーバーでボットがあなたについて覚えている内容を一覧表示します。", // Lists what the bot remembers about you in this server.
  "memory/forget": "ボットが覚えているあなたについての内容を削除します。", // Deletes something the bot remembers about you.
  "memory/forget:id": "削除する記憶のID（/memory list で確認できます）。", // The memory ID to forget, from /memory list.
  "memory/forget:all": "このサーバーでボットが覚えているあなたについての内容をすべて忘れさせます。", // Forget everything the bot remembers about you in this server.
  "memory/notes": "チャットのリクエストに関する補足メモをボットがDMで送るかどうかを設定します。", // Controls whether the bot DMs you extra notes about your chat requests.
  "memory/notes:dm": "画像が添付されなかった場合や返信が途中で切れた場合などに、DMで補足メモを送ります。省略すると現在の設定を確認できます。", // Send notes like dropped images or truncated replies as a DM. Omit to check the current setting.
  "owoify": "文章を owo 風に変換します。", // Transforms a sentence into owo speak.
  "owoify:text": "owo化する文章。", // The sentence to owoify.
  "ping": "ボットが応答しているか確認します。", // Checks whether the bot is responding.
  "qa": "質問と回答を埋め込んだメッセージを投稿します。", // Posts a question-and-answer embed.
  "qa:question": "質問。", // The question.
  "qa:answer": "回答。", // The answer.
  "qa:image": "添付する画像。", // An image to attach.
  "qa:spoiler": "回答と画像をスポイラーで隠します。", // Hide the answer and image behind a spoiler.
  "quote": "メッセージを引用カードにします。", // Turn a message into a quote card.
  "quote:message": "メッセージリンク、またはこのチャンネル内のメッセージID。", // A message link, or a message ID from this channel.
  "reactionroles": "ロール選択メニューを設定します。", // Sets up a role-picker menu.
  "reactionroles/create": "チャンネルにロール選択メニューを投稿します。", // Posts a role-picker menu in a channel.
  "reactionroles/create:channel": "メニューを投稿する場所。", // Where to post the menu.
  "reactionroles/create:title": "メニューのタイトル。", // Menu title.
  "reactionroles/create:role1": "メンバーが選べるロール。", // A role members can pick.
  "reactionroles/create:role2": "メンバーが選べる別のロール。", // Another role members can pick.
  "reactionroles/create:role3": "メンバーが選べる別のロール。", // Another role members can pick.
  "reactionroles/create:role4": "メンバーが選べる別のロール。", // Another role members can pick.
  "reactionroles/create:role5": "メンバーが選べる別のロール。", // Another role members can pick.
  "remind": "自分用のリマインダーを管理します。", // Manages your personal reminders.
  "remind/set": "リマインダーを設定します。", // Sets a reminder.
  "remind/set:duration": "例：30m、2h、1d、1d12h。", // e.g. 30m, 2h, 1d, or 1d12h.
  "remind/set:message": "リマインドする内容。", // What to remind you about.
  "remind/set:delivery": "通知の送信先（デフォルト：DM）。", // Where to send it (default: DM).
  "remind/list": "保留中のリマインダーを一覧表示します。", // Lists your pending reminders.
  "remind/cancel": "リマインダーをキャンセルします。", // Cancels a reminder.
  "remind/cancel:id": "リマインダーID。/remind list で確認できます。", // The reminder id (from /remind list).
  "userinfo": "メンバーの情報を表示します。", // Shows information about a member.
  "userinfo:user": "調べるメンバー。省略すると自分になります。", // The member to look up; defaults to you.
  "vote": "投票を作成します。デフォルトは「はい／いいえ」、または最大5つの選択肢を自分で設定できます。", // Creates a poll: Yes/No by default, or up to five choices of your own.
  "vote:title": "投票のタイトル。", // Poll title.
  "vote:description": "メンバーが投票する内容。", // What members are voting on.
  "vote:duration": "投票が締め切られるまでの秒数。省略すると開いたままになります。", // Seconds before the poll closes; omit to keep it open.
  "wolfy": "文章を犬の鳴き声に変換します。", // Turns a sentence into dog noises.
  "wolfy:text": "犬の鳴き声に変換する文章。", // The sentence to translate.
  "diagnostic": "オーナー専用の実行時診断情報を表示します。", // Displays owner-only runtime diagnostics.
  "memory-eval": "関連性の調整のため、サンプリングされた記憶検索結果を確認します。", // Review sampled memory retrievals for relevance calibration.
  "memory-eval/pending": "未レビューの最新の検索サンプルを表示します。", // Shows the newest unreviewed retrieval sample.
  "memory-eval/label": "取得されるべきだった候補にラベルを付けます。", // Marks the candidates that should have been retrieved.
  "memory-eval/label:trace": "/memory-eval pending に表示されるトレースID。", // Trace ID shown by /memory-eval pending.
  "memory-eval/label:relevant": "関連する候補のIDをカンマ区切りで指定。該当なしの場合は省略します（それも有効なラベルです）。", // Comma-separated candidate IDs that are relevant. Omit if none of them were — that's a valid label.
  "memory-eval/label:split": "データセットの区分。", // Dataset split.
  "memory-eval/skip": "使えない、または曖昧なサンプルをスキップします。", // Skips an unusable or ambiguous sample.
  "memory-eval/skip:trace": "/memory-eval pending に表示されるトレースID。", // Trace ID shown by /memory-eval pending.
  "memory-eval/export": "レビュー済みのケースを調整用データセットとしてダウンロードします。", // Downloads reviewed cases as a calibration dataset.
  "fursuit-furtrack": "furtrack.com からランダムなフルスーツの写真を取得します。", // Gets a random fursuit photo from furtrack.com.
  "fursuit-furtrack:tag": "検索するタグ（デフォルト：fursuit）。", // Tag to search for (default: fursuit).
  "autoplay": "関連する曲を自動でキューに追加する機能を切り替えます。", // Toggles automatic related-track queueing.
  "filters": "再生にオーディオフィルターのプリセットを適用します。", // Applies an audio filter preset to playback.
  "filters:preset": "適用するフィルターのプリセット。", // The filter preset to apply.
  "loop": "再生のリピートモードを設定します。", // Sets the playback repeat mode.
  "loop:mode": "リピートモード。", // Repeat mode.
  "move": "キュー内の曲を別の位置に移動します。", // Moves a queued track to a different position.
  "move:track": "移動する曲のキュー内の位置（1から）。", // The queue position of the track to move, starting at 1.
  "move:position": "移動先のキュー内の位置（1から）。", // The queue position to move it to, starting at 1.
  "pause": "現在の曲を一時停止します。", // Pauses the current track.
  "play": "曲を再生する、またはキューに追加します。", // Plays a track or adds it to the queue.
  "play:query": "曲名、または対応しているURL。", // A song name or supported URL.
  "play:channel": "再生するボイスチャンネル（デフォルトは現在参加中のチャンネル）。", // Voice channel to play in (defaults to your current voice channel).
  "playnext": "曲を再生する、またはキューの先頭に追加します。", // Plays a track or adds it to the front of the queue.
  "playnext:query": "曲名、または対応しているURL。", // A song name or supported URL.
  "previous": "前の曲を再生します。", // Plays the previous track.
  "queue": "音楽キューを表示・管理します。", // Views or manages the music queue.
  "queue/show": "キュー内の曲を表示します。", // Shows queued tracks.
  "queue/remove": "位置を指定してキューから曲を削除します。", // Removes a queued track by position.
  "queue/remove:position": "キュー内の位置（1から）。", // Queue position, starting at 1.
  "queue/clear": "再生待ちの曲をすべて消去します。", // Clears every upcoming track.
  "queue/history": "最近再生した曲を表示します。", // Shows recently played tracks.
  "replay": "現在の曲を最初から再生し直します。", // Restarts the current track from the beginning.
  "resume": "一時停止中の曲を再開します。", // Resumes the paused track.
  "save": "再生中の曲のリンクをDMで送ります。", // DMs you a link to the currently playing track.
  "seek": "現在の曲の指定した時間にシークします。", // Seeks to a specific time in the current track.
  "seek:time": "シーク先の時間。例：90、1:30、1h2m3s。", // Time to seek to, e.g. 90, 1:30, or 1h2m3s.
  "shuffle": "再生待ちの曲をシャッフルします。", // Shuffles upcoming tracks.
  "skip": "現在の曲をスキップします。", // Skips the current track.
  "skipto": "キュー内の指定した曲までスキップします。", // Skips ahead to a specific track in the queue.
  "skipto:position": "キュー内の位置（1から）。", // Queue position, starting at 1.
  "stop": "再生を停止し、キューを空にして、ボットを切断します。", // Stops playback, clears the queue, and disconnects the bot.
  "247": "ボイスチャンネル常駐モードを切り替えます。", // Toggles persistent voice-channel mode.
  "volume": "再生音量を設定します。", // Sets playback volume.
  "volume:level": "音量（パーセント）。", // Volume percentage.
  "setup": "このサーバー用にボットを設定します。", // Configures this server for the bot.
  "setup/initialize": "ロールと常設の音楽チャンネルを作成、または既存のものを利用します。", // Creates or adopts roles and a persistent music channel.
  "setup/initialize:display-name": "このサーバーのプロフィールで使う表示名。", // Display name used by this server profile.
  "setup/initialize:idle-image-url": "何も再生していないときに表示する、固定のHTTPS画像URL。", // Stable HTTPS image URL shown when nothing is playing.
  "setup/initialize:control-channel": "既存の音楽コントロールチャンネル。省略すると新規作成します。", // Existing music control channel; one is created if omitted.
  "setup/initialize:administrator-role": "既存のボット管理者ロール。省略すると新規作成します。", // Existing bot administrator role; one is created if omitted.
  "setup/initialize:music-controller-role": "/play、キュー関連コマンド、パネル操作、コントロールチャンネルでのリクエストを使えるロール。", // Role for /play, queue commands, panel controls, and typed control-channel requests.
  "setup/initialize:restricted-role": "音楽とチャットボットの利用を禁止するロール（ボットオーナーは除く）。", // Role denied from music and chatbot unless bot-owner bypass applies.
  "status": "このサーバーでのボットの設定状況（現在のチャットモデルを含む）を表示します。", // Shows how the bot is set up in this server, including the current chat model.
  "settings-access": "ロール、権限、監査ログの設定。", // Roles, permissions, and audit logging.
  "settings-access/access": "設定済みのアクセスロールと、各グループが制御する内容を表示します。", // Shows configured access roles and what each group controls.
  "settings-access/roles": "既存のロールを残したまま、アクセスロールを追加します。", // Adds access roles without removing existing ones.
  "settings-access/roles:administrator": "/settings を使え、音楽操作権限も継承するボット管理者ロールを追加します。", // Adds a bot administrator role for /settings and inherited music control.
  "settings-access/roles:music-controller": "/play、キュー関連コマンド、パネル操作を使えるロールを追加します。", // Adds a role for /play, queue commands, and panel controls.
  "settings-access/roles:restricted": "音楽とチャットボットの利用を禁止するロールを追加します（ボットオーナーは除く）。", // Adds a role denied from music and chatbot unless bot-owner bypass applies.
  "settings-access/role-add": "アクセスグループにロールを追加します。", // Adds a role to an access group.
  "settings-access/role-add:group": "アクセスグループ。", // Access group.
  "settings-access/role-add:role": "追加するロール。", // Role to add.
  "settings-access/role-remove": "アクセスグループからロールを削除します。", // Removes a role from an access group.
  "settings-access/role-remove:group": "アクセスグループ。", // Access group.
  "settings-access/role-remove:role": "削除するロール。", // Role to remove.
  "settings-access/audit-log": "設定・セットアップの変更ログを受け取るチャンネルを設定します。", // Configures the channel that receives settings/setup change logs.
  "settings-access/audit-log:channel": "監査ログを受け取るテキストチャンネル。", // Text channel to receive audit log entries.
  "settings-access/audit-log:disable": "監査ログの送信を停止します。", // Stop sending audit log entries.
  "settings-access/audit": "最近の設定・セットアップの変更ログを表示します。", // Shows recent settings/setup change log entries.
  "settings-access/audit:count": "表示する最近のログ件数（デフォルト10）。", // How many recent entries to show (default 10).
  "settings-music": "音楽パネルと再生の動作。", // Music panel and playback behavior.
  "settings-music/panel": "音楽パネルを更新します。", // Updates the music panel.
  "settings-music/panel:channel": "音楽コントロールチャンネル。", // Music control channel.
  "settings-music/panel:idle-image-url": "固定のHTTPSアイドル画像URL。", // Stable HTTPS idle image URL.
  "settings-music/panel:idle-image": "永続的に保存するPNG、JPEG、WebP、GIFのアイドル画像をアップロードします。", // Upload a persistent PNG, JPEG, WebP, or GIF idle image.
  "settings-music/panel:use-default-image": "内蔵のSmilodonアイドル画像を使用します。", // Use the bundled Smilodon idle image.
  "settings-music/panel:progress-style": "プログレスバーの見た目。", // Progress bar appearance.
  "settings-music/panel:progress-length": "プログレスバーの長さ。", // Progress bar length.
  "settings-music/panel:progress-completed": "再生済み部分に使うカスタム絵文字。絵文字を貼り付けるか、サーバー内の名前を入力します。", // Custom completed emoji; paste an emoji or enter its server name.
  "settings-music/panel:progress-remaining": "未再生部分に使うカスタム絵文字。絵文字を貼り付けるか、サーバー内の名前を入力します。", // Custom remaining emoji; paste an emoji or enter its server name.
  "settings-music/panel:progress-playing": "再生中の現在位置に使うカスタム絵文字。", // Custom current-position emoji while playing.
  "settings-music/panel:progress-paused": "一時停止中の現在位置に使うカスタム絵文字。", // Custom current-position emoji while paused.
  "settings-music/panel:progress-ending": "終端用の絵文字（任意）。削除するには 'none' を入力します。", // Optional ending emoji, or 'none' to remove it.
  "settings-music/volume": "音量の上限などを更新します。", // Updates music volume limits.
  "settings-music/volume:default": "デフォルトの音量。", // Default volume.
  "settings-music/volume:maximum": "最大音量。", // Maximum volume.
  "settings-music/volume:button-step": "パネルのボタン1回あたりの調整量。", // Panel adjustment amount.
  "settings-music/lifecycle": "キューやチャンネルが空になったときの動作を更新します。", // Updates empty queue/channel behavior.
  "settings-music/lifecycle:empty-queue-action": "キューが終わったときの動作。", // Action when the queue ends.
  "settings-music/lifecycle:queue-delay-seconds": "キューが空になってから動作するまでの待ち時間。", // Delay before empty-queue action.
  "settings-music/lifecycle:empty-channel-action": "全員が退出したときの動作。", // Action when everyone leaves.
  "settings-music/lifecycle:channel-grace-seconds": "動作するまでの猶予時間。", // Grace period before action.
  "settings-music/lifecycle:resume-when-occupied": "自動一時停止のあと、誰かが戻ってきたときに再開するかどうか。", // Resume after an automatic pause.
  "settings-music/dj-mode": "ミュージックコントローラーのロールがどこからでも再生を操作できるようにします。", // Lets music-controller roles control playback from anywhere.
  "settings-music/dj-mode:enabled": "DJモードを有効にするかどうか。", // Whether DJ mode is on.
  "settings-music/open-queue-requests": "ボットのボイスチャンネルに参加していなくても、誰でも曲をキューに追加できるようにします。", // Lets anyone queue songs without joining the bot's voice channel.
  "settings-music/open-queue-requests:enabled": "オープンなキューリクエストを有効にするかどうか。", // Whether open queue requests are on.
  "settings-chat": "AIチャットの動作。", // AI chat behavior.
  "settings-chat/chatbot": "メンションに対するAI返信を設定します。", // Configures mention-based AI replies.
  "settings-chat/chatbot:enabled": "権限のあるユーザーがボットにメンションしたときに返信します。", // Reply when permitted users mention the bot.
  "settings-chat/chatbot:role": "メンションチャットを使えるロールを追加します。", // Adds a role allowed to use mention chat.
  "settings-chat/chatbot:channel": "メンションチャットを許可するテキストチャンネルを追加します。", // Adds a text channel where mention chat is allowed.
  "settings-chat/chatbot:memory-mode": "`channel` の記憶を分離するモードを設定します（未設定の場合は共有）。", // Sets `channel`'s memory isolation mode (defaults to shared if never set).
  "settings-chat/chatbot:cooldown-seconds": "ユーザーごとのリクエスト間隔。", // Per-user delay between requests.
  "settings-chat/chatbot:denied-message": "権限のないユーザーに表示する、ちょっとしたユーモアのある返答。", // Playful response shown to users without access.
  "settings-chat/chatbot:denied-link-url": "拒否メッセージと一緒に表示するリンクボタンのURL。\"none\" で削除します。", // Link button URL shown with the denied message. "none" removes it.
  "settings-chat/chatbot:denied-link-label": "拒否メッセージのリンクボタンのラベル。", // Label for the denied-message link button.
  "settings-chat/chatbot:web-search": "必要に応じてモデルが公開Web検索を行えるようにします。", // Allow the model to search the public web when needed.
  "settings-chat/chatbot:tool-calling": "返信の途中でモデルがボットの機能を呼び出せるようにします。", // Allow the model to call bot functions mid-reply.
  "settings-chat/chatbot:image-input": "Discordの画像添付を受け付けます（枚数に上限があります）。", // Allow bounded image attachments from Discord.
  "settings-chat/chatbot:image-generation": "メンションチャットでモデルが画像を生成できるようにします。", // Allow the model to generate images in mention chat.
  "settings-chat/chatbot:self-reference-image": "ボットが自分の姿を描くときに使う参照画像。", // Reference image used when the bot draws itself.
  "settings-chat/chatbot:remove-self-reference-image": "自己参照画像を削除します。", // Remove the self-reference image.
  "settings-chat/chatbot:include-sources": "返信にWebの出典リンクを含めます。", // Include web citation links in replies.
  "settings-chat/chatbot:max-images": "1回のリクエストで受け付ける画像の最大数。", // Maximum images accepted per request.
  "settings-chat/chatbot:personality": "サーバーのキャラクター設定をMarkdownファイルでアップロードします。", // Upload the guild personality as a Markdown file.
  "settings-chat/chatbot:use-default-personality": "アップロード済みのキャラクター設定を削除し、内蔵またはデフォルトのファイルを使います。", // Remove the uploaded personality and use the built-in/default file.
  "settings-chat/chatbot:examples": "キャラクターの会話例をMarkdownファイルでアップロードします。", // Upload example character exchanges as a Markdown file.
  "settings-chat/chatbot:use-default-examples": "アップロード済みの会話例ファイルを削除します。", // Remove the uploaded examples file.
  "settings-chat/chatbot:persona-drift": "実験的機能：キャラクターの気分や癖が少しずつ変化するようにします。", // Experimental: let the character's mood/quirks slowly evolve.
  "settings-chat/chatbot:reset-persona-drift": "キャラクターの変化した気分や癖の履歴を消去し、最初からやり直します。", // Wipe the character's evolved mood/quirk history and start over.
  "settings-chat/ambient-replies": "名前が出ただけのメッセージにボットがリアクションや返信をするか、自分で判断できるようにします。", // Lets the bot judge whether to react/reply to messages that merely name it.
  "settings-chat/ambient-replies:enabled": "アンビエント返信を有効にするかどうか。", // Whether ambient replies are on.
  "settings-chat/ambient-replies:cooldown-seconds": "チャンネルごとのアンビエント判定の最小間隔（秒）。", // Minimum seconds between ambient judgment calls per channel.
  "settings-chat/reaction-replies": "自分のチャット返信に付いたリアクションに返信するかどうかをボットが判断できるようにします。", // Lets the bot judge whether to reply to reactions on its own chat replies.
  "settings-chat/reaction-replies:enabled": "リアクション返信を有効にするかどうか。", // Whether reaction replies are on.
  "settings-chat/history-reactions": "チャット中に見えている他の人のメッセージに、ボットがリアクションを付けられるようにします。", // Lets the bot react to other people's messages it already sees during a chat turn.
  "settings-chat/history-reactions:enabled": "履歴メッセージへのリアクションを有効にするかどうか。", // Whether history reactions are on.
  "settings-chat/channel-history": "チャンネルの最近のメッセージをチャットの文脈として使えるようにします。", // Lets the bot use recent channel messages as ambient chat context.
  "settings-chat/channel-history:enabled": "チャンネル履歴の文脈利用を有効にするかどうか。", // Whether ambient channel history is on.
  "settings-chat/channel-history:limit": "含めるチャンネルの最近のメッセージ数。", // How many recent channel messages to include.
  "settings-chat/context-scan-add": "チャンネルを追加し、履歴を一度だけスキャンして記憶に取り込みます。", // Adds a channel for a one-time history scan into memory.
  "settings-chat/context-scan-add:channel": "設定するチャンネル。", // The channel to configure.
  "settings-chat/context-scan-add:seed-days": "初回に読み込む過去の日数（デフォルト7）。", // How many past days to read on the first run (default 7).
  "settings-chat/context-scan-add:restart": "完了済みのスキャンを最初からやり直します（デフォルト false）。", // Re-run a completed scan from scratch (default false).
  "settings-chat/context-daily-add": "チャンネルを追加し、継続的に毎日の要約を記憶に保存します。", // Adds a channel for an ongoing daily summary into memory.
  "settings-chat/context-daily-add:channel": "設定するチャンネル。", // The channel to configure.
  "settings-chat/context-daily-remove": "チャンネルの継続的な日次要約を停止します。", // Stops ongoing daily summarization for a channel.
  "settings-chat/context-daily-remove:channel": "設定するチャンネル。", // The channel to configure.
  "settings-chat/context-remove": "チャンネルをスキャンと毎日の要約の両方から削除します。", // Removes a channel from both scan and daily summarization.
  "settings-chat/context-remove:channel": "設定するチャンネル。", // The channel to configure.
  "settings-chat/context-status": "チャンネルコンテキストが設定されたチャンネルと、前回の実行状況を表示します。", // Shows configured channel-context channels and their last-run state.
  "settings-chat/context-status:channel": "指定したチャンネルの詳細のみ表示します。", // Show detail for one channel only.
  "settings-chat/template": "編集してアップロードするための、personality.md または examples.md のひな形を送信します。", // Sends a starter personality.md or examples.md to edit and upload.
  "settings-chat/template:kind": "送信するひな形の種類。", // Which starter file to send.
  "settings-chat/tools-enable": "モデルが呼び出せるチャットツールを再び有効にします。", // Re-enables a chat tool the model can call.
  "settings-chat/tools-enable:name": "有効にするツール名。", // Tool name to enable.
  "settings-chat/tools-disable": "チャットツールを無効にし、モデルが呼び出せないようにします。", // Disables a chat tool so the model can't call it.
  "settings-chat/tools-disable:name": "無効にするツール名。", // Tool name to disable.
  "settings-chat/tools-list": "すべてのチャットツールと、このサーバーでの有効／無効の状態を一覧表示します。", // Lists every chat tool and whether it's enabled here.
  "settings-community": "独立したコミュニティ機能。", // Standalone community features.
  "settings-community/birthdays": "誕生日の自動告知を設定します。", // Configures automatic birthday announcements.
  "settings-community/birthdays:enabled": "誕生日の告知をオン／オフします。", // Turn birthday announcements on or off.
  "settings-community/birthdays:channel": "誕生日の告知を投稿するテキストチャンネル。", // Text channel where birthday announcements are posted.
  "settings-community/reminders": "メンバーが個人用リマインダーを設定できるかどうかを設定します。", // Configures whether members can set personal reminders.
  "settings-community/reminders:enabled": "/remind コマンドをオン／オフします。", // Turn the /remind command on or off.
  "settings-community/welcome": "メンバーの参加・退出を告知するチャンネルを設定します。", // Sets join/leave announcement channels.
  "settings-community/welcome:join-channel": "新メンバーのウェルカムカードを投稿する場所。", // Where new-member welcome cards are posted.
  "settings-community/welcome:leave-channel": "メンバー退出のメッセージを投稿する場所。", // Where member-left messages are posted.
  "settings-community/nsfw": "このサーバーでのNSFW画像コマンドをオン／オフします。", // Turns NSFW image commands on or off for this server.
  "settings-community/nsfw:enabled": "NSFW画像コマンドを許可します（年齢制限チャンネルでのみ使用可能）。", // Allow NSFW image commands (still requires an age-restricted channel).
  "settings-community/link-fix": "対応プラットフォームのリンクを自動で書き換える設定をします。", // Configures automatic link previews for supported platforms.
  "settings-community/link-fix:enabled": "リンクの自動書き換えをオン／オフします。", // Turn automatic link rewriting on or off.
  "settings-community/link-fix:channel": "書き換え可能なリンクを監視するテキストチャンネルを追加します。", // Adds a text channel to watch for rewritable links.
  "settings-community/link-fix:remove-channel": "監視リストからテキストチャンネルを削除します。", // Removes a text channel from the watched list.
  "settings-community/link-fix:twitter": "Twitter/Xのリンク修正をオン／オフします。", // Turn Twitter/X link fixing on or off.
  "settings-community/link-fix:threads": "Threadsのリンク修正をオン／オフします。", // Turn Threads link fixing on or off.
  "settings-community/link-fix:tiktok": "TikTokのリンク修正をオン／オフします。", // Turn TikTok link fixing on or off.
  "settings-community/link-fix:instagram": "Instagramのリンク修正をオン／オフします。", // Turn Instagram link fixing on or off.
  "settings-community/link-fix:reddit": "Redditのリンク修正をオン／オフします。", // Turn Reddit link fixing on or off.
  "settings-community/link-fix:bilibili": "Bilibiliのリンク修正をオン／オフします。", // Turn Bilibili link fixing on or off.
  "settings-community/member-data": "メンバーが退出したあと、そのデータを保持するか削除するかを設定します。", // Controls whether a departing member's data is kept or deleted.
  "settings-community/member-data:retain": "true：メンバーが戻ったときのためにデータを保持します。false：退出時に削除します。", // true: keep their data if they return. false: delete it when they leave.
  "settings-community/timezone": "誕生日など、このサーバーの日付に使うIANAタイムゾーンを設定します。", // Sets the IANA time zone used for birthdays and other guild-local dates.
  "settings-community/timezone:zone": "IANAタイムゾーン名。例：\"America/New_York\"、\"Asia/Taipei\"。", // An IANA time zone name, e.g. "America/New_York" or "Asia/Taipei".
  "bird": "ランダムな鳥の画像と豆知識を取得します。", // Gets a random bird image and fact.
  "cat": "ランダムな猫の画像と豆知識を取得します。", // Gets a random cat image and fact.
  "dog": "ランダムな犬の画像と豆知識を取得します。", // Gets a random dog image and fact.
  "fox": "ランダムなキツネの画像と豆知識を取得します。", // Gets a random fox image and fact.
  "raccoon": "ランダムなアライグマの画像と豆知識を取得します。", // Gets a random raccoon image and fact.
  "boop": "ランダムな鼻タッチ画像を取得します。", // Gets a random boop image.
  "hold": "ランダムな抱きかかえる画像を取得します。", // Gets a random hold image.
  "howl": "ランダムな遠吠え画像を取得します。", // Gets a random howl image.
  "hug": "ランダムなハグ画像を取得します。", // Gets a random hug image.
  "kiss": "ランダムなキス画像を取得します。", // Gets a random kiss image.
  "lick": "ランダムな舐める動作の画像を取得します。", // Gets a random lick image.
  "bulge": "ランダムな bulge 画像を取得します（NSFW）。", // Gets a random bulge image. NSFW.
  "butts": "ランダムなお尻の画像を取得します。NSFW。", // Gets a random butt image. NSFW.
  "e926": "e926で画像を検索します。", // Searches for images on e926.
  "e621": "e621で画像を検索します。", // Searches for images on e621.
  "e926:query": "検索するタグ（例：wolf, dragon, solo）。空欄ならランダムな投稿を取得します。", // Tags to search for (e.g. wolf, dragon, solo). Leave empty for a random post.
  "e926:type": "ファイルの種類。", // File type.
  "e926:order": "並び順。", // Sort order.
  "e621:query": "検索するタグ（例：wolf, dragon, solo）。空欄ならランダムな投稿を取得します。", // Tags to search for (e.g. wolf, dragon, solo). Leave empty for a random post.
  "e621:type": "ファイルの種類。", // File type.
  "e621:order": "並び順。", // Sort order.
  "settings-community/language": "このサーバーのパネル・告知・返信でボットが使う言語を設定します。", // Sets the language the bot uses for this server's panels, announcements, and replies.
  "settings-community/language:language": "使用する言語。", // The language to use.
  "vote:option1": "選択肢1。2つ以上指定するか、「はい／いいえ」にする場合はすべて空欄にします。", // Choice 1; give at least two choices, or none for Yes/No.
  "vote:option2": "選択肢2。2つ以上指定するか、「はい／いいえ」にする場合はすべて空欄にします。", // Choice 2; give at least two choices, or none for Yes/No.
  "vote:option3": "選択肢3。2つ以上指定するか、「はい／いいえ」にする場合はすべて空欄にします。", // Choice 3; give at least two choices, or none for Yes/No.
  "vote:option4": "選択肢4。2つ以上指定するか、「はい／いいえ」にする場合はすべて空欄にします。", // Choice 4; give at least two choices, or none for Yes/No.
  "vote:option5": "選択肢5。2つ以上指定するか、「はい／いいえ」にする場合はすべて空欄にします。", // Choice 5; give at least two choices, or none for Yes/No.
  "settings-music/autoqueue-vote": "オートキューが次に再生する曲をリスナーの投票で決められるようにします。", // Lets listeners vote on which song autoqueue plays next.
  "settings-music/autoqueue-vote:enabled": "リスナーが投票するかどうか。オフの場合はオートキューが自動で選びます。", // Whether listeners vote; off means autoqueue picks on its own.
  "settings-music/autoqueue-vote:bar-style": "投票バーの見た目。", // How vote bars look.
  "settings-music/autoqueue-vote:options": "候補にする曲の数。", // How many songs to pick from.
} as const satisfies CommandDescriptionCatalog;
