# Google Chat（Dynamite）Web 私有 API 欄位筆記

以 Web Log Capture 抓**現行 Google Chat web client 真實流量**反推、並用回應離線驗證。
所有 `/api/<name>` 都是 `POST`，body 是一個 JSPB 風格的巢狀陣列（用位置而非 key），
回應前綴 `)]}'` 要先去掉再 `JSON.parse`。送出主機 = `https://chat.google.com/u/<N>/...`。

## 共通元素

- **帳號 base**：`/u/0`、`/u/1`…（多帳號）。URL `?c=<n>` 是遞增的 client request counter。
- **必要 header**：`X-Framework-Xsrf-Token`（從任一 `/api/` 請求學到）、`Content-Type: application/json`、
  寫操作另帶 `X-Goog-Chat-Space-Id: <spaceId>`、`X-Goog-Ext-353267353-Bin`（mutation 用的 client flag blob）。
- **footer（每個 request body 最後一個元素）**：`[<reqId>, 3, 1, "en", [<prefs 67 格>]]`。
  - `reqId`：寫操作（create_topic/message）用隨機大整數字串；讀操作多為 `0`。
  - 中間 `3,1,"en"` 大致固定；`prefs` 是 client 能力旗標陣列（照抄即可）。
- **群組 ref（最重要）**：識別一個 space / DM 的結構，幾乎每支 API 都要：
  - Space（房間）：`[["AAQAxxxx"]]`
  - DM（私訊）：`[null, null, ["xxxxAAAAE"]]`
  - 從 `paginated_world` 的 `item[0]` 直接拿，原封不動沿用最保險。
- **時間戳**：一律**微秒**字串（μs）。轉毫秒 `/1000`。

---

## `/api/paginated_world` — 列出所有 space / DM + 自訂分類

### Request
```
[
  [0,3,1,"en",[prefs]],                         // [0] footer 樣式的 client prefs
  [[30, null, null, [capsArray], null, <token|null>]],  // [1] 抓取設定：[0]=每頁筆數(30)；[5]=continuation token（null=第一頁）
  null,                                          // [2]
  [4,2,5,6,7,3],                                 // [3] 要回傳的 world section 種類
  null,null,null,null,                           // [4..7]
  0                                              // [8]
]
```
- **分頁**：回應 `root[0][2]` 是下一頁 token，塞回 `req[1][0][5]` 再打一次，直到沒有新項目。

### Response（tag `dfe.w.pw`）
```
root[0][1] = [ dfe.w.ws 描述子... ]   // ← 自訂分類（section）在這
root[0][2] = "<下一頁 token>"
root[0][4] = [ world item, ... ]      // ← 所有 space / DM
```

**world item（`root[0][4][i]`）**：
| 索引 | 意義 |
|---|---|
| `item[0]` | group ref（space `[[id]]` / DM `[null,null,[dmId]]`）|
| `item[3][0][0][0]` | **自己的 user id**（viewer membership）|
| `item[4]` | space 名稱字串；DM 為 `null` |
| `item[31]` | 成員清單 `[[ [[id],"全名","頭像","email",…], … ]]` |
| `item[35]` | `[[6,"SPACE"]]` 表房間；DM 為 null |
| `item[37]` | `[0,9]`=DM、`[0,0]`/`[0,3]`=space 等型別碼 |
- DM 沒有 `item[4]`，名稱要從 `item[31]` 成員取「非自己」那位。

**自訂 section（`root[0][1]` 的 `dfe.w.ws` 陣列）**：
```
ws[9] = [ section entry, ... ]
section entry = [ <token|null>, meta, members, false ]
  meta    = [ [type,[4,sectionId],sectionId], "<order 0..9>", "<名稱>", ...flags ]
  members = [ [[spaceId]], [[spaceId]], ... ]   // 該 section 底下的 space（分散在多個 ws，要累加）
```
- `meta[1]`=順序、`meta[2]`=名稱（系統 bucket 0/2/8/9 無名稱）。
- 成員只出現在帶 `[5]` marker 的 ws；名稱在帶 `[3]` marker 的 ws。跨所有 ws 合併。

---

## `/api/list_topics` — 載入某 space 的訊息（含歷史）

### Request（長度 100，footer 在 `[99]`）
| 索引 | 意義 |
|---|---|
| `[1]` | 要回幾個 topic（32 / 40）|
| `[3]` | `[null,null,null,null,[<anchorTs μs>]]` — **`[3][4][0]` 是 as-of 錨點**：回傳「≤ 此時間」的最新 topic。**要看最新就設成現在**（凍結舊值會只看到舊訊息）|
| `[4]` | `[3,1,4]` 選項/欄位遮罩 |
| `[5]` | `1000`（每 topic 最多訊息數上限）|
| `[6]` | `20` |
| `[7]` | **group ref** |
| `[8]` | `[<μs>]` world head（≈now）|
| `[9]` | `[<μs>]` last-read 標記 |
| `[10]` | `2`（模式/方向）|

### Response（tag `dfe.t.lt`）
```
root[0][1] = [ topic, ... ]
topic[1]   = topicId（thread key）
topic[6]   = [ message, ... ]
```

