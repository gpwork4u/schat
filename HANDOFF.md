# Slack-for-Google-Chat — Handoff

本地跑一個**高度仿 Slack** 的前端來操作 Google Chat。本文件給接手者（或未來的自己）快速掌握全貌。最後更新：2026-06-05。

---

## 1. 一句話描述

**「Google Chat 官方網頁的遙控器 + 換皮」**，不是獨立 client。
所有讀寫都是從一個**開著且已登入的 `chat.google.com` 分頁**裡、以你本人身分發出的 fetch/XHR。
沒有自己的後端、沒有 API key、沒有 OAuth —— 完全搭你既有的 Google Chat web session 便車。

---

## 2. 架構

```
web/ (localhost:5173, Vite+React)
  └ window.postMessage {__sg}            ↕
extension/app-bridge.js (注入 localhost)
  └ chrome.runtime port 'sg-app'         ↕
extension/background.js (hub：找 chat 分頁、轉送、廣播事件)
  └ chrome.tabs.sendMessage              ↕
extension/content.js (chat.google.com, isolated world, 純 relay)
  └ window.postMessage                   ↕
extension/inject-main.js (chat.google.com, MAIN world) ★唯一碰 Google Chat 私有協定處
  └ fetch/XHR → https://chat.google.com/u/0/api/...
```

- **RPC 流向**：app `call(op,args)` → bridge → background → content → inject-main `handleOp` → 原路回。
- **事件流向**：inject-main `emitEvent` → content → background 廣播 → 所有 app → `on(event)`。
- **為何一定要在 chat.google.com origin 內發**：mutation 端點檢查 Chrome native 注入的 anti-abuse 簽章（`x-browser-validation`，per-request、JS 攔不到）。後端直接打會 401。那個分頁就是執行器，**必須一直開著且登入**。

---

## 3. 啟動

```bash
cd web && npm install && npm run dev      # → localhost:5173（含 emoji-mart / lucide-react）
```
1. `chrome://extensions` → 開發者模式 → 載入未封裝 → 選 `extension/`
2. 開 `https://chat.google.com/` 登入並**點開任一對話**（讓 inject-main 攔到 xsrf）
3. 開 `localhost:5173`

> **改 `web/*`** → HMR 自動生效。**改 `extension/*`** → `chrome://extensions` 按 ↻ + chat 分頁 `Cmd+Shift+R`（重注入 inject-main）。

---

## 4. 已完成功能

