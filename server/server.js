/* ============================================================
   勤務看板 — 資料接收與看板供應（部署在 Render）

   它做兩件事：
   1. 收資料：隊部電腦上的採集器（書籤）從 ttfd2 頁面抓到勤務資料後，
      POST 到 /api/push。需帶正確的 token，避免外人亂送。
   2. 給資料：電視牆、手機、任何人開 /api/duty 就能讀到最新資料，
      不需要登入勤務系統。

   3. 定時讀 Google 行事曆：伺服器每隔一段時間自己去讀 iCal 訂閱網址
      （不需要登入、不需要人操作），整理好跟其餘資料一起供應出去。

   環境變數（在 Render 的 Environment 設定）：
     PUSH_TOKEN       必填。採集器送資料時要帶的通行碼，自己取一串亂碼。
     ALLOW_ORIGIN     選填。允許送資料進來的來源，預設 https://ttfd2.firemis.tw
     CAL_ICS_URL_DAJI     選填。「大隊」來源日曆的 iCal 訂閱網址
     CAL_ICS_URL_YIXIAO   選填。「義消」來源日曆的 iCal 訂閱網址
     CAL_ICS_URL_JUBENBU  選填。「局本部」來源日曆的 iCal 訂閱網址
     以上三個都是選填、且互相獨立——沒設定的來源就不會出現在看板上，
     之後要加新來源，只要多設一個環境變數即可，不需要改程式碼。
     若三個都沒設定，行事曆會沿用看板內建的靜態快照（不會自動更新）。
   ============================================================ */

"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");

// 行事曆模組獨立包一層防護：萬一它有問題（例如相依套件安裝失敗、
// ICS 解析邏輯有 bug），不該連累勤務表、即時出勤這些完全不相關的
// 功能。載入失敗就把它當「沒有這個功能」處理，其餘照常運作。
let fetchAllCalendars = null;
try {
  fetchAllCalendars = require("./calendar").fetchAllCalendars;
} catch (e) {
  console.log("[boot] 行事曆模組載入失敗，行事曆功能停用，其餘照常運作：" + e.message);
}

const app = express();
const PORT = process.env.PORT || 3000;
const PUSH_TOKEN = process.env.PUSH_TOKEN || "";
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "https://ttfd2.firemis.tw";

// 資料放記憶體。Render 免費方案重啟會清空，採集器下次推送就會補回來。
// 另外寫一份到暫存檔，讓同一個執行個體重新載入時還在。
const CACHE_FILE = path.join("/tmp", "duty-latest.json");
let latest = null;

try {
  if (fs.existsSync(CACHE_FILE)) {
    latest = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    console.log("[boot] 已載入前次快取，資料日期 " + (latest.data && latest.data.date));
  }
} catch (e) {
  console.log("[boot] 快取讀取失敗，忽略：" + e.message);
}

/* ---------- 行事曆：自己排程去讀，不需要人操作 ---------- */
const CAL_SOURCES = [
  { name: "大隊", tag: "t1", url: process.env.CAL_ICS_URL_DAJI || "" },
  { name: "義消", tag: "t3", url: process.env.CAL_ICS_URL_YIXIAO || "" },
  { name: "局本部", tag: "t2", url: process.env.CAL_ICS_URL_JUBENBU || "" }
].filter((s) => s.url);

const CAL_POLL_MS = 12 * 60 * 60 * 1000; // 12 小時
let calCache = null; // { days, fetchedAt }

function refreshCalendar() {
  if (!CAL_SOURCES.length || !fetchAllCalendars) return;
  fetchAllCalendars(CAL_SOURCES)
    .then((result) => {
      calCache = { days: result.days, fetchedAt: result.fetchedAt };
      var msg = "[cal] 已更新，共 " + result.days.length + " 天有行程";
      if (result.errors.length) msg += "；部分來源失敗：" + result.errors.join("；");
      console.log(msg);
    })
    .catch((e) => {
      console.log("[cal] 更新失敗，保留舊資料（若有）：" + e.message);
    });
}

if (CAL_SOURCES.length) {
  console.log("[boot] 行事曆來源：" + CAL_SOURCES.map((s) => s.name).join("、"));
  refreshCalendar();
  setInterval(refreshCalendar, CAL_POLL_MS);
} else {
  console.log("[boot] 尚未設定任何 CAL_ICS_URL_*，行事曆將沿用看板內建的靜態快照");
}