**message record**（`topic[6][j]`，與 webchannel frame、create_topic 回應共用）。
經全 buffer 2370 則訊息掃描，所有出現過的非空欄位：
| 索引 | 意義 |
|---|---|
| `m[0]` | handle `[[null,null,null,[null, msgId, <groupRef>]], msgId]` → `m[0][1]`=msgId。groupRef 用 `groupIdFromRef()` 取 spaceId（space `[[id]]` / DM `[null,null,[id]]`）|
| `m[1]` | `[[senderId], "全名", "頭像url", "email", "短名", …]` |
| `m[2]` | 建立時間（μs）|
| `m[3]` | 修改時間（μs）|
| `m[9]` | **內文**（純文字）|
| `m[10]` | **附件**（圖片/檔案）：`[[13,0,0,…,"image.png…",[blobId…]]]`（尚未在 UI 顯示）|
| `m[13]` | msgId（重複）|
| `m[17]` | `[1]` |
| `m[19]` | `1` |
| `m[20]` | **reactions**：`[ [emojiSeg, count, 我按過?bool, ts], … ]`；emojiSeg unicode=`["👍"]`、custom=`[null,[uuid,null,":shortcode:",1,[reactorId],[localId],null,ts,"blob"]]` |
| `m[23]/m[24]` | `2`（旗標）|
| `m[27]` | `1` |
| `m[33]` | `true`（少數，疑似已編輯旗標）|
| `m[29]` | 附件/引用相關（含 spaceId、原始 msg ref）|
| `m[38]` | sender id（重複）|

---

## `/api/catch_up_group` / `catch_up_user` — 增量補抓（自上次後的新訊息）

### Request
```
catch_up_group: [ [[spaceId]], [<sinceTs μs>], 500, 500, [6], …, footer ]
catch_up_user:  [ [<sinceTs μs>], 2000, 2000, [6], …, footer ]
```
- `[1]`（group）/`[0]`（user）= 「從這個時間之後」；`500/2000` 為頁大小。
- 回應 tag `dfe.cu.cu`；**沒有新東西時回 `[[ "dfe.cu.cu", null, 1, [1] ]]`（幾乎空）**。
- 適合「即時補洞」，不適合初次載入歷史（初次載入用 `list_topics`）。

---

## `/api/create_topic` — 送新訊息（開新 thread）

### Request（長度 100，footer 在 `[99]`）
```
[ null, "<內文>", null, null, [[spaceId]], [1], "<隨機 threadKey>", 1, [1], …null…, footer ]
   [0]    [1]                  [4]=ref      [5]   [6]              [7] [8]
```
- 回應 tag `dfe.t.ct`，**echo 回剛建立的完整 message record**（可直接解析拿到真實 msgId/時間）。

## `/api/create_message` — 在既有 thread 回覆

### Request
```
[ [null,null,null,[null, "<threadKey>", [[spaceId]]]], "<內文>", null,null,null, "<隨機 msgKey>", [1], [1], …, footer ]
     [0] = 目標 thread                                    [1]                      [5]            [6]  [7]
```

## `/api/update_reaction` — 加 / 移除 emoji reaction

### Request
```
[
  [[null,null,null,[null, "<msgId>", [[spaceId]]]], "<msgId>"],   // [0] 目標訊息
  <emoji 段>,                                                     // [1]
  <1=add | 2=remove>,                                             // [2]
  …null…, footer                                                  // [99]
]
```
- emoji 段：
  - custom：`[null, [uuid, null, ":shortcode:", 1, [userId], [localId], null, ts, "blob"]]`
  - unicode：`[ "👍" ]`
- custom emoji 的 uuid/blob/userId 等需先從 `get_frecent_emojis_v2` 取得（catalog）。

## `/api/create_unsent_message` — 定時 / 排程訊息（尚未實作）

`list_unsent_messages` 列出已排程未送的；`create_unsent_message` 建立排程。欄位待抓。

---

## `/api/get_frecent_emojis_v2` — emoji catalog

回應 `root[0][1]` = emoji 陣列。每筆：
- custom：`[null, [uuid, null, ":shortcode:", …, [userId], [localId], null, ts, "blob"]]`
- unicode：`[["👍", [":thumbsup:", …aliases]], …]`
- 建出 shortcode/unicode → 完整 reaction 段所需資料的對照表。

---

## `/webchannel/events` — 即時串流（BrowserChannel long-poll）

- 在 `chat.google.com`（GET 收、POST 送/ack）。回應是 length-prefixed frame：`<長度>\n<JSON>\n…`。
- frame 形如 `[[seqId, payload]]`。**實測 payload 多為精簡通知**（`["noop"]`、typing、presence、
  帶 timestamp/UUID 的活動事件），**不含訊息內文**。
- 偶爾含完整 message record（與 list_topics 同形）可直接解析；但可靠的鏡像策略是：
  **收到任何 frame → debounce 後重新 `list_topics`/`paginated_world` 合併**。
- 另有 `signaler-pa.clients6.google.com/punctual/multi-watch/channel`（presence/typing），
  非 `chat.google.com` 主機，content script 不會注入，本專案不依賴它。

---

## 其他觀察到的端點（未使用）

`list_members` / `get_members`（成員）、`get_group`（單一 group 詳情）、`get_group_scoped_capabilities`、
`get_user_settings`、`get_smart_replies`、`search_integration_actions`、`heartbeat`、
`get_attachment_url`（附件）、`get_custom_emoji_image`、`find_unnamed_group_by_members_v2`、
`update_group`、`list_blocked_users`、`get_self_user_status` 等。
`_/DynamiteWebUi/data/batchexecute` 仍被某些功能使用，但讀寫主路徑都已改走上面的直接 `/api/` 端點。
