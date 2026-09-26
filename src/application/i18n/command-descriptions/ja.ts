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
  "memory/forget:all": "このサーバーでボットが覚えたあなたの情報をすべて削除します。", // Forget everything the bot remembers about you in this server.
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
  "fursuit-furtrack": "furtrack.com からランダムなファースーツの写真を取得します。", // Gets a random fursuit photo from furtrack.com.
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
  "setup/guide": "主な設定を 1 つずつ、自分だけに見える形で案内します。", // Walks through the main settings one at a time, privately.
  "status": "このサーバーでのボットの設定状況（現在のチャットモデルを含む）を表示します。", // Shows how the bot is set up in this server, including the current chat model.
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
  "vote:option1": "選択肢1。2つ以上指定するか、「はい／いいえ」にする場合はすべて空欄にします。", // Choice 1; give at least two choices, or none for Yes/No.
  "vote:option2": "選択肢2。2つ以上指定するか、「はい／いいえ」にする場合はすべて空欄にします。", // Choice 2; give at least two choices, or none for Yes/No.
  "vote:option3": "選択肢3。2つ以上指定するか、「はい／いいえ」にする場合はすべて空欄にします。", // Choice 3; give at least two choices, or none for Yes/No.
  "vote:option4": "選択肢4。2つ以上指定するか、「はい／いいえ」にする場合はすべて空欄にします。", // Choice 4; give at least two choices, or none for Yes/No.
  "vote:option5": "選択肢5。2つ以上指定するか、「はい／いいえ」にする場合はすべて空欄にします。", // Choice 5; give at least two choices, or none for Yes/No.
  "dnd": "AI が進行する D&D キャンペーンを行います", // Runs AI-hosted D&D campaigns.
  "dnd/setup": "このサーバーを D&D 用に設定し、このチャンネルを一覧チャンネルにします", // Sets this server up for D&D games and makes this channel the hub.
  "dnd/setup:hub": "一覧チャンネル（既定: このチャンネル）", // The hub channel (default: this one).
  "dnd/new": "専用チャンネル付きで新しいゲームを作成します", // Creates a new game with its own channels.
  "dnd/new:name": "ゲーム名", // The game's name.
  "dnd/new:language": "プレイする言語（既定: English）", // The language the game is played in (default: English).
  "dnd/new:pacing": "ラウンドの進み方（既定: ライブ）", // How fast rounds go (default: live).
  "dnd/new:players": "卓の最大人数（既定 3）", // Most players at the table (default: 3).
  "dnd/status": "このチャンネルのゲームの状態を表示します", // Shows the state of this channel's game.
  "dnd/pause": "このゲームを一時停止します（主催者）", // Pauses this game (organizer).
  "dnd/resume": "一時停止したゲームを再開します（主催者）", // Resumes a paused game (organizer).
  "dnd/close-round": "待たずに現在のラウンドを締め切ります（主催者）", // Closes the current round without waiting (organizer).
  "dnd/rest": "戦闘の合間にパーティを休ませます（主催者）", // Has the party take a rest between fights (organizer).
  "dnd/rest:type": "休憩の長さ", // How long the rest is.
  "dnd/retry": "保留になったラウンドを DM にやり直させます（主催者）", // Asks the DM to try the held round again (organizer).
  "dnd/repair": "このゲームのチャンネルを確認しカードを描き直します（主催者）", // Checks this game's channels and redraws its cards (organizer).
} as const satisfies CommandDescriptionCatalog;