| 功能 | 端點 / 機制 | 備註 |
|------|------|------|
| 頻道 + DM 列表 | `/api/paginated_world` | **首頁同步即回 + 背景走完分頁（每 session 一次）**；union 自 `spacesById` |
| 自訂 section 分類 | `paginated_world` `root[0][1]` | 被動累積（見坑） |
| 讀訊息 | `/api/list_topics` | `req[3][4][0]` as-of 錨點設 now |
| **討論串顯示** | 依 `threadKey`(=topic 字串 id) 分組 | 主列 root + 「N 則回覆」→ 右側 ThreadPanel |
| 送新訊息 / 討論串回覆 | `/api/create_topic` / `/api/create_message` | 回應 echo 真實訊息回填 |
| **@mention** | annotation type 6 放 `payload[2]` | 候選來自 `list_members`（發言者快取）；composer/thread 有 @ 自動完成；收到的高亮 |
| 完整 Slack 風 emoji 選單 | `emoji-mart` + custom emoji | portal 定位不被裁切 |
| **完整自訂 emoji** | 分頁 batchexecute `Gq6Wmd`（browse all）+ qL7xZc/IDB fallback | 見「自訂 emoji」 |
| Emoji reaction（含自訂）+ **取消（toggle）** | `/api/update_reaction`（add=1/remove=2）| 點自己按過的 chip 取消；樂觀 delta（pending）抗輪詢回跳 |
| reaction hover | chip `title` 顯示 emoji+人數+含你 | **人名**待接（見待辦：Q3DB7e）|
| **收到的圖片** | annotation type 13 → `resolve_attachment` → `get_attachment_url` | 回**公開圖片 URL**（非 base64）；快取 key=`messageId#index`（token 會輪替）|
| 貼上圖片送出 | `/uploads` resumable → create_topic 附件 | composer Cmd+V |
| Markdown | **框內即時 WYSIWYG**（`RichComposerInput`）+ 訊息渲染（`richtext.tsx`）| `*粗* _斜_ ~刪~ \`code\` \`\`\`block\`\`\``、連結、list、@mention |
| **清單自動接續** | composer Enter：清單內接續下一項（有序自動 +1）、空項目跳出 | `1.`/`-`/`*`；送出為原文，GChat 自渲染 |
| **多行 code block** | composer 在未閉合 ```` ``` ```` 內 Enter＝換行（不送出）| 送出 `payload[1]` 為含換行原文（與 native 一致）|
| **刪除訊息** | hover 工具列垃圾桶（僅自己訊息，`m.senderId===myUserId`）| `delete_message`；樂觀移除 |
| 深/淺色主題 | CSS 變數 + `documentElement.dataset.theme` | rail 上方切換鈕；localStorage |
| lucide icon | 控制鈕全換 icon | reaction/內文 emoji 不動 |
| 頭像 | `m[1][2]` + `avatarById` 快取；fallback 用 React state | |
| **新訊息通知** | 前端 `message` 事件 → Notification API + Web Audio 合成提示音（`notify.ts`） | rail 鈴鐺切換（localStorage `sg-notify`）；過濾自己（`session.myUserId`）；只在非作用中頻道或分頁未聚焦時響；點通知跳該頻道。**限制**：webchannel 只發 `activity`（無內文）的訊息不會通知，靠輪詢補載 |

---

## 5. 尚未做 / 待辦

- **reaction hover 顯示「哪些人」按了**（✅ 已實作，request 結構自真實 traffic 逆向確定；待 UI 點測）：
  - **`Q3DB7e`** request（webRequest source 撈到真實 6 筆，DM+space 都有）：
    ```
    inner = [ [msgId,null,[msgId,null,GROUPREF]], emojiSeg, 10 ]
      msgId    = opaque m[0][1]（非數字！如 "AbCdEf01_Xy"）
      GROUPREF = DM ["dm/<id>","<id>",5] / space ["space/<id>","<id>",2]
      emojiSeg = ["👍"] | [null,[uuid,…]]（同 react payload[1]）
    ```
    response `inner[0]`=`[[uid,"human/uid",0],…]`=reactor 清單。
  - op **`get_reactors`**（`{spaceKey,messageId,emoji}`→`{reactors:[{userId,name}]}`）**完全 deterministic 構造**，不靠攔 template。`at`+URL 取自任一 DynamiteWebUi batchexecute（qL7xZc startup 就有）→ `state.batchAt`/`batchUrl`；`dump_reactor_rpc` 回 `{hasBatchAt,batchUrl}` 診斷。
  - 名字：先查 `state.userNames`（發言過的人），**缺的用 `/api/get_members` 補**（`resolveUserNames`，per-uid 查、限量 30、結果存回 `userNames`/`avatarById`）；查不到才 fallback「使用者」。
  - 前端：`MessageRow` chip 移除原生 `title`，`onMouseEnter` 延遲 300ms lazy fetch + portal `.reactor-tip`（per-emoji 快取於 row state）。
  - **點測**：reload extension + chat 分頁 `Cmd+Shift+R`，到 `localhost:5173` hover reaction chip → 應顯示「A、B 用 👍 回應」。
- ~~**定時訊息**~~ ✅ 含建立 / 列出 / 取消 / 改時間：
  - `schedule_message {spaceKey,text,whenMs}` → create_unsent_message（回 `clientId`）；composer「排程」鈕。
  - `list_scheduled {spaceKey}` → list_unsent_messages，解析 `parsed[1]`（記錄陣列，空時為 null）。**已用非空樣本驗證**：record=`[[clientId,groupRef],[sec,ns],[sec,ns],text,null,null,1,[[schedSec],1],""]`。
  - `cancel_scheduled {spaceKey,clientId}` → delete_unsent_message `[footer,[clientId,ref]]`。
  - `reschedule_message {spaceKey,clientId,whenMs}` → update_unsent_message `[footer,[[clientId,ref],null×6,[[sec]]],[[[8,[null,[1]]]]]]`（field-8 mask=時間）。
  - 前端：composer 採 **Slack 風 split send button**（主鈕「傳送」+ 箭頭下拉：明天 9:00 / 下週一 9:00 / 自訂…）；自訂時間用 **shadcn 風 `DateTimePicker`**（月曆 + time input）。**獨立頁面 `ScheduledView`**（sidebar「已排程訊息」進入）列出**所有頻道**排程，可改時間（同 DateTimePicker）/取消/前往頻道。`list_scheduled` 不帶 spaceKey 即回全部。**排程時間 epoch 秒**；clientId 為 client 端 randomKey，create/update 回應與 webchannel 會 echo。
- ~~**新增 channel**~~ ✅ op `create_space {name}` → `/api/create_group`（payload[0]=[name,…,[[1]],[],…,4,…]、[2]=randomKey、[5]=9、[7]=[null,16,…,1000,20,[]]、[99]=footer）；回新 spaceId。前端 sidebar「＋」鈕（prompt 名稱→建立→reload→開啟）。
- ~~**新增 emoji**~~ ✅ op `create_emoji {shortcode,base64,filename,contentType}`：① `POST /uploads?upload_type=CUSTOM_EMOJI`（resumable，finalize 回 protobuf field1=uploadToken/field2=blobToken）② batchexecute `bOib7c` inner=`[null,":sc:",[uploadToken,blobToken,filename,ct]]`。前端 sidebar emoji 鈕（隱藏 file input→prompt 代碼→建立→reload emoji）。
- **訊息全文搜尋**（目前只過濾頻道名）。
- ~~**分頁載入更舊歷史**~~ ✅ 已做：op `load_older_messages {spaceKey,beforeTs(µs)}` 把 `list_topics` 的 anchor（`req[3][4][0]`，也設 req[8]/[9]）改成最舊訊息 ts；前端「載入更早訊息」鈕 prepend+dedupe+排序。
- **收到的非圖片附件**（PDF 等只顯示檔名）。
- **內文 `:shortcode:` 自訂 emoji 圖**（reaction/picker 已顯示圖，內文仍文字）。

---

## 6. Google Chat 私有 API 重點

- `/api/<name>` 皆 POST，body 是 JSPB 巢狀陣列（位置非 key），回應前綴 `)]}'` 要去掉。
- **⚠️ `dfe.*` 類回應是雙層包**：`[[ "dfe.x.y", <payload…> ]]`——真正內容在 `parsed[0]`，不是 `parsed[0]` 以外。例：`list_unsent_messages` 記錄在 `parsed[0][1]`、`create_group` 的 spaceId 在 `parsed[0][1][0][0][0]`。（曾因讀成 `parsed[1]` 導致排程清單全空、新頻道無 id。）
- **code block = type-8 formatting annotation（非原文反引號！）**：現行 client 送 code block 時，body **去掉 ```` ``` ````**，改在 `m[10]` 加 `[8, start, len, null,null,null,null, [7]]`（type 8=formatting、`[7]`=code block）。送原文反引號會 render 錯。⇒ 送出 `transformOutgoing()` 把 ```` ```…``` ```` 轉成「去 fence body + type-8[7]」並校正 mention offset；接收 `applyFormatAnnotations()` 反向把 type-8[7] 在 body 補回 ```` ``` ```` 給 `richtext.tsx` 渲染。**只確認 [7]=code block**；粗體/斜體/刪除線/inline code 的格式碼尚無樣本（未知碼維持純文字/原文 markdown）。
- **`/api/delete_message`**：payload[0]=`[[null,null,null,[null,messageId,ref]],messageId]`（同 react/update_reaction），payload[99]=footer。只能刪自己的訊息。
- **群組 ref**：space=`[[id]]`、DM=`[null,null,[dmId]]`，從 `paginated_world` `item[0]` 原樣取。
- **訊息 record**（list_topics/webchannel/create 共用）：`m[0][1]`=msgId、`m[1]`=`[[senderId],全名,頭像,email,…]`、`m[2]`=μs、`m[9]`=內文、`m[10]`=**annotations**、`m[20]`=reactions。
- **`m[10]` 是 annotations**（非附件）：`a[0]`=type。**6**=@mention `[6,start,len,null,[[uid],3,[[uid],email]],…,3]`；**13**=圖片/檔案 `a[9][0]`=blob token、`a[9][2]`=檔名、`a[9][3]`=ct、`a[9][4]`=`[w,h]`。
- **thread/topic id 用字串 `topic[0][1]`**（也在 `m[0][0][3][1]`），**不是**數字 `topic[1]`（那是時間戳，拿去回覆會 500）。
- **reaction record** `[emojiSeg,count,mineBool,ts]`——**不含 reactor**；custom seg=`[null,[uuid,null,":sc:",…,blob@8,…,url@10]]`、unicode=`["👍"]`。
- **收圖**：`GET /api/get_attachment_url?url_type=FIFE_URL&content_type=<ct>&attachment_token=<a[9][0]>&allow_caching=true&sz=w512` → 公開 googleusercontent URL（`no-referrer` 可直連）。**attachment token 每次輪詢都不同**，故前端快取 key 用 `messageId#index`。
- **自訂 emoji（完整）**：真正「列全部」是分頁 batchexecute **`Gq6Wmd`**（`/api/list_custom_emojis` 對我們一律 400；qL7xZc 只回 ~36 recent 子集）。
  - request：page1=`[[[2,[[1]],1],[3,[[1]],1]],72]`；續頁=`[null,72,<cursor>,null,<token>]`（token=page1 resp[3]，常數如 `CKnLihY=`）。
  - **cursor 是 protobuf**，可 byte 級重現＝`base64(PREFIX + 0x24 + uuid(36) + 0x20 + varint(ts))`，PREFIX=`12 09 08 03 12 03 0a 01 01 18 01 1a`，uuid/ts 取自**前一頁最後一個 emoji**（`entry[0]`/`entry[6]`）。回 <72 筆即最後一頁。
  - entry（len 10）：`[uuid,null,":sc:",1,[uid,…],[localId],ts@6,blob@7,null,url@9]`——**url 在 [9]**（frecent/qL7xZc 是 [10]，故另寫 `ingestBrowseEmoji`）。
  - `emojiSearch`=`DpMroe`（`[":query",[1,2],40]`），非列全部。
