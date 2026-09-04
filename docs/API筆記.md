# ttfd2 勤務系統 API 結構筆記

以探測方式取得，來源為系統前端自身發出的請求（2026-09-03）。
本筆記供撰寫採集器使用，內容為欄位結構，不含任何憑證。

---

## 一、勤務表列表

```
POST /api/v2/shift/list
```

**送出**

```json
{
  "depts": ["5ee1d63d1679e1139fe2bbe2", "593f83d2a326a612c81cfca4",
            "593f8339a326a612c81cfc9d", "593f841ba326a612c81cfca5",
            "593f83c1a326a612c81cfca3", "5a5d9641ff615e83c6001f56"],
  "start": "2026-09-03T10:04:11.161Z",
  "end": null,
  "select": "dept date manager workers day night updatedAt files",
  "limit": 999
}
```

- `depts`：成功大隊及所屬 5 個分隊的單位 ID，共 6 組，可固定寫死
- `start`：查詢日期（系統送的是當下時間戳，後端應只取日期部分）
- `select`：指定要回傳哪些欄位，可依需要精簡

**回傳**：陣列，每個單位一筆

| 欄位 | 內容 |
|---|---|
| `_id` | 該筆勤務表編號，查細表時用 |
| `date` | 勤務日期 `YYYY-MM-DD` |
| `dept` | 單位 ID |
| `manager` | `{no, kind, name, _id}` 主管 |
| `workers` | 上班人員陣列，元素同上 |
| `day` / `night` | 08-20、20-08 在班人數 |
| `updatedAt` | 最後更新時間 |
| `files` | 上傳檔案 `{filename, type, path, mimeType, name}` |

### 單位 ID 對照

**不需要建立此對照表。** 原本設想用 `dept` ID 對照單位名稱，但實測
`shift/list` 回傳陣列的順序與畫面顯示順序不保證一致，位置式配對不可靠；
改用「主管」欄位內容比對後已不再需要 `dept` ID 對照，見第四節。

---

## 二、單一單位勤務表

```
GET /api/v2/shift/{_id}
```

**回傳**

| 欄位 | 內容 |
|---|---|
| `date` / `dept` / `manager` | 同列表 |
| `startHour` | 勤務表起算時間，實測為 `8` |
| `items` | 非車輛欄位名稱，例：`["值班","備勤","休息"]` |
| `calls` | 作戰編組車輛欄位名稱，例：`["91車","71車","16車","11、61車"]`，**各單位不同** |
| `users` | 該單位全部人員 |
| `workers` | 當日上班人員 |
| `tables` | **以人為單位**的排班，每位上班人員一張，見下 |
| `works` | 當日勤務 `{start, end, content, users, calls, kind, place, raw}` |
| `leave` | `{輪休, 休假, 半日勤務, 公差假, 補假, 事病假}`，各為人員陣列 |
| `remark` | 附記（出勤原則） |
| `files` | 上傳檔案 |
| `isRemoved` | 是否已刪除 |

### tables 結構

每個元素代表一位上班人員：

```
{
  no, kind, name, _id,                              // 這張表屬於誰
  "0":  [{"value":"值班","index":0},
         {"value":"16車","index":0}],               // 00-01 時段，此人同時值班與上 16 車
  "1":  [{"value":"值班","index":0}, ...],          // 01-02
  ...
  "23": [...]                                       // 23-24
}
```

**小時 key 就是當天的絕對小時 0–23，不需要用 startHour 換算。**

> 這點務必注意。`startHour: 8` 只代表**畫面上這張表從 08-09 那列開始排**
> （08-09 → … → 23-24 → 00-01 → … → 07-08），
> 不是資料的位移量。曾誤解為相對位移，會使整張班表錯位 8 小時。
> 驗證方式：取 `h0` 與畫面上 00-01 那列比對，而非 08-09 那列。

- `value`：欄位名稱，內容必為 `items` 或 `calls` 其中一個字串
- `index`：同一欄位內有多人時的排序（例：91車兩人 → index 0、1）
- 每小時是**陣列**，因為一個人可能同時被編在多個欄位

### 畫面欄位順序

```
時間 | items[0] | calls[0..n] | items[1..n]
時間 |   值班   | 91 71 16 11、61 |  備勤 休息
```

長濱分隊 `calls` 為 `["16車","61車","91車"]`，畫面即依此順序排，各單位不同。

> 畫面上「以時段為列」那張表，是前端把以人為單位的 `tables` 轉置後的結果。
> 採集器需做相同轉換：對每個小時，掃過所有人員該小時的項目，依 `value` 歸位到對應欄位，
> 同欄位內依 `index` 排序。