app.use(express.json({ limit: "2mb" }));

/* ---------- 跨來源設定 ---------- */
app.use((req, res, next) => {
  const origin = req.headers.origin || "";

  if (req.path === "/api/push") {
    // 只有勤務系統頁面能送資料進來
    if (origin === ALLOW_ORIGIN) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Push-Token");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
  } else {
    // 看板資料開放讀取，電視牆與手機才不用登入
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------- 收資料 ----------
   兩種推送，靠 body 的形狀分辨：
   1. 完整推送（勤務表、每 4 小時＋每天 07:00）：帶 date + units，
      整包資料整個換掉，行為跟原本一樣。
   2. 快速推送（即時出勤、每 30 分鐘）：只帶 outStatus，不動其餘
      欄位——用「合併」而不是「整個換掉」，避免把勤務表資料洗掉。
      這種推送前提是伺服器已經有過一次完整推送，不然沒東西可合併。 */
function writeCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(latest), "utf8");
  } catch (e) {
    console.log("[push] 快取寫入失敗，不影響服務：" + e.message);
  }
}

app.post("/api/push", (req, res) => {
  if (!PUSH_TOKEN) {
    return res.status(500).json({ ok: false, error: "伺服器尚未設定 PUSH_TOKEN" });
  }
  if (req.get("X-Push-Token") !== PUSH_TOKEN) {
    return res.status(401).json({ ok: false, error: "通行碼不正確" });
  }

  const body = req.body;
  if (!body) {
    return res.status(400).json({ ok: false, error: "缺少資料內容" });
  }

  // 完整推送
  if (Array.isArray(body.units)) {
    if (!body.date) {
      return res.status(400).json({ ok: false, error: "資料格式不符：完整推送需要 date" });
    }
    latest = {
      receivedAt: new Date().toISOString(),
      data: body
    };
    writeCache();
    console.log("[push] 完整推送 " + body.date + "，單位 " + body.units.length + " 個");
    return res.json({ ok: true, receivedAt: latest.receivedAt, units: body.units.length });
  }

  // 快速推送（只有即時出勤）
  if (Array.isArray(body.outStatus)) {
    if (!latest) {
      return res.status(409).json({ ok: false, error: "尚未有完整資料，請先執行一次完整採集" });
    }
    latest.data.outStatus = body.outStatus;
    latest.data.outStatusAt = new Date().toISOString();
    writeCache();
    console.log("[push] 快速推送即時出勤 " + body.outStatus.length + " 人");
    return res.json({ ok: true, outStatusAt: latest.data.outStatusAt, count: body.outStatus.length });
  }

  return res.status(400).json({ ok: false, error: "資料格式不符：需要 units（完整）或 outStatus（快速）" });
});

/* ---------- 給資料 ---------- */
app.get("/api/duty", (req, res) => {
  if (!latest) {
    return res.status(404).json({
      ok: false,
      error: "尚未收到任何勤務資料",
      hint: "請在隊部電腦登入勤務系統後執行採集器"
    });
  }
  // 行事曆是伺服器自己排程抓的，跟採集器推送的資料分開維護，
  // 這裡合併成同一份回應，看板端只要讀一個地方就好。
  var data = Object.assign({}, latest.data);
  if (calCache) {
    data.cal = calCache.days;
    data.calFetchedAt = calCache.fetchedAt;
  }
  res.json({ ok: true, receivedAt: latest.receivedAt, data: data });
});

/* ---------- 健康檢查 ---------- */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    hasData: !!latest,
    receivedAt: latest ? latest.receivedAt : null,
    tokenConfigured: !!PUSH_TOKEN,
    calSources: CAL_SOURCES.map((s) => s.name),
    calFetchedAt: calCache ? calCache.fetchedAt : null,
    calDays: calCache ? calCache.days.length : 0
  });
});

/* ---------- 看板本身 ---------- */
app.use(express.static(path.join(__dirname, "..", "web")));

app.listen(PORT, () => {
  console.log("勤務看板服務啟動，連接埠 " + PORT);
  if (!PUSH_TOKEN) console.log("警告：尚未設定 PUSH_TOKEN，/api/push 會拒收資料");
});