- xsrf 從任一 `/api/` 請求學（`x-framework-xsrf-token`）。
- **`/api/create_group`**（新增 space）：payload[0]=`[name,null×7,[[1]],[],null,null,4,null,0,null,0]`、[2]=client req id（randomKey）、[3]=0、[5]=9、[7]=`[null,16,null,null,null,1000,20,[]]`、[99]=footer。回 `["dfe.g.cg",[[[spaceId]],name,…]]`。
- **建立 custom emoji**：① `POST /uploads?upload_type=CUSTOM_EMOJI`（同 attachment 的 resumable start→upload,finalize；finalize 回 base64 protobuf：field1=uploadToken、field2=blobToken）② batchexecute **`bOib7c`** inner=`[null,":sc:",[uploadToken,blobToken,filename,ct]]`，回新 emoji record（無 url，reload 後才有圖）。
- **排程訊息（unsent）** —— **時間皆 epoch 秒**，`clientId`=client 端 randomKey：
  - create `/api/create_unsent_message`：`[footer,[[clientId,groupRef],null,null,text,null,null,1,[[sec]],""]]` → `["dfe.rs.cum",record,[id,id]]`。
  - delete `/api/delete_unsent_message`：`[footer,[clientId,groupRef]]` → `["dfe.rs.dum",[id,id]]`。
  - update `/api/update_unsent_message`：`[footer,[[clientId,groupRef],null×6,[[sec]]],[[[8,[null,[1]]]]]]`（[2]=field mask，8=時間）→ `["dfe.rs.uum",record,…]`。
  - list `/api/list_unsent_messages`：`[footer,[],[null,null,1,null,1]]` → `["dfe.rs.lum",<records|null>,[token]]`（[1]=記錄陣列，空時 null）。
  - record：`[[clientId,groupRef],[sec,ns],[sec,ns],text,…,[[schedSec],?],""]`。clientId 也經 webchannel echo。