### works（當日勤務）

```json
{"start":8,"end":14,"content":"醫療訪視及重機排氣檢驗",
 "users":[{"no":"17","kind":"隊員","name":"○○○","_id":"…"}],
 "calls":[],"kind":"","place":"都蘭分隊、台東檢驗廠",
 "raw":"08-14 醫療訪視及重機排氣檢驗 地點:都蘭分隊、台東檢驗廠 人員:17"}
```

`start` / `end` 為小時整數。`kind` 可能為空字串。`raw` 是原始輸入文字。

### 認證

請求帶 `Authorization` 標頭（非 Cookie）。採集器需取得該標頭才能自行呼叫 API。

---

## 三、已確認 / 待確認

已確認：

- [x] `tables` 的小時 key 為絕對小時 0–23（非 startHour 位移）
- [x] `value` = 欄位名稱、`index` = 同欄位內排序
- [x] 認證為 `Authorization` 標頭
- [x] `items` = `["值班","備勤","休息"]`、`calls` 為各單位車輛欄位

待確認：

- [ ] `start` 參數送當日 00:00 是否即可（目前系統送的是當下時間戳）
- [ ] `Authorization` 權杖的有效期限（影響採集器多久需要重新取得）

## 四、已解決的坑

**單位順序不可信**：`shift/list` 回傳陣列的順序，不保證與畫面列表顯示的
順序一致（實測發現「長濱分隊」與「東河分隊」的資料對調）。原本用
「畫面第幾列」對應「回傳第幾筆」的位置式配對是錯的。

正解：改用「主管」欄位內容比對。API 回傳的 `manager:{kind,name}`
與畫面「主管」欄顯示的文字（kind+name 相接）是同一份資料，
用它當 key 去對照畫面「單位」欄取得單位名稱，不受順序影響。
見 `collector/collector.js` 的 `nameMap()` 與 `collect()`。

**授權不在 localStorage / sessionStorage / 可讀 Cookie**：實測探測三者
皆空，判斷授權權杖只存在網頁執行期間的記憶體中（常見的安全做法）。
正解：不去找它存在哪裡，改為攔截頁面自己發出請求時使用的
`Authorization` 標頭值（monkey-patch `XMLHttpRequest.setRequestHeader`
與 `fetch`），並自動模擬點擊畫面上的「查詢」按鈕觸發一次真實請求。
攔截到的值只存在執行期間的記憶體，不落地存檔。

---

## 五、ttfd.firemis.tw（案件系統）探測筆記（2026-09-04）

**這是另一個網域**（`ttfd.firemis.tw`，不是 `ttfd2`），首頁
`#/home` 同時混合了兩種來源的資料：

1. **案件相關**（`/api/case/v1/...`，相對路徑＝同源於 ttfd.firemis.tw
   自己的後端）：`list`、`case/{編號}`、`address/...`、`case-routing/...`、
   `clients`、`caseClients`。這塊含報案人姓名、電話、地址、患者狀況，
   **本專案明確決定不碰**，不建立對應的採集邏輯，探測工具也刻意排除
   任何含 `/case/` 的請求。

2. **單位狀態相關**（完整網址指向 `https://ttfd2.firemis.tw/api/v2/...`，
   跨網域直接打 ttfd2 的後端）：
   - `shift-status/list` —「單位狀態」表的資料來源（值班、在隊、在外、
     單位訊息前三筆），**低風險，這是我們要的資料**
   - `shift-record/list` — 可能對應「前十筆出入及工作記錄」
   - `shift-dept-post/list`、`tracker/trackers`、`emic/types` 等，
     用途待確認

**重要**：因為 `shift-status/list` 是打 `ttfd2` 的後端，跟現有勤務表
採集器（`collector/collector.js`）**用的是同一個系統、同一種授權
機制**。這代表擴充這塊功能時，很可能可以直接沿用現有採集器已經在
用的「攔截 Authorization 標頭」做法，不需要為 ttfd.firemis.tw
另外走一套登入流程。

其餘找到但確認不需要的端點：`supervise/v1/schedules`、
`car/v1/maintenance-schedules`、`car/v1/nextvalidate-schedules`
（車輛保養排程）、`weather/...`、`emic/typhoon`（天氣颱風示警）——
與勤務看板需求無關，不處理。

---

## 六、shift-status/list 確認格式（2026-09-04）

**呼叫方式**：`POST /api/v2/shift-status/list`，body `{depts: DEPTS}`
（跟 `shift/list` 同一組單位 ID）。單純 GET 不帶 body 會回 503。

