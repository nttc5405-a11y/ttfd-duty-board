/* ============================================================
   Google 試算表驅動設定：密碼、單位代碼→大隊對照、跑馬燈公告

   三份資料各自在 Google 試算表「發布到網路」成 CSV 連結（跟行事曆
   的 iCal 訂閱網址同一種模式——網址本身當通行證，不需要申請 Google
   API 金鑰、不需要 OAuth）。伺服器定時抓、快取在記憶體，單一來源
   失敗不影響其他兩份、也不影響看板其餘功能——比照 calendar.js 的
   容錯設計：抓不到就沿用上一次快取，不會讓整個看板掛掉。

   環境變數（都選填、互相獨立，沒設定的那份功能就不生效）：
     CONFIG_PASSWORDS_URL   「密碼」分頁發布出來的 CSV 網址。
                            欄位：大隊、密碼。
                            「大隊」欄可以填大隊名稱（例如「台東大隊」），
                            也可以直接填某個分隊的名稱（例如「台東
                            分隊」）達到分隊層級的密碼保護——兩種是
                            同一套機制。分隊密碼只保護「單獨選看該
                            分隊」，選該分隊所屬大隊的「全部」視角不受
                            影響，仍會顯示。有一列「大隊」欄填「管理員」
                            的，該列密碼可以解鎖全部大隊／分隊，供你
                            自己查看用。沒有列在這個分頁的大隊或分隊
                            一律不設防，維持原本沒有這個功能時的行為。
     CONFIG_DEPTS_URL       「單位代碼」分頁發布出來的 CSV 網址。
                            欄位：單位代碼、單位名稱、所屬大隊。
                            用來把新增或改編的單位分類到正確大隊，
                            不用改程式碼、不用重新部署。
     CONFIG_NOTICES_URL     「跑馬燈」分頁發布出來的 CSV 網址。
                            欄位：公告文字、顯示大隊、啟用。
                            顯示大隊可填「全部」或用逗號分隔多個大隊
                            名稱；啟用欄填 TRUE/FALSE。
     CONFIG_CALENDARS_URL   「行事曆」分頁發布出來的 CSV 網址。
                            欄位：名稱、所屬大隊、網址。
                            各單位自己上傳自己的 Google 行事曆 iCal
                            訂閱網址，切換大隊視角時只顯示該大隊自己
                            上傳的行事曆。這份資料跟 server.js 裡
                            CAL_ICS_URL_* 那三個環境變數是疊加關係、
                            不是取代——成功大隊的私人行事曆網址建議
                            繼續留在環境變數（試算表發布成網路連結後
                            內容技術上任何人都讀得到，適合公開或風險
                            較低的行事曆，不適合放太敏感的私人網址）。
   ============================================================ */

"use strict";

const PASSWORDS_URL = process.env.CONFIG_PASSWORDS_URL || "";
const DEPTS_URL = process.env.CONFIG_DEPTS_URL || "";
const NOTICES_URL = process.env.CONFIG_NOTICES_URL || "";
const CALENDARS_URL = process.env.CONFIG_CALENDARS_URL || "";

const ADMIN_KEY = "管理員";
const CAL_TAGS = ["t1", "t2", "t3"];   // 前端只定義了三種顏色的篩選鈕樣式，循環使用

let passwordsCache = {};      // { 大隊名或分隊名: 密碼 }，含 "管理員" 這個特殊 key
let deptByIdCache = {};       // { 單位代碼: 所屬大隊 }
let deptByNameCache = {};     // { 單位名稱: 所屬大隊 }
let noticesCache = [];        // [{ text, targets:[大隊...] 或 ["ALL"] }]
let calendarSourcesCache = []; // [{ name, brigade, url, tag }]

let lastRefreshAt = null;
let lastErrors = [];

/* ---------- 極簡 CSV 解析（處理引號、逗號、跨行欄位） ----------
   Google 試算表「發布為 CSV」輸出是標準 CSV：含逗號的欄位會用雙引號
   包起來，欄位內的雙引號會變成兩個雙引號。跑馬燈公告文字很可能含
   逗號，不能用簡單的 split(",")，要逐字元判斷引號狀態。 */
function parseCSV(text) {
  var rows = [];
  var row = [];
  var field = "";
  var inQuotes = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; }
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* 忽略，統一靠 \n 斷行 */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else { field += c; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvToObjects(text) {
  // 去掉可能出現的 UTF-8 BOM，不然表頭第一個欄位名稱會比對不到。
  var clean = String(text || "").replace(/^﻿/, "");
  var rows = parseCSV(clean).filter(function (r) {
    return r.length && r.some(function (c) { return String(c).trim() !== ""; });
  });
  if (!rows.length) return [];
  var headers = rows[0].map(function (h) { return String(h).trim(); });
  return rows.slice(1).map(function (r) {
    var o = {};
    headers.forEach(function (h, idx) { o[h] = r[idx] == null ? "" : String(r[idx]).trim(); });
    return o;
  });
}

function fetchCSV(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }).then(csvToObjects);
}

function isTruthy(v) {
  return /^(true|1|是|v|yes|on)$/i.test(String(v || "").trim());
}

function splitTargets(v) {
  var s = String(v || "").trim();
  if (!s || /^(全部|all)$/i.test(s)) return ["ALL"];
  return s.split(/[,、，]/).map(function (x) { return x.trim(); }).filter(Boolean);
}