- **`/api/get_members`**：userId→名字/頭像（解析 reactor 等非發言者）。`payload[1]=[[[[uid,1]]]]`（單人）、`payload[99]`=footer；response 含 member 節點 `[[[uid,1]], "名字", "avatarUrl", …]`。多人巢狀未確認 → 目前 per-uid 查。
- **batchexecute（`/_/DynamiteWebUi/data/batchexecute`）**：form body `f.req=[[[rpcid,<inner-json-str>,null,"generic"]]]&at=<token>`；`at` 同 session 跨所有 rpc 共用。**reactor 列表 = `Q3DB7e`**：inner=`[[msgId,null,[msgId,null,GROUPREF]],emojiSeg,10]`，GROUPREF=DM`["dm/<id>","<id>",5]`/space`["space/<id>","<id>",2]`（注意跟 `/api` 的 ref 格式不同）；msgId 用 **opaque** `m[0][1]`（非數字 ts）。response `inner[0]`=`[[uid,"human/uid",0],…]`。

### ★ 最棘手的坑：自訂 section 分類
1. 一般清單（root[0][2] 鏈）**排除**被歸 section 的空間；那些只在 section 鏈 / 被動 sync。
2. section 在 `root[0][1]`：`e[1][1]`=順序、`e[1][2]`=名稱、`e[2]`=成員。
3. section 成員是「一次性 delta」：native 啟動同步消費掉後，我 app 再要回 0 → **被動攔截** native 同步回應累積進 `spacesById`/`sectionAcc`。
4. page size 必須 30（開大會丟 section 區塊）。

