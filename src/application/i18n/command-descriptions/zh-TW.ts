import type { CommandDescriptionCatalog } from "./catalog.js";
import type { jaCommandDescriptions } from "./ja.js";

// DRAFT Traditional Chinese (zh-TW) translations of the slash-command descriptions — pending
// review by a native speaker. The trailing comment on each line is the English
// source for that entry. Keys are the command's path (see
// commandDescriptionKey in ./catalog.ts); command and option NAMES are not
// localized, only their descriptions.
// Prefer Taiwan music terms such as 待播清單 and 自動續播; omit terminal punctuation.
export const zhTWCommandDescriptions = {
  "birthday": "管理此伺服器用於生日公告的生日資料", // Manages birthdays for this server's announcements.
  "birthday/set": "設定你的生日", // Sets your birthday.
  "birthday/set:month": "生日月份", // Birth month.
  "birthday/set:day": "生日是幾號", // Birth day.
  "birthday/set:user": "改為設定其他成員的生日（僅限機器人管理員）", // Set another member's birthday instead (bot administrators only).
  "birthday/view": "顯示成員的生日", // Shows a member's birthday.
  "birthday/view:user": "要查詢的成員，預設為你自己", // The member to look up; defaults to you.
  "birthday/remove": "移除你的生日", // Removes your birthday.
  "birthday/remove:user": "改為移除其他成員的生日（僅限機器人管理員）", // Remove another member's birthday instead (bot administrators only).
  "birthday/next": "顯示接下來是誰的生日", // Shows whose birthday is coming up next.
  "birthday/next:public": "公開顯示給所有人，而不只是你自己", // Show this to everyone instead of just you.
  "boosts": "顯示伺服器加成紀錄", // Shows server boost history.
  "boosts/history": "顯示成員的加成歷程與累計加成時間", // Shows a member's boost timeline and total time boosted.
  "boosts/history:user": "要查詢的成員，預設為你自己", // The member to look up; defaults to you.
  "boosts/leaderboard": "顯示目前的伺服器加成者，依連續加成時間由長到短排序", // Shows the server's current boosters, longest streak first.
  "boosts/leaderboard:public": "公開顯示給所有人，而不只是你自己", // Show this to everyone instead of just you.
  "clean": "刪除機器人在此頻道最近發送的訊息", // Deletes the bot's recent messages in this channel.
  "clean:count": "要掃描最近幾則訊息（預設 100）", // How many recent messages to scan (default 100).
  "customize": "自訂聊天機器人與你互動的方式；機器人的身分與規則不會改變", // Customize how the chatbot interacts with you specifically. Its identity and rules stay the same.
  "customize/set": "以 Markdown 檔案設定或取代你的自訂內容", // Sets or replaces your customization from a Markdown file.
  "customize/set:file": "描述你希望機器人如何與你互動的 .md 檔案", // A .md file describing how you'd like the bot to interact with you.
  "customize/view": "顯示你在此伺服器目前的自訂內容", // Shows your current customization in this server.
  "customize/clear": "清除你在此伺服器的自訂內容，不影響記憶", // Clears your customization in this server. Does not affect memory.
  "dice": "擲一顆或多顆骰子", // Rolls one or more dice.
  "dice:sides": "每顆骰子的面數（預設 6）", // Number of sides per die (default 6).
  "dice:count": "要擲的骰子數量（預設 1）", // Number of dice to roll (default 1).
  "8ball": "向魔法 8 號球提問", // Ask the magic 8-ball a question.
  "8ball:question": "你想問什麼？", // What do you want to ask?
  "help": "列出可用指令，或顯示單一指令的詳細說明", // Lists available commands, or shows details for one.
  "help:command": "要查看詳細說明的指令名稱", // A command name to view details for.
  "memory": "檢視或清除機器人在聊天中記住的你的資訊", // View or clear what the bot remembers about you from chat.
  "memory/list": "列出機器人在這個伺服器記住的你的資訊", // Lists what the bot remembers about you in this server.
  "memory/forget": "刪除機器人記住的一項關於你的資訊", // Deletes something the bot remembers about you.
  "memory/forget:id": "要刪除的記憶 ID，可從 /memory list 取得", // The memory ID to forget, from /memory list.
  "memory/forget:all": "清除機器人在這個伺服器記住的關於你的所有資訊", // Forget everything the bot remembers about you in this server.
  "memory/notes": "設定機器人是否私訊你聊天時的補充說明", // Controls whether the bot DMs you extra notes about your chat requests.
  "memory/notes:dm": "例如圖片未能附上的情況或回覆遭截斷時，以私訊傳送補充說明；不填則查看目前設定", // Send notes like dropped images or truncated replies as a DM. Omit to check the current setting.
  "owoify": "把句子改寫成 owo 風格", // Transforms a sentence into owo speak.
  "owoify:text": "要 owo 化的句子", // The sentence to owoify.
  "ping": "檢查機器人是否有回應", // Checks whether the bot is responding.
  "qa": "發布包含問題與答案的嵌入訊息", // Posts a question-and-answer embed.
  "qa:question": "問題", // The question.
  "qa:answer": "答案", // The answer.
  "qa:image": "要附加的圖片", // An image to attach.
  "qa:spoiler": "將答案與圖片以劇透方式隱藏", // Hide the answer and image behind a spoiler.
  "quote": "把訊息做成引用卡片", // Turn a message into a quote card.
  "quote:message": "訊息連結，或此頻道中的訊息 ID", // A message link, or a message ID from this channel.
  "reactionroles": "設定身分組選擇選單", // Sets up a role-picker menu.
  "reactionroles/create": "在頻道中發布身分組選擇選單", // Posts a role-picker menu in a channel.
  "reactionroles/create:channel": "發布選單的位置", // Where to post the menu.
  "reactionroles/create:title": "選單標題", // Menu title.
  "reactionroles/create:role1": "成員可以選擇的身分組", // A role members can pick.
  "reactionroles/create:role2": "成員可以選擇的另一個身分組", // Another role members can pick.
  "reactionroles/create:role3": "成員可以選擇的另一個身分組", // Another role members can pick.
  "reactionroles/create:role4": "成員可以選擇的另一個身分組", // Another role members can pick.
  "reactionroles/create:role5": "成員可以選擇的另一個身分組", // Another role members can pick.
  "remind": "管理你的個人提醒", // Manages your personal reminders.
  "remind/set": "設定提醒", // Sets a reminder.
  "remind/set:duration": "例如 30m、2h、1d 或 1d12h", // e.g. 30m, 2h, 1d, or 1d12h.
  "remind/set:message": "要提醒你的內容", // What to remind you about.
  "remind/set:delivery": "提醒的傳送位置（預設：私訊）", // Where to send it (default: DM).
  "remind/list": "列出還沒到時間的提醒", // Lists your pending reminders.
  "remind/cancel": "取消提醒", // Cancels a reminder.
  "remind/cancel:id": "提醒 ID，可從 /remind list 取得", // The reminder id (from /remind list).
  "userinfo": "顯示成員的資訊", // Shows information about a member.
  "userinfo:user": "要查詢的成員，預設為你自己", // The member to look up; defaults to you.
  "vote": "建立投票：預設為是／否，也可以自訂最多五個選項", // Creates a poll: Yes/No by default, or up to five choices of your own.
  "vote:title": "投票標題", // Poll title.
  "vote:description": "成員要投票的內容", // What members are voting on.
  "vote:duration": "投票幾秒後結束；不填則一直開放", // Seconds before the poll closes; omit to keep it open.
  "wolfy": "把句子變成狗叫聲", // Turns a sentence into dog noises.
  "wolfy:text": "要轉換成狗叫聲的句子", // The sentence to translate.
  "diagnostic": "顯示僅限機器人擁有者查看的執行狀態診斷資訊", // Displays owner-only runtime diagnostics.
  "memory-eval": "檢視抽樣的記憶檢索結果，以校準相關性", // Review sampled memory retrievals for relevance calibration.
  "memory-eval/pending": "顯示最新尚未審核的檢索樣本", // Shows the newest unreviewed retrieval sample.
  "memory-eval/label": "標記本應被檢索到的候選項目", // Marks the candidates that should have been retrieved.
  "memory-eval/label:trace": "/memory-eval pending 顯示的追蹤 ID", // Trace ID shown by /memory-eval pending.
  "memory-eval/label:relevant": "以逗號分隔相關候選項目的 ID；若沒有任何相關項目可留空，這也是有效的標記", // Comma-separated candidate IDs that are relevant. Omit if none of them were — that's a valid label.
  "memory-eval/label:split": "資料集分組", // Dataset split.
  "memory-eval/skip": "略過無法使用或有歧義的樣本", // Skips an unusable or ambiguous sample.
  "memory-eval/skip:trace": "/memory-eval pending 顯示的追蹤 ID", // Trace ID shown by /memory-eval pending.
  "memory-eval/export": "下載已審核的案例作為校準資料集", // Downloads reviewed cases as a calibration dataset.
  "fursuit-furtrack": "從 furtrack.com 取得隨機獸裝照片", // Gets a random fursuit photo from furtrack.com.
  "fursuit-furtrack:tag": "要搜尋的標籤（預設：fursuit）", // Tag to search for (default: fursuit).
  "autoplay": "切換是否自動加入相關歌曲接著播放", // Toggles automatic related-track queueing.
  "filters": "為播放套用音訊濾鏡預設", // Applies an audio filter preset to playback.
  "filters:preset": "要套用的濾鏡預設", // The filter preset to apply.
  "loop": "設定播放的重複模式", // Sets the playback repeat mode.
  "loop:mode": "重複模式", // Repeat mode.
  "move": "調整待播歌曲的順序", // Moves a queued track to a different position.
  "move:track": "要移動的歌曲在待播清單中的位置，從 1 開始", // The queue position of the track to move, starting at 1.
  "move:position": "要移到的位置，從 1 開始", // The queue position to move it to, starting at 1.
  "pause": "暫停目前的曲目", // Pauses the current track.
  "play": "播放歌曲，或將其加入待播清單", // Plays a track or adds it to the queue.
  "play:query": "歌曲名稱或支援的網址", // A song name or supported URL.
  "play:channel": "要播放的語音頻道（預設為你目前所在的語音頻道）", // Voice channel to play in (defaults to your current voice channel).
  "playnext": "播放歌曲，或將其排在下一首", // Plays a track or adds it to the front of the queue.
  "playnext:query": "歌曲名稱或支援的網址", // A song name or supported URL.
  "previous": "播放上一首曲目", // Plays the previous track.
  "queue": "查看或管理待播清單", // Views or manages the music queue.
  "queue/show": "顯示待播清單中的歌曲", // Shows queued tracks.
  "queue/remove": "依位置移除待播歌曲", // Removes a queued track by position.
  "queue/remove:position": "歌曲在待播清單中的位置，從 1 開始", // Queue position, starting at 1.
  "queue/clear": "清除所有待播曲目", // Clears every upcoming track.
  "queue/history": "顯示最近播放過的曲目", // Shows recently played tracks.
  "replay": "從頭重新播放目前的曲目", // Restarts the current track from the beginning.
  "resume": "繼續播放已暫停的曲目", // Resumes the paused track.
  "save": "私訊傳送目前播放曲目的連結給你", // DMs you a link to the currently playing track.
  "seek": "跳到目前曲目的指定時間", // Seeks to a specific time in the current track.
  "seek:time": "要跳到的時間，例如 90、1:30 或 1h2m3s", // Time to seek to, e.g. 90, 1:30, or 1h2m3s.
  "shuffle": "隨機打亂待播曲目", // Shuffles upcoming tracks.
  "skip": "跳過目前的曲目", // Skips the current track.
  "skipto": "跳到待播清單中的指定歌曲", // Skips ahead to a specific track in the queue.
  "skipto:position": "歌曲在待播清單中的位置，從 1 開始", // Queue position, starting at 1.
  "stop": "停止播放、清空待播清單並讓機器人離開語音頻道", // Stops playback, clears the queue, and disconnects the bot.
  "247": "切換常駐語音頻道模式", // Toggles persistent voice-channel mode.
  "volume": "設定播放音量", // Sets playback volume.
  "volume:level": "音量百分比", // Volume percentage.
  "setup": "為此伺服器設定機器人", // Configures this server for the bot.
  "setup/initialize": "建立身分組與固定音樂頻道，或沿用既有項目", // Creates or adopts roles and a persistent music channel.
  "setup/initialize:display-name": "此伺服器設定檔使用的顯示名稱", // Display name used by this server profile.
  "setup/initialize:idle-image-url": "沒有播放內容時顯示的固定 HTTPS 圖片網址", // Stable HTTPS image URL shown when nothing is playing.
  "setup/initialize:control-channel": "既有的音樂控制頻道；未指定則自動建立", // Existing music control channel; one is created if omitted.
  "setup/initialize:administrator-role": "既有的機器人管理員身分組；未指定則自動建立", // Existing bot administrator role; one is created if omitted.
  "setup/initialize:music-controller-role": "可使用 /play、管理待播歌曲的指令、面板控制，以及在控制頻道輸入文字點歌的身分組", // Role for /play, queue commands, panel controls, and typed control-channel requests.
  "setup/initialize:restricted-role": "禁止使用音樂與聊天機器人的身分組（機器人擁有者例外）", // Role denied from music and chatbot unless bot-owner bypass applies.
  "setup/guide": "一次一項、私下帶你看過主要設定", // Walks through the main settings one at a time, privately.
  "status": "顯示機器人在此伺服器的設定狀況，包含目前的聊天模型", // Shows how the bot is set up in this server, including the current chat model.
  "bird": "取得隨機鳥類圖片與小知識", // Gets a random bird image and fact.
  "cat": "取得隨機貓咪圖片與小知識", // Gets a random cat image and fact.
  "dog": "取得隨機狗狗圖片與小知識", // Gets a random dog image and fact.
  "fox": "取得隨機狐狸圖片與小知識", // Gets a random fox image and fact.
  "raccoon": "取得隨機浣熊圖片與小知識", // Gets a random raccoon image and fact.
  "boop": "取得隨機戳鼻子圖片", // Gets a random boop image.
  "hold": "取得隨機抱抱圖片", // Gets a random hold image.
  "howl": "取得隨機嗥叫圖片", // Gets a random howl image.
  "hug": "取得隨機擁抱圖片", // Gets a random hug image.
  "kiss": "取得隨機親親圖片", // Gets a random kiss image.
  "lick": "取得隨機舔舔圖片", // Gets a random lick image.
  "bulge": "取得隨機 bulge 圖片（NSFW）", // Gets a random bulge image. NSFW.
  "butts": "取得隨機屁股圖片（NSFW）", // Gets a random butt image. NSFW.
  "e926": "在 e926 上搜尋圖片", // Searches for images on e926.
  "e621": "在 e621 上搜尋圖片", // Searches for images on e621.
  "e926:query": "要搜尋的標籤（例如 wolf、dragon、solo）；留空則隨機取得一則貼文", // Tags to search for (e.g. wolf, dragon, solo). Leave empty for a random post.
  "e926:type": "檔案類型", // File type.
  "e926:order": "排序方式", // Sort order.
  "e621:query": "要搜尋的標籤（例如 wolf、dragon、solo）；留空則隨機取得一則貼文", // Tags to search for (e.g. wolf, dragon, solo). Leave empty for a random post.
  "e621:type": "檔案類型", // File type.
  "e621:order": "排序方式", // Sort order.
  "vote:option1": "選項 1；至少提供兩個選項，或全部留空以使用是／否", // Choice 1; give at least two choices, or none for Yes/No.
  "vote:option2": "選項 2；至少提供兩個選項，或全部留空以使用是／否", // Choice 2; give at least two choices, or none for Yes/No.
  "vote:option3": "選項 3；至少提供兩個選項，或全部留空以使用是／否", // Choice 3; give at least two choices, or none for Yes/No.
  "vote:option4": "選項 4；至少提供兩個選項，或全部留空以使用是／否", // Choice 4; give at least two choices, or none for Yes/No.
  "vote:option5": "選項 5；至少提供兩個選項，或全部留空以使用是／否", // Choice 5; give at least two choices, or none for Yes/No.
  "dnd": "進行由 AI 主持的 D&D 團務", // Runs AI-hosted D&D campaigns.
  "dnd/setup": "設定這個伺服器的 D&D，並把這個頻道當作總覽頻道", // Sets this server up for D&D games and makes this channel the hub.
  "dnd/setup:hub": "總覽頻道（預設為目前的頻道）", // The hub channel (default: this one).
  "dnd/new": "建立新團務與專屬頻道", // Creates a new game with its own channels.
  "dnd/new:name": "團務名稱", // The game's name.
  "dnd/new:language": "遊玩語言（預設：English）", // The language the game is played in (default: English).
  "dnd/new:pacing": "回合節奏（預設：即時）", // How fast rounds go (default: live).
  "dnd/new:players": "桌上最多玩家數（預設 3）", // Most players at the table (default: 3).
  "dnd/status": "顯示這個頻道團務的狀態", // Shows the state of this channel's game.
  "dnd/pause": "暫停這場團務（主辦人）", // Pauses this game (organizer).
  "dnd/resume": "繼續已暫停的團務（主辦人）", // Resumes a paused game (organizer).
  "dnd/close-round": "不再等待，直接結束這一回合的收件（主辦人）", // Closes the current round without waiting (organizer).
  "dnd/rest": "讓隊伍在戰鬥之間休息（主辦人）", // Has the party take a rest between fights (organizer).
  "dnd/rest:type": "休息的長度", // How long the rest is.
  "dnd/retry": "請地下城主重新結算被擱置的回合（主辦人）", // Asks the DM to try the held round again (organizer).
  "dnd/repair": "檢查這場團務的頻道並重新繪製卡片（主辦人）", // Checks this game's channels and redraws its cards (organizer).
} as const satisfies CommandDescriptionCatalog<keyof typeof jaCommandDescriptions>;
