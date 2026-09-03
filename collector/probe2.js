/* ============================================================
   勤務系統 API 格式探測（第二階段）— 可讀版
   （實際使用請用 probe2-bookmarklet.txt 的書籤版，內容與本檔一致）

   目的：知道 /api/v2/shift/list 與 /api/v2/shift/{id} 送什麼參數、回什麼格式，
        才寫得出採集器。

   做法：它不會自己去呼叫任何 API，而是「在旁邊看」系統自己發出的請求。
        你按查詢、點分隊，它就記下那些請求與回應的「欄位結構」。

   安全設計：
   - 只記錄欄位名稱與型別，值一律截短到 20 個字
   - 欄位名稱含 token / jwt / auth / password / secret 者，值一律顯示 ***
   - 結果只顯示在你自己的畫面上，不送到任何地方
   - 重新整理頁面後攔截器就消失，不會常駐

   用法：
   1. 點第一次書籤 → 跳出「攔截器已安裝」提示
   2. 在頁面上按一次「查詢」，或點進某個分隊的勤務表
   3. 點第二次書籤 → 跳出結果框，全選複製給我
   ============================================================ */

(function () {

  // 把 JSON 摘要成「欄位結構」，不輸出完整內容
  function S(o, d) {
    d = d || 0;
    if (d > 4) return "…";
    if (o === null) return "null";
    if (Array.isArray(o)) return o.length ? ("[" + S(o[0], d + 1) + "] x" + o.length) : "[]";
    if (typeof o === "object") {
      var ks = Object.keys(o), out = [];
      for (var i = 0; i < ks.length && i < 30; i++) {
        var k = ks[i];
        if (/token|jwt|auth|password|secret|pwd/i.test(k)) { out.push(k + ":***"); continue; }
        out.push(k + ":" + S(o[k], d + 1));
      }
      if (ks.length > 30) out.push("…共" + ks.length + "欄");
      return "{" + out.join(", ") + "}";
    }
    var s = String(o);
    return typeof o + "(" + (s.length > 20 ? s.slice(0, 20) + "…" : s) + ")";
  }

  function R(t) {
    try { return S(JSON.parse(t)); }
    catch (e) { return "非JSON, 前150字: " + t.slice(0, 150); }
  }

  // 第一次執行：安裝攔截器
  if (!window.__cap) {
    window.__cap = [];

    var of = window.fetch;
    window.fetch = function () {
      var u = arguments[0], o = arguments[1] || {};
      var url = (typeof u === "string") ? u : (u && u.url) || "";
      var p = of.apply(this, arguments);
      if (/\/api\//.test(url)) {
        p.then(function (r) {
          r.clone().text().then(function (t) {
            window.__cap.push({
              m: o.method || "GET", u: url,
              b: o.body ? String(o.body).slice(0, 300) : "",
              s: r.status, r: R(t)
            });
          }).catch(function () {});
        }).catch(function () {});
      }
      return p;
    };

    var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__m = m; this.__u = u;
      return oo.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (b) {
      var x = this;
      if (/\/api\//.test(x.__u || "")) {
        x.addEventListener("load", function () {
          window.__cap.push({
            m: x.__m, u: x.__u,
            b: b ? String(b).slice(0, 300) : "",
            s: x.status, r: R(String(x.responseText || ""))
          });
        });
      }
      return os.apply(this, arguments);
    };

    alert("攔截器已安裝。\n\n請現在按一次頁面上的「查詢」按鈕，\n或點進某個分隊的勤務表，\n然後再點一次這個書籤看結果。");
    return;
  }

  // 第二次執行：顯示攔截結果
  var L = ["=== 攔截結果 ===", "URL: " + location.href,
           "共攔截 " + window.__cap.length + " 筆", ""];

  for (var i = 0; i < window.__cap.length && i < 12; i++) {
    var c = window.__cap[i];
    L.push("[" + (i + 1) + "] " + c.m + " " + c.u);
    L.push("  status: " + c.s);
    if (c.b) L.push("  送出: " + c.b);
    L.push("  回應: " + c.r);
    L.push("");
  }

  var d = document.createElement("textarea");
  d.value = L.join("\n");
  d.style.cssText = "position:fixed;right:10px;bottom:10px;z-index:2147483647;" +
    "width:560px;max-width:92vw;height:380px;background:#0e141a;color:#cfe0ee;" +
    "font:11.5px/1.5 monospace;padding:10px;border:2px solid #3a4a5a;" +
    "border-radius:5px;box-shadow:0 8px 30px rgba(0,0,0,.6)";
  d.title = "雙擊可關閉";
  d.ondblclick = function () { d.parentNode.removeChild(d); };
  document.body.appendChild(d);
  d.select();
})();