### 其他坑
- `list_topics` 複用 template 時 `req[3][4][0]` 必設 now，否則只看到舊訊息。
- `update_reaction` `payload[0]` ref 要符合對話類型（DM `[null,null,[id]]`）。
- 別讓自己發的請求污染 template / 觸發 sections-updated 洪流（silent 旗標 + debounce）。

---

## 7. 效能 / 體感重點

- **首載慢的兩主因**：① `waitForRequestHeaders` 最多等 30s（chat 分頁沒發 /api/ 前拿不到 xsrf → 先點開對話）；② 舊 listSpaces 串行 20 分頁 → 已改首頁即回 + 背景。
- **圖片閃動**：根因 = attachment token 每輪輪替 → 快取 miss → 重解析循環。修法 = 穩定 key `messageId#index` + `reconcile()`（`msgSig` 重用未變物件 identity）+ `React.memo(MessageRow)`。
- **reaction 數字跳動**：樂觀 delta 存 `pendingReactionsRef`（emoji→{delta,exp}），`applyPending` 在 reconcile 疊加直到 server 回應，避免輪詢回跳。
- **WYSIWYG 游標消失**：曾因每鍵重建 innerHTML。改成**只在格式相關字元/刪除/換行時才重渲染**，純打字交給瀏覽器原生 caret；IME 期間（compositionstart/end）不重渲染。

---

## 8. Op 一覽（inject-main `handleOp`）

| op | args | 回傳 |
|----|------|------|
| `session_status` | — | 診斷狀態 |
| `list_emojis` | — | `{custom, customUrlByShortcode}`（frecent 快取）|
| `load_all_custom_emojis` | — | 分頁 `Gq6Wmd` browse all + qL7xZc/IDB fallback，回 `{custom, …, browseAdded, browsePages, rpcAdded, idbDbs}` |
| `dump_idb` | — | IDB DB/store 診斷 |
| `list_members` | — | `{members:[{userId,name,avatar,email}]}` |
| `list_spaces` | — | `{spaces, sections}` |
| `load_space_messages` | `{spaceKey}` | `{messages, topicCount}` |
| `load_older_messages` | `{spaceKey,beforeTs}` | `{messages, topicCount, older}`（list_topics anchor=beforeTs µs）|
| `create_space` | `{name}` | `{ok, spaceId, spaceKey, name}`（`/api/create_group`）|
| `create_emoji` | `{shortcode,base64,filename,contentType}` | `{ok, shortcode}`（CUSTOM_EMOJI upload + `bOib7c`）|
| `delete_message` | `{spaceKey,messageId}` | `{ok}`（`/api/delete_message`，payload[0] 同 react）|
| `schedule_message` | `{spaceKey,text,whenMs}` | `{ok, clientId, scheduledSec}`（create_unsent_message，時間 epoch 秒）|
| `list_scheduled` | `{spaceKey}` | `{scheduled:[{clientId,spaceKey,text,scheduledSec}]}`（list_unsent_messages）|
| `cancel_scheduled` | `{spaceKey,clientId}` | `{ok}`（delete_unsent_message）|
| `reschedule_message` | `{spaceKey,clientId,whenMs}` | `{ok, scheduledSec}`（update_unsent_message）|
| `send_message` | `{spaceKey,text,threadKey?,sendMode,mentions?}` | `{ok,message}` |
| `send_image` | `{spaceKey,threadKey?,base64,filename,contentType,caption}` | `{ok,message}` |
| `react` | `{spaceKey,messageId,emoji,action:'add'\|'remove'}` | `{ok}` |
| `get_reactors` | `{spaceKey,messageId,emoji}` | `{reactors:[{userId,name}]}`（deterministic 構造 Q3DB7e batchexecute）|
| `dump_reactor_rpc` | — | `{hasBatchAt,batchUrl,capturedQ3DB7e}`（診斷能否發 Q3DB7e）|
| `resolve_attachment` | `{token,contentType,size?}` | `{url}`（圖片 token→公開 URL，快取）|
背景層另有 `ping` / `open_chat_tab`。事件：`session-ready`/`sections-updated`/`emoji-rpc-ready`/`activity`/`message`。

