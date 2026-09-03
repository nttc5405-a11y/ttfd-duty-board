/* ============================================================
   勤務系統結構探測腳本
   用途：找出勤務表頁面的資料介面與表格結構，供看板抓取程式使用。
   本腳本「只讀取、不修改、不送出」任何資料，結果只顯示在你自己的畫面上。

   使用方式：
   1. 在 Chrome 登入 ttfd2.firemis.tw
   2. 開到勤務表列表頁，或點進某分隊的勤務表
   3. 按 F12 → 上方選「Console」（主控台）
   4. 把本檔案全部內容貼進去 → 按 Enter
   5. 畫面右下角會跳出一個文字框，按「全選複製」，貼回對話給我
   ============================================================ */

(function () {
  "use strict";

  var L = [];
  function put(s) { L.push(s); }

  put("=== 勤務系統結構探測 ===");
  put("網址：" + location.href);
  put("時間：" + new Date().toLocaleString("zh-TW"));
  put("");

  /* ---------- 1. 這個頁面呼叫過哪些資料介面 ---------- */
  put("--- 1. 資料介面（API）請求 ---");
  try {
    var res = performance.getEntriesByType("resource") || [];
    var apis = [];
    for (var i = 0; i < res.length; i++) {
      var u = res[i].name;
      if (/\/api\//i.test(u) && !/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf)(\?|$)/i.test(u)) {
        var short = u.replace(location.origin, "");
        if (apis.indexOf(short) === -1) apis.push(short);
      }
    }
    if (apis.length) {
      for (var a = 0; a < apis.length; a++) put("  " + apis[a]);
    } else {
      put("  （沒有偵測到，可能是頁面載入後才呼叫。請在頁面上按一次「查詢」再重跑本腳本）");
    }
  } catch (e) {
    put("  讀取失敗：" + e.message);
  }
  put("");

  /* ---------- 2. 頁面上的表格結構 ---------- */
  put("--- 2. 表格結構 ---");
  var tables = document.querySelectorAll("table");
  put("共找到 " + tables.length + " 個表格");
  put("");

  for (var t = 0; t < tables.length && t < 8; t++) {
    var tb = tables[t];
    var rows = tb.rows || [];
    put("[表格 " + (t + 1) + "] 共 " + rows.length + " 列");

    // 表格自身的 class，抓取程式用來定位
    put("  table class：" + (tb.className || "(無)"));

    // 前三列的內容，用來辨識這是哪張表
    for (var r = 0; r < rows.length && r < 3; r++) {
      var cells = rows[r].cells || [];
      var txt = [];
      for (var c = 0; c < cells.length && c < 12; c++) {
        var v = (cells[c].innerText || "").replace(/\s+/g, " ").trim();
        var span = cells[c].colSpan > 1 ? ("×" + cells[c].colSpan) : "";
        txt.push(v.slice(0, 14) + span);
      }
      put("  第 " + (r + 1) + " 列（" + cells.length + " 欄）：" + txt.join(" | "));
    }

    // 最後一列，確認資料範圍
    if (rows.length > 3) {
      var last = rows[rows.length - 1].cells || [];
      var lt = [];
      for (var d = 0; d < last.length && d < 12; d++) {
        lt.push((last[d].innerText || "").replace(/\s+/g, " ").trim().slice(0, 14));
      }
      put("  最後一列：" + lt.join(" | "));
    }
    put("");
  }

  /* ---------- 3. 頁面標題區的欄位 ---------- */
  put("--- 3. 標題區文字（單位／日期／主管／上班人員） ---");
  try {
    var body = (document.body.innerText || "").split("\n");
    var keys = ["單位：", "日期：", "主管：", "上班人員", "單位:", "日期:", "主管:"];
    var hit = 0;
    for (var b = 0; b < body.length && hit < 10; b++) {
      var line = body[b].trim();
      for (var k = 0; k < keys.length; k++) {
        if (line.indexOf(keys[k]) === 0) { put("  " + line.slice(0, 90)); hit++; break; }
      }
    }
    if (!hit) put("  （未偵測到，可能在列表頁而非單一分隊勤務表）");
  } catch (e2) {
    put("  讀取失敗：" + e2.message);
  }
  put("");
  put("=== 探測結束 ===");

  /* ---------- 顯示結果，方便複製 ---------- */
  var text = L.join("\n");

  var old = document.getElementById("__probe_box__");
  if (old) old.parentNode.removeChild(old);

  var box = document.createElement("div");
  box.id = "__probe_box__";
  box.setAttribute("style",
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:520px;max-width:92vw;" +
    "background:#12181f;color:#e8eef4;border:1px solid #3a4a5a;border-radius:6px;" +
    "font-family:system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.6);overflow:hidden");

  var head = document.createElement("div");
  head.setAttribute("style",
    "display:flex;align-items:center;gap:8px;padding:9px 12px;background:#1b2530;" +
    "border-bottom:1px solid #3a4a5a;font-size:13px;font-weight:700");
  head.appendChild(document.createTextNode("探測結果"));

  var btn = document.createElement("button");
  btn.textContent = "全選複製";
  btn.setAttribute("style",
    "margin-left:auto;background:#2f6fa8;color:#fff;border:0;border-radius:3px;" +
    "padding:5px 12px;font-size:12px;cursor:pointer");

  var close = document.createElement("button");
  close.textContent = "關閉";
  close.setAttribute("style",
    "background:#2a3642;color:#c8d4de;border:0;border-radius:3px;" +
    "padding:5px 12px;font-size:12px;cursor:pointer");

  head.appendChild(btn);
  head.appendChild(close);

  var ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "readonly");
  ta.setAttribute("style",
    "width:100%;height:300px;border:0;background:#0e141a;color:#cfe0ee;" +
    "font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.5;" +
    "padding:10px;resize:vertical;outline:none;box-sizing:border-box");

  btn.onclick = function () {
    ta.select();
    try { document.execCommand("copy"); btn.textContent = "已複製 ✓"; }
    catch (e3) { btn.textContent = "請手動全選複製"; }
  };
  close.onclick = function () { box.parentNode.removeChild(box); };

  box.appendChild(head);
  box.appendChild(ta);
  document.body.appendChild(box);

  console.log(text);
})();
