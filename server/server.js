/* ============================================================
   勤務看板 — 資料接收與看板供應（部署在 Render）

   它做兩件事：
   1. 收資料：隊部電腦上的採集器（書籤）從 ttfd2 頁面抓到勤務資料後，
      POST 到 /api/push。需帶正確的 token，避免外人亂送。
   2. 給資料：電視牆、手機、任何人開 /api/duty 就能讀到最新資料，
      不需要登入勤務系統。

   3. 定時讀 Google 行事曆：伺服器每隔一段時間自己去讀 iCal 訂閱網址
      （不需要登入、不需要人操作），整理好跟其餘資料一起供應出去。
      不想等自動排程的話，開 /api/cal-refresh?token=PUSH_TOKEN
      可以立刻手動觸發一次。

   4. 全縣多大隊資料：局本部帳號的採集器（collector-county.js）
      POST 到 /api/push-county，存成完全獨立的一份資料
      （latestCounty，不影響成功大隊自己的 latest），一起併入
      /api/duty 的回應（countyUnits／countyTasks／countyOutStatus
      欄位），看板前端依需要切換顯示。

   5. 試算表驅動設定：密碼保護、單位代碼→大隊對照、跑馬燈公告都改
      用 Google 試算表管理（見 sheetConfig.js），伺服器定時讀取、
      也有手動觸發端點 /api/config-refresh，不用改程式碼、不用
      重新部署，改試算表內容即可生效。

   環境變數（在 Render 的 Environment 設定）：
     PUSH_TOKEN       必填。採集器送資料時要帶的通行碼，自己取一串亂碼。
     ALLOW_ORIGIN     選填。允許送資料進來的來源，預設 https://ttfd2.firemis.tw
     CAL_ICS_URL_DAJI     選填。「大隊」來源日曆的 iCal 訂閱網址
     CAL_ICS_URL_YIXIAO   選填。「義消」來源日曆的 iCal 訂閱網址
     CAL_ICS_URL_JUBENBU  選填。「局本部」來源日曆的 iCal 訂閱網址
     以上三個都是選填、且互相獨立——沒設定的來源就不會出現在看板上，
     之後要加新來源，只要多設一個環境變數即可，不需要改程式碼。
     若三個都沒設定，行事曆會沿用看板內建的靜態快照（不會自動更新）。
     CONFIG_PASSWORDS_URL  選填。密碼分頁發布出來的 CSV 網址。
     CONFIG_DEPTS_URL      選填。單位代碼分頁發布出來的 CSV 網址。
     CONFIG_NOTICES_URL    選填。跑馬燈分頁發布出來的 CSV 網址。
     這三個也都選填、互相獨立，用法見 sheetConfig.js 檔頭說明。
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

// 試算表驅動設定（密碼／單位代碼／跑馬燈）一樣獨立包一層防護，
// 載入失敗就當「沒有這個功能」，不連累其餘功能。
let sheetConfig = null;
try {
  sheetConfig = require("./sheetConfig");
} catch (e) {
  console.log("[boot] 試算表設定模組載入失敗，密碼保護／單位代碼／跑馬燈功能停用，其餘照常運作：" + e.message);
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

// 全縣多大隊資料，跟成功大隊自己的 latest 完全獨立存放。
const CACHE_FILE_COUNTY = path.join("/tmp", "duty-county-latest.json");
let latestCounty = null;

try {
  if (fs.existsSync(CACHE_FILE_COUNTY)) {
    latestCounty = JSON.parse(fs.readFileSync(CACHE_FILE_COUNTY, "utf8"));
    console.log("[boot] 已載入全縣資料前次快取，資料日期 " + (latestCounty.data && latestCounty.data.date));
  }
} catch (e) {
  console.log("[boot] 全縣資料快取讀取失敗，忽略：" + e.message);
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
  if (!CAL_SOURCES.length || !fetchAllCalendars) return Promise.resolve();
  return fetchAllCalendars(CAL_SOURCES)
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

/* ---------- 試算表驅動設定：自己排程去讀，不需要人操作 ---------- */
const CONFIG_POLL_MS = 30 * 60 * 1000; // 30 分鐘。比行事曆頻繁，因為密碼、跑馬燈這種內容改動後通常想快點生效。
if (sheetConfig) {
  sheetConfig.refreshConfig().then(function (r) {
    var msg = "[config] 已載入，密碼 " + r.passwords + " 筆、單位代碼 " + r.depts + " 筆、跑馬燈 " + r.notices + " 筆";
    if (r.errors.length) msg += "；部分來源失敗：" + r.errors.join("；");
    console.log(msg);
  });
  setInterval(function () { sheetConfig.refreshConfig(); }, CONFIG_POLL_MS);
}