function refreshPasswords() {
  if (!PASSWORDS_URL) { passwordsCache = {}; return Promise.resolve(0); }
  return fetchCSV(PASSWORDS_URL).then(function (rows) {
    var m = {};
    rows.forEach(function (r) {
      var name = r["大隊"] || r["單位"] || "";
      var pw = r["密碼"] || "";
      if (name && pw) m[name] = pw;
    });
    passwordsCache = m;
    return Object.keys(m).length;
  });
}

function refreshDepts() {
  if (!DEPTS_URL) { deptByIdCache = {}; deptByNameCache = {}; return Promise.resolve(0); }
  return fetchCSV(DEPTS_URL).then(function (rows) {
    var byId = {}, byName = {};
    rows.forEach(function (r) {
      var id = r["單位代碼"] || r["dept"] || r["deptId"] || "";
      var name = r["單位名稱"] || "";
      var brigade = r["所屬大隊"] || "";
      if (!brigade) return;
      if (id) byId[id] = brigade;
      if (name) byName[name] = brigade;
    });
    deptByIdCache = byId;
    deptByNameCache = byName;
    return Object.keys(byId).length;
  });
}

function refreshNotices() {
  if (!NOTICES_URL) { noticesCache = []; return Promise.resolve(0); }
  return fetchCSV(NOTICES_URL).then(function (rows) {
    var list = [];
    rows.forEach(function (r) {
      var text = r["公告文字"] || "";
      if (!text) return;
      if (!isTruthy(r["啟用"])) return;
      list.push({ text: text, targets: splitTargets(r["顯示大隊"]) });
    });
    noticesCache = list;
    return list.length;
  });
}

function refreshCalendars() {
  if (!CALENDARS_URL) { calendarSourcesCache = []; return Promise.resolve(0); }
  return fetchCSV(CALENDARS_URL).then(function (rows) {
    var list = [];
    rows.forEach(function (r) {
      var name = r["名稱"] || "";
      var brigade = r["所屬大隊"] || "";
      var url = r["網址"] || "";
      if (!name || !brigade || !url) return;
      list.push({ name: name, brigade: brigade, url: url, tag: CAL_TAGS[list.length % CAL_TAGS.length] });
    });
    calendarSourcesCache = list;
    return list.length;
  });
}

function refreshConfig() {
  lastErrors = [];
  return Promise.all([
    refreshPasswords().catch(function (e) { lastErrors.push("密碼：" + e.message); return null; }),
    refreshDepts().catch(function (e) { lastErrors.push("單位代碼：" + e.message); return null; }),
    refreshNotices().catch(function (e) { lastErrors.push("跑馬燈：" + e.message); return null; }),
    refreshCalendars().catch(function (e) { lastErrors.push("行事曆來源：" + e.message); return null; })
  ]).then(function (counts) {
    lastRefreshAt = new Date().toISOString();
    return {
      passwords: counts[0],
      depts: counts[1],
      notices: counts[2],
      calendars: counts[3],
      errors: lastErrors
    };
  });
}

// 密碼保護只是「防手滑切錯單位」的軟性提醒，不是真的資料隔離
// （/api/duty 本來就把全縣資料一起回傳給前端，前端只是不渲染而已）。
// 管理員密碼可以解鎖全部大隊／分隊；其餘每個名稱（大隊或分隊皆可）
// 各自比對自己的密碼——這支函式不在乎 name 是大隊還是分隊，純粹是
// 一個 key-value 比對，分隊層級的密碼保護能力就是靠這個特性達成的。
function checkPassword(name, password) {
  if (!password) return { ok: false };
  if (passwordsCache[ADMIN_KEY] && password === passwordsCache[ADMIN_KEY]) {
    return { ok: true, admin: true };
  }
  if (passwordsCache[name] && password === passwordsCache[name]) {
    return { ok: true, admin: false };
  }
  return { ok: false };
}

// 回傳所有設了密碼的名稱（大隊名或分隊名混在同一份清單，前端會分別
// 用在「切到這個大隊」和「切到這個分隊」兩種情境的判斷上）。
function gatedNames() {
  return Object.keys(passwordsCache).filter(function (k) { return k !== ADMIN_KEY; });
}

function resolveBrigadeById(deptId) {
  return deptId && deptByIdCache[deptId] ? deptByIdCache[deptId] : null;
}

function resolveBrigadeByName(name) {
  return name && deptByNameCache[name] ? deptByNameCache[name] : null;
}

function activeNotices() {
  return noticesCache;
}

function calendarSources() {
  return calendarSourcesCache;
}

function status() {
  return {
    passwordsConfigured: !!PASSWORDS_URL,
    deptsConfigured: !!DEPTS_URL,
    noticesConfigured: !!NOTICES_URL,
    calendarsConfigured: !!CALENDARS_URL,
    gatedNames: gatedNames(),
    hasAdminPassword: !!passwordsCache[ADMIN_KEY],
    deptCount: Object.keys(deptByIdCache).length,
    noticeCount: noticesCache.length,
    calendarSourceCount: calendarSourcesCache.length,
    lastRefreshAt: lastRefreshAt,
    lastErrors: lastErrors
  };
}

module.exports = {
  refreshConfig: refreshConfig,
  checkPassword: checkPassword,
  gatedNames: gatedNames,
  resolveBrigadeById: resolveBrigadeById,
  resolveBrigadeByName: resolveBrigadeByName,
  activeNotices: activeNotices,
  calendarSources: calendarSources,
  status: status
};