---

## 9. 檔案地圖

```
extension/
  manifest.json     MV3
  background.js     hub：port ↔ chat 分頁；廣播事件
  content.js        chat.google.com relay
  inject-main.js    ★核心：wire-format、被動攔截(template/section/emoji-rpc/reactor-rpc)、op 實作
  app-bridge.js     注入 localhost，橋接
  popup.html/js     狀態 + 快捷開分頁
web/src/
  App.tsx           狀態/版面/連線/輪詢/事件/reconcile/pending reactions/主題
  bridge.ts         postMessage RPC client（dir 過濾）
  components/
    Sidebar         分類頻道列表 + 新增頻道/emoji + 「已排程訊息」導覽
    MessageList     thread 分組（buildThreads useMemo）
    MessageRow      單則訊息（React.memo）：reaction(toggle+hover reactor tooltip)/圖/回覆數/emoji picker(portal)/頭像 fallback
    ThreadPanel     右側討論串 + 回覆
    EmojiPicker     emoji-mart 包裝（含 custom + 主題）
    RichComposerInput  框內 WYSIWYG markdown 編輯器（contenteditable + @mention）
    Composer        包 RichComposerInput + 貼圖 + Slack 風 split send button（排程選單）
    DateTimePicker  shadcn 風 月曆 + time input（排程用，可重用）
    ScheduledView   已排程訊息頁面（跨頻道列表 + 改時間/取消/前往）
  richtext.tsx      訊息 markdown / 連結 / @mention 高亮 / list 渲染
  types.ts util.ts
docs/google-chat-api.md   逐欄位 API 筆記
```

---

## 10. Debug 工作流（這專案靠它逆向）

用 **Web Log Capture**（`~/project/web-log/`）+ collector（`127.0.0.1:9999`）抓 chat.google.com 流量：
```bash
cd ~/project/web-log/collector && node server.js
curl -s 127.0.0.1:9999/status | jq .
curl -s '127.0.0.1:9999/events?path=/api/list_topics&source=debugger&summary=0&limit=5'
```
- **兩種來源、互補**（之前誤記「request body 不會被錄」，其實有）：
  - `source=debugger`（DevTools Protocol）→ 有 **response** body，無 request body。
  - `source` 為空（webRequest API）→ 有 **request body**（`requestBody.formData` / `.raw`）、`requestHeaders`、`method`，無 response body。
  - ⇒ 要看請求參數：撈**同一個 URL** 的 webRequest 事件（`e.source===null`）讀 `requestBody`。batchexecute 的 `f.req`/`at` 就是這樣拿到的（如 Q3DB7e reactor 結構）。
  ```bash
  # 撈某 rpc 的 request body（webRequest source）
  curl -s '127.0.0.1:9999/events?summary=0&limit=3000' | python3 -c "import sys,json;e=[x for x in json.load(sys.stdin) if 'Q3DB7e' in (x.get('url') or '') and x.get('source') is None];print(json.dumps(e[0]['requestBody'],ensure_ascii=False))"
  ```
- 心法：用看得到的字串（頻道名、shortcode）去 grep response body，秒定位 JSON 路徑。
- 前端 Console 打 op（過濾 `dir==='from-ext'`）：
```js
(()=>{const id='x'+Math.random();addEventListener('message',function h(e){if(e.data&&e.data.__sg&&e.data.dir==='from-ext'&&e.data.reqId===id){removeEventListener('message',h);console.log(JSON.stringify(e.data.data));}});window.postMessage({__sg:true,dir:'to-ext',reqId:id,op:'session_status',args:{}},location.origin);})();
```

---

## 11. 心智模型

- 把它想成 **Google Chat 網頁的代理層**：React UI 只發 op，真正幹活的是被注入原生網頁的 `inject-main.js`。
- 拿不到資料時先問：**native 怎麼拿的？**（Web Log Capture 看）→ 複製請求或被動攔截回應。
- 權限/身分/速率 = 跟你本人在原生網頁一模一樣。