app.use(express.json({ limit: "2mb" }));

/* ---------- 跨來源設定 ---------- */
app.use((req, res, next) => {
  const origin = req.headers.origin || "";

  if (req.path === "/api/push" || req.path === "/api/push-county") {
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

function writeCacheCounty() {
  try {
    fs.writeFileSync(CACHE_FILE_COUNTY, JSON.stringify(latestCounty), "utf8");
  } catch (e) {
    console.log("[push-county] 快取寫入失敗，不影響服務：" + e.message);
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

/* ---------- 收全縣多大隊資料 ----------
   跟 /api/push 完全獨立的一組資料，用同一個 PUSH_TOKEN，形狀比照
   辦理：完整推送帶 date + countyUnits，快速推送只帶 countyOutStatus。
   彼此互不覆蓋，成功大隊自己的自動化完全不受影響。 */
app.post("/api/push-county", (req, res) => {
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

  if (Array.isArray(body.countyUnits)) {
    if (!body.date) {
      return res.status(400).json({ ok: false, error: "資料格式不符：完整推送需要 date" });
    }
    latestCounty = {
      receivedAt: new Date().toISOString(),
      data: body
    };
    writeCacheCounty();
    console.log("[push-county] 完整推送 " + body.date + "，單位 " + body.countyUnits.length + " 個");
    return res.json({ ok: true, receivedAt: latestCounty.receivedAt, units: body.countyUnits.length });
  }

  if (Array.isArray(body.countyOutStatus)) {
    if (!latestCounty) {
      return res.status(409).json({ ok: false, error: "尚未有完整資料，請先執行一次完整採集" });
    }
    latestCounty.data.countyOutStatus = body.countyOutStatus;
    latestCounty.data.countyOutStatusAt = new Date().toISOString();
    writeCacheCounty();
    console.log("[push-county] 快速推送即時出勤 " + body.countyOutStatus.length + " 人");
    return res.json({ ok: true, outStatusAt: latestCounty.data.countyOutStatusAt, count: body.countyOutStatus.length });
  }

  return res.status(400).json({ ok: false, error: "資料格式不符：需要 countyUnits（完整）或 countyOutStatus（快速）" });
});

/* ---------- 即時出勤的單位名稱，每次供應資料時都重新校正 ----------
   即時出勤是「快速推送」，可能來自任何一個還開著的採集器分頁；如果
   那個分頁剛好在單位名稱還沒讀穩定時就送出（例如自動模式的時序
   問題，或單純是舊版分頁還沒關），送來的 unit 欄位可能是代碼而不是
   真正的名稱。完整推送的 units 陣列纔是最新、最完整的權威對照表，
   所以每次供應資料時都拿 units 重新校正一次 outStatus 的 unit 欄位，
   不管是哪個分頁、哪個時間點送來的都一樣準，也能立即修正已經存在
   （在這次修正部署前收到）的錯誤資料，不用等下一次推送。 */
function resolveOutStatusNames(units, outStatus) {
  if (!Array.isArray(outStatus) || !outStatus.length) return outStatus;
  var byDept = {};
  (units || []).forEach(function (u) {
    if (u && u.deptId) byDept[u.deptId] = u.name;
  });
  return outStatus.map(function (o) {
    if (o && o.dept && byDept[o.dept]) {
      return Object.assign({}, o, { unit: byDept[o.dept] });
    }
    return o;
  });
}

/* ---------- 給資料 ---------- */
app.get("/api/duty", (req, res) => {
  // 成功大隊自己的資料（latest）跟全縣多大隊資料（latestCounty）是
  // 完全獨立的兩份，只有兩邊都沒有時才真的算「沒有資料」——如果只是
  // 其中一邊還沒補回來（例如 Render 剛重啟、還沒跑過那邊的採集器），
  // 另一邊已經有的資料還是要正常供應，不能整包 404 掉，不然就違背
  // 兩邊互不影響的設計初衷。
  if (!latest && !latestCounty) {
    return res.status(404).json({
      ok: false,
      error: "尚未收到任何勤務資料",
      hint: "請在隊部電腦登入勤務系統後執行採集器"
    });
  }
  // 行事曆、全縣多大隊資料都是分開維護的，這裡合併成同一份回應，
  // 看板端只要讀一個地方就好。
  var data = latest ? Object.assign({}, latest.data) : {};
  if (latest) {
    data.outStatus = resolveOutStatusNames(data.units, data.outStatus);
  }
  if (calCache) {
    data.cal = calCache.days;
    data.calFetchedAt = calCache.fetchedAt;
  }
  if (latestCounty) {
    var countyUnits = latestCounty.data.countyUnits;
    var countyTasks = latestCounty.data.countyTasks || [];
    var countyOutStatus = resolveOutStatusNames(countyUnits, latestCounty.data.countyOutStatus);

    // 單位代碼→大隊對照表若有試算表資料就覆蓋採集器當初算的結果，
    // 這樣單位改編、新增分隊只要改試算表就好，不用重新部署採集器。
    // 試算表沒有這筆資料（或整份抓不到）就保留採集器原本算的值，
    // 不會因為試算表暫時失效而讓分類整個消失。
    if (sheetConfig) {
      countyUnits = countyUnits.map(function (u) {
        var ov = sheetConfig.resolveBrigadeById(u.deptId);
        return ov ? Object.assign({}, u, { brigade: ov }) : u;
      });
      countyTasks = countyTasks.map(function (t) {
        var ov = sheetConfig.resolveBrigadeByName(t.unit);
        return ov ? Object.assign({}, t, { brigade: ov }) : t;
      });
      countyOutStatus = countyOutStatus.map(function (o) {
        var ov = sheetConfig.resolveBrigadeById(o.dept);
        return ov ? Object.assign({}, o, { brigade: ov }) : o;
      });
    }

    data.countyUnits = countyUnits;
    data.countyTasks = countyTasks;
    data.countyOutStatus = countyOutStatus;
    data.countyReceivedAt = latestCounty.receivedAt;
    data.countyDate = latestCounty.data.date;
  }

  // 密碼保護清單、跑馬燈公告：只給「有哪些大隊設了密碼」與「公告
  // 內容」，實際密碼絕不放進這個回應——密碼比對走 /api/check-brigade-
  // password，不然任何人打開瀏覽器開發者工具的網路分頁就能直接看到
  // 明文密碼，防手滑的功能就沒意義了。
  data.gatedBrigades = sheetConfig ? sheetConfig.gatedBrigades() : [];
  data.notices = sheetConfig ? sheetConfig.activeNotices() : [];

  res.json({ ok: true, receivedAt: latest ? latest.receivedAt : null, data: data });
});

/* ---------- 大隊切換密碼比對 ----------
   純軟性保護：防止手滑切到別的大隊，不是真的資料隔離（/api/duty
   本來就會把全縣資料一起回應給前端，這裡只是不讓畫面渲染出來）。
   密碼本身只存在伺服器記憶體（從試算表讀來的），這支端點只回
   true/false，不會把密碼內容回傳給前端。 */
app.post("/api/check-brigade-password", (req, res) => {
  if (!sheetConfig) {
    return res.status(501).json({ ok: false, error: "密碼保護尚未啟用" });
  }
  const body = req.body || {};
  const result = sheetConfig.checkPassword(String(body.brigade || ""), String(body.password || ""));
  res.json(result);
});

/* ---------- 手動觸發試算表設定重新讀取 ----------
   平常靠 CONFIG_POLL_MS（30 分鐘）自動排程；改了密碼、單位代碼、
   跑馬燈內容想立刻生效，開這個網址（帶上跟採集器同一組
   PUSH_TOKEN）即可，不用整個重新部署。
   https://你的網址/api/config-refresh?token=你的PUSH_TOKEN */
app.get("/api/config-refresh", (req, res) => {
  if (!PUSH_TOKEN || (req.query.token !== PUSH_TOKEN && req.get("X-Push-Token") !== PUSH_TOKEN)) {
    return res.status(401).json({ ok: false, error: "通行碼不正確" });
  }
  if (!sheetConfig) {
    return res.status(501).json({ ok: false, error: "試算表設定模組未啟用" });
  }
  sheetConfig.refreshConfig()
    .then((r) => res.json(Object.assign({ ok: true }, r)))
    .catch((e) => res.status(500).json({ ok: false, error: e.message }));
});

/* ---------- 手動觸發行事曆重新讀取 ----------
   平常靠 CAL_POLL_MS（12 小時）自動排程就好；但剛新增／改了行程、
   不想等到下次自動排程時，開這個網址（帶上跟採集器同一組
   PUSH_TOKEN）就能立刻觸發一次讀取，不用整個重新部署伺服器。
   直接在瀏覽器網址列開，例如：
   https://你的網址/api/cal-refresh?token=你的PUSH_TOKEN */
app.get("/api/cal-refresh", (req, res) => {
  if (!PUSH_TOKEN || (req.query.token !== PUSH_TOKEN && req.get("X-Push-Token") !== PUSH_TOKEN)) {
    return res.status(401).json({ ok: false, error: "通行碼不正確" });
  }
  if (!fetchAllCalendars) {
    return res.status(501).json({ ok: false, error: "行事曆模組未啟用" });
  }
  if (!CAL_SOURCES.length) {
    return res.status(400).json({ ok: false, error: "尚未設定任何 CAL_ICS_URL_*" });
  }
  refreshCalendar()
    .then(() => {
      res.json({
        ok: true,
        calFetchedAt: calCache ? calCache.fetchedAt : null,
        calDays: calCache ? calCache.days.length : 0
      });
    })
    .catch((e) => {
      res.status(500).json({ ok: false, error: e.message });
    });
});

/* ---------- 健康檢查 ---------- */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    hasData: !!latest,
    receivedAt: latest ? latest.receivedAt : null,
    hasCountyData: !!latestCounty,
    countyReceivedAt: latestCounty ? latestCounty.receivedAt : null,
    countyUnits: latestCounty ? latestCounty.data.countyUnits.length : 0,
    tokenConfigured: !!PUSH_TOKEN,
    calSources: CAL_SOURCES.map((s) => s.name),
    calFetchedAt: calCache ? calCache.fetchedAt : null,
    calDays: calCache ? calCache.days.length : 0,
    config: sheetConfig ? sheetConfig.status() : null
  });
});

/* ---------- 看板本身 ---------- */
app.use(express.static(path.join(__dirname, "..", "web")));

app.listen(PORT, () => {
  console.log("勤務看板服務啟動，連接埠 " + PORT);
  if (!PUSH_TOKEN) console.log("警告：尚未設定 PUSH_TOKEN，/api/push 會拒收資料");
});
