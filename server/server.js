/* ============================================================
   勤務看板 — 資料接收與看板供應（部署在 Render）

   它做兩件事：
   1. 收資料：隊部電腦上的採集器（書籤）從 ttfd2 頁面抓到勤務資料後，
      POST 到 /api/push。需帶正確的 token，避免外人亂送。
   2. 給資料：電視牆、手機、任何人開 /api/duty 就能讀到最新資料，
      不需要登入勤務系統。

   環境變數（在 Render 的 Environment 設定）：
     PUSH_TOKEN   必填。採集器送資料時要帶的通行碼，自己取一串亂碼。
     ALLOW_ORIGIN 選填。允許送資料進來的來源，預設 https://ttfd2.firemis.tw
   ============================================================ */

"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");

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

/* ---------- 收資料 ---------- */
app.post("/api/push", (req, res) => {
  if (!PUSH_TOKEN) {
    return res.status(500).json({ ok: false, error: "伺服器尚未設定 PUSH_TOKEN" });
  }
  if (req.get("X-Push-Token") !== PUSH_TOKEN) {
    return res.status(401).json({ ok: false, error: "通行碼不正確" });
  }

  const data = req.body;
  if (!data || !data.date || !Array.isArray(data.units)) {
    return res.status(400).json({ ok: false, error: "資料格式不符：需要 date 與 units" });
  }

  latest = {
    receivedAt: new Date().toISOString(),
    data: data
  };

  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(latest), "utf8");
  } catch (e) {
    console.log("[push] 快取寫入失敗，不影響服務：" + e.message);
  }

  console.log("[push] 收到 " + data.date + "，單位 " + data.units.length + " 個");
  res.json({ ok: true, receivedAt: latest.receivedAt, units: data.units.length });
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
  res.json({ ok: true, receivedAt: latest.receivedAt, data: latest.data });
});

/* ---------- 健康檢查 ---------- */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    hasData: !!latest,
    receivedAt: latest ? latest.receivedAt : null,
    tokenConfigured: !!PUSH_TOKEN
  });
});

/* ---------- 看板本身 ---------- */
app.use(express.static(path.join(__dirname, "..", "web")));

app.listen(PORT, () => {
  console.log("勤務看板服務啟動，連接埠 " + PORT);
  if (!PUSH_TOKEN) console.log("警告：尚未設定 PUSH_TOKEN，/api/push 會拒收資料");
});