**回傳**：陣列，每個單位一筆：

```json
{
  "dept": "593f8339a326a612c81cfc9d",
  "inDeptUsers": [],
  "outDeptUsers": [
    {
      "no": "2", "kind": "副大隊長", "name": "沈煒翔",
      "inDept": false,
      "statusAt": "2026-09-04T05:28:00.000Z",
      "recordKind": "救護",
      "recordCalls": [],
      "recordContent": "測試",
      "leave": false,
      "recordInDept": "出"
    }
  ],
  "manger": {"no":"2","kind":"副大隊長","name":"沈煒翔"},
  "day": 2, "night": 2, "current": 2, "dutyUsers": []
}
```

（原文如此，`manger` 少一個 a，系統本身的欄位命名，不是筆誤。）

**已確認**：
- `outDeptUsers` = 目前不在隊的人；`leave:true` 代表這筆是排定的請假
  （已在 `shift/list` 的 `leave` 物件顯示過），`leave:false` 代表真的
  是外出/出勤中，這是我們要的即時資訊
- `recordKind` = 原因分類（例：「救護」）、`recordCalls` = 關聯車輛
  （陣列，可能為空）、`statusAt` = 狀態起始時間（UTC ISO 字串）
- `dept` 對照單位名稱不需要額外查表，`collect()` 在處理 `shift/list`
  時已經建立 `deptToName` 對照（用主管文字比對得出），直接複用即可

**已排除**：`recordContent`（自由文字備註欄，不帶出去，避免夾帶非預期
內容）、所有內部 `_id`／`recordId`。

**其餘試過但決定不用**：`shift-record/list`（出入記錄日誌）雖然也能
GET，但內容包含 `logs[].ip`、`logs[].userAgent`（瀏覽器資訊），且
本質是歷史稽核紀錄而非即時狀態，`shift-status/list` 已經足夠涵蓋
「即時人力」需求，故不採用。

見 `collector/collector.js` 的 `buildOutStatus()`。

**更新頻率**：即時出勤與完整勤務表分開排程（完整 4 小時＋每天
07:00 額外一次，即時出勤 30 分鐘一次），即時出勤只打
`shift-status/list` 這支，不重查整份勤務表，對系統負擔較小。
對應伺服器端支援「快速推送」（body 只有 `outStatus`，見
`server/server.js` 的 `/api/push`），合併進現有資料而不是整包換掉。

---

## 七、Google 行事曆 iCal 訂閱與 htmlLink 重建公式（2026-09-04）

跟 ttfd2/ttfd 都無關，是另一個完全獨立的資料來源，記在這裡方便查找。

**訂閱網址格式**：
```
https://calendar.google.com/calendar/ical/<日曆ID URL編碼>/public/basic.ics   （日曆已設公開時）
https://calendar.google.com/calendar/ical/<日曆ID URL編碼>/private-<亂碼>/basic.ics  （私人網址，不論日曆是否公開都能用）
```
不需要登入、不需要 API 金鑰，網址本身就是通行證。回傳格式是標準
iCalendar（`.ics`），用 `node-ical` 套件解析（`ical.async.fromURL()`）。

**htmlLink 重建公式**（已用真實事件驗證正確）：
```
eid = base64("<事件ID> <日曆ID>")，不含結尾 =
連結 = https://www.google.com/calendar/event?eid=<eid>
```
事件 ID 取自 ICS 的 `UID` 欄位，需去掉結尾的 `@google.com`。
日曆 ID 從訂閱網址本身的路徑段解出（URL 解碼）。
見 `server/calendar.js` 的 `buildLink()`。

**重複事件（RRULE）是真實會用到的情況，不是邊角案例**：實測「成功
大隊暨所屬分隊活動」日曆有 16 組重複規則、41 筆例外異動（例如某次
週報被取消或改期，會以帶 `RECURRENCE-ID` 的獨立 VEVENT 覆蓋掉該次
展開結果）。展開重複規則要用 `ev.rrule.between(start,end,true)`，
並且要比對是否有相符的 `RECURRENCE-ID` 例外場次，用例外的內容取代
（或整場跳過，若例外的狀態是 CANCELLED）。

**風險提醒**：這台開發用電腦沒有安裝 Node，`server/calendar.js` 與
其中的 RRULE 展開邏輯**只能靠靜態語法檢查與人工檢視，沒有真的執行
測試過**。部署後務必看 Render 的部署日誌，並用 `/api/health` 的
`calDays`／`calFetchedAt` 欄位確認有沒有成功抓到資料，發現異常回報
給 Claude 附上實際錯誤訊息。
