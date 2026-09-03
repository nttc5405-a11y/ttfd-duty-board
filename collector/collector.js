/* ============================================================
   勤務看板採集器 — 可讀版
   （實際使用請用 collector-bookmarklet.txt 的書籤版，邏輯與本檔一致）

   在 ttfd2 勤務系統頁面上執行。它會：
   1. 取得目前登入身分的授權標頭（不讀、不存你的帳號密碼）
   2. 向系統要今天成功大隊 6 個單位的勤務表
   3. 把「以人為單位」的排班轉成「以時段為單位」的看板格式
   4. 送到你自己的 Render 伺服器，供電視牆與手機讀取
   5. 之後每 4 小時自動重跑一次（勤務表修正不頻繁，不需要更密集）

   第一次執行會問你 Render 網址與通行碼，記在這台電腦的瀏覽器裡，之後不再問。
   ============================================================ */

(function () {

  var CFG_URL = "__board_endpoint";
  var CFG_TOK = "__board_token";

  // 自動更新間隔。勤務表修正不頻繁，不需要更密集；拉長間隔也降低
  // 系統登入授權過期、每次都要重新攔截的機率。
  var PUSH_INTERVAL_MS = 4 * 60 * 60 * 1000;

  // 成功大隊及所屬 5 個分隊的單位 ID（取自系統前端自身的查詢條件）
  var DEPTS = [
    "5ee1d63d1679e1139fe2bbe2",
    "593f83d2a326a612c81cfca4",
    "593f8339a326a612c81cfc9d",
    "593f841ba326a612c81cfca5",
    "593f83c1a326a612c81cfca3",
    "5a5d9641ff615e83c6001f56"
  ];

  function p2(n) { return n < 10 ? "0" + n : "" + n; }

  /* ---------- 狀態視窗 ---------- */

  var box, log;
  function ui() {
    var old = document.getElementById("__collector__");
    if (old) old.parentNode.removeChild(old);

    box = document.createElement("div");
    box.id = "__collector__";
    box.style.cssText =
      "position:fixed;right:14px;bottom:14px;z-index:2147483647;width:440px;max-width:92vw;" +
      "background:#12181f;color:#e8eef4;border:1px solid #3a4a5a;border-radius:6px;" +
      "font:13px/1.55 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.6);overflow:hidden";

    var head = document.createElement("div");
    head.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:9px 12px;background:#1b2530;" +
      "border-bottom:1px solid #3a4a5a;font-weight:700";
    head.appendChild(document.createTextNode("勤務看板採集器"));

    var stop = document.createElement("button");
    stop.textContent = "停止並關閉";
    stop.style.cssText =
      "margin-left:auto;background:#7E2019;color:#fff;border:0;border-radius:3px;" +
      "padding:5px 12px;font-size:12px;cursor:pointer";
    stop.onclick = function () {
      if (window.__collectTimer) clearInterval(window.__collectTimer);
      window.__collectTimer = null;
      box.parentNode.removeChild(box);
    };
    head.appendChild(stop);

    log = document.createElement("div");
    log.style.cssText =
      "padding:10px 12px;max-height:300px;overflow:auto;" +
      "font:11.5px/1.6 ui-monospace,Consolas,monospace;color:#cfe0ee";

    box.appendChild(head);
    box.appendChild(log);
    document.body.appendChild(box);
  }

  function say(s, color) {
    var d = document.createElement("div");
    if (color) d.style.color = color;
    d.textContent = s;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  /* ---------- 取得授權標頭 ----------
     不讀帳號密碼。這個系統把授權權杖只放在網頁的記憶體裡（不落地存
     localStorage / sessionStorage / Cookie，已實測確認），所以改用
     「在旁邊看」的方式：攔截頁面自己發出的請求，取得它使用的
     Authorization 標頭值，沿用來發我們自己的查詢。
     權杖只存在這次執行的記憶體裡，重新整理頁面就消失，不落地存檔。 */

  function installAuthWatcher() {
    if (window.__collectorPatched) return;
    window.__collectorPatched = true;
    window.__collectorAuth = window.__collectorAuth || null;
    window.__collectorWaiters = [];

    function got(v) {
      if (!v || window.__collectorAuth === v) return;
      window.__collectorAuth = v;
      var ws = window.__collectorWaiters;
      window.__collectorWaiters = [];
      ws.forEach(function (fn) { fn(v); });
    }

    var oSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      if (/^authorization$/i.test(k)) got(v);
      return oSetHeader.apply(this, arguments);
    };

    var oFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var h = init && init.headers, v = null;
        if (h) {
          if (typeof Headers !== "undefined" && h instanceof Headers) {
            v = h.get("authorization") || h.get("Authorization");
          } else if (Array.isArray(h)) {
            h.forEach(function (p) { if (/^authorization$/i.test(p[0])) v = p[1]; });
          } else {
            for (var k in h) { if (/^authorization$/i.test(k)) v = h[k]; }
          }
        }
        if (v) got(v);
      } catch (e) {}
      return oFetch.apply(this, arguments);
    };
  }

  function waitForAuth(timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (window.__collectorAuth) return resolve(window.__collectorAuth);
      var done = false;
      var to = setTimeout(function () {
        if (done) return;
        done = true;
        window.__collectorWaiters = (window.__collectorWaiters || []).filter(function (f) { return f !== onGot; });
        reject(new Error("等待逾時"));
      }, timeoutMs);
      function onGot(v) {
        if (done) return;
        done = true;
        clearTimeout(to);
        resolve(v);
      }
      window.__collectorWaiters = window.__collectorWaiters || [];
      window.__collectorWaiters.push(onGot);
    });
  }

  // 自動點一下畫面上的「查詢」按鈕，觸發系統送出一次帶授權的請求
  function clickQueryButton() {
    var nodes = document.querySelectorAll("button, a, [role='button']");
    for (var i = 0; i < nodes.length; i++) {
      if ((nodes[i].textContent || "").trim() === "查詢") { nodes[i].click(); return true; }
    }
    var all = document.querySelectorAll("*");
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      if (el.children.length === 0 && (el.textContent || "").trim() === "查詢") {
        (el.closest("button, a, [role='button']") || el).click();
        return true;
      }
    }
    return false;
  }

  function getAuth() {
    installAuthWatcher();
    if (window.__collectorAuth) return Promise.resolve(window.__collectorAuth);

    say("嘗試自動觸發查詢以取得授權…");
    var clicked = clickQueryButton();
    say(clicked ? "已自動點擊查詢，等待系統回應…" : "找不到查詢按鈕，請手動按一次頁面上的「查詢」。", clicked ? null : "#F2A93B");

    return waitForAuth(15000).catch(function () {
      say("尚未取得授權，請確認已登入並停在勤務表列表頁，手動按一次「查詢」。", "#F2A93B");
      return waitForAuth(60000);
    });
  }

  /* ---------- 呼叫系統 API ---------- */

  function api(method, path, body, auth) {
    var opt = {
      method: method,
      headers: { "Accept": "application/json", "Authorization": auth }
    };
    if (body) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    return fetch(path, opt).then(function (r) {
      if (!r.ok) throw new Error(path + " 回應 " + r.status);
      return r.json();
    });
  }

  /* ---------- 把以人為單位的 tables 轉成以時段為單位 ---------- */

  function transform(row, d, name) {
    var items = (d.items && d.items.length) ? d.items : ["值班", "備勤", "休息"];
    var calls = d.calls || [];
    // 畫面欄位順序：值班 → 各車 → 備勤 → 休息
    var cols = [items[0]].concat(calls).concat(items.slice(1));

    var slots = {};
    for (var h = 0; h < 24; h++) {
      var bucket = {};
      cols.forEach(function (c) { bucket[c] = []; });

      (d.tables || []).forEach(function (t) {
        // 小時 key 是當天的絕對小時 0-23，不是 startHour 的位移
        var arr = t[String(h)] || t[h];
        if (!arr || !arr.length) return;
        arr.forEach(function (a) {
          if (!a || !a.value) return;
          if (!bucket[a.value]) bucket[a.value] = [];
          bucket[a.value].push({ n: t.name || t.no, i: (a.index == null ? 0 : a.index) });
        });
      });

      var cell = {};
      cols.forEach(function (c) {
        cell[c] = bucket[c]
          .sort(function (a, b) { return a.i - b.i; })
          .map(function (x) { return x.n; })
          .join(",");
      });

      slots[p2(h) + "-" + p2(h + 1)] = {
        duty: cell[items[0]] || "",
        cars: calls.map(function (c) { return cell[c] || ""; }),
        standby: cell[items[1]] || "",
        rest: cell[items[2]] || ""
      };
    }

    var mg = d.manager || row.manager || {};
    var workers = d.workers || row.workers || [];

    return {
      name: name,
      deptId: row.dept,
      chief: (mg.kind || "") + (mg.name || ""),
      day: row.day || 0,
      night: row.night || 0,
      ids: workers.map(function (w) { return w.no; }).join(","),
      roster: workers.map(function (w) { return w.name; }).join("、"),
      cars: calls,
      slots: slots,
      note: String(d.remark || "").replace(/\r?\n/g, "　").slice(0, 400),
      leave: d.leave || null,
      updatedAt: row.updatedAt || d.updatedAt || ""
    };
  }

  function tasksOf(d, name) {
    return (d.works || []).map(function (w) {
      var t = "";
      if (w.start != null && w.end != null) t = p2(w.start) + "-" + p2(w.end);
      else if (w.start != null) t = p2(w.start);
      return {
        unit: name,
        time: t,
        name: w.content || w.raw || "",
        who: (w.users || []).map(function (u) { return u.name || u.no; }).join(","),
        car: (w.calls || []).join("、"),
        loc: w.place || ""
      };
    });
  }

  /* ---------- 單位名稱 ----------
     list 回傳只有單位 ID，不含名稱。系統回傳的順序不保證與畫面列表
     順序一致（實測發現過對調），所以不能用「第幾筆對第幾列」這種
     位置對應。改用「主管」欄位的文字做內容比對：API 回傳的 manager
     物件（kind+name）與畫面上「主管」那欄顯示的文字是同一份資料，
     兩邊内容一定一致，用它當 key 就不受順序影響。 */

  function nameMap() {
    var m = {};
    try {
      var tb = document.querySelector("table");
      if (!tb) return m;
      var rows = tb.rows, ui2 = -1, mi = -1;
      var head = rows[0].cells;
      for (var c = 0; c < head.length; c++) {
        var h = (head[c].innerText || "").trim();
        if (h === "單位") ui2 = c;
        if (h === "主管") mi = c;
      }
      if (ui2 < 0 || mi < 0) return m;
      for (var r = 1; r < rows.length; r++) {
        var nm = (rows[r].cells[ui2].innerText || "").trim();
        var mgr = (rows[r].cells[mi].innerText || "").trim();
        if (nm && mgr) m[mgr] = nm;
      }
    } catch (e) {}
    return m;
  }

  /* ---------- 主流程 ---------- */

  function collect(auth, cfg, quiet) {
    if (!quiet) say("向系統查詢勤務表列表…");

    var now = new Date();
    var today = now.getFullYear() + "-" + p2(now.getMonth() + 1) + "-" + p2(now.getDate());

    var body = {
      depts: DEPTS,
      start: now.toISOString(),
      end: null,
      select: "dept date manager workers day night updatedAt",
      limit: 999
    };

    var names = nameMap();

    return api("POST", "/api/v2/shift/list", body, auth)
      .then(function (list) {
        if (!quiet) say("取得 " + list.length + " 個單位，逐一取細表…");
        var units = [], tasks = [];

        return list.reduce(function (chain, row) {
          return chain.then(function () {
            return api("GET", "/api/v2/shift/" + row._id, null, auth)
              .then(function (d) {
                var mg = row.manager || {};
                var mgrText = (mg.kind || "") + (mg.name || "");
                var nm = names[mgrText] || ("單位…" + String(row.dept).slice(-6));
                units.push(transform(row, d, nm));
                tasks = tasks.concat(tasksOf(d, nm));
                if (!quiet) say("  " + nm + "　日 " + row.day + " ／ 夜 " + row.night);
              })
              .catch(function (e) {
                if (!quiet) say("  取細表失敗：" + e.message, "#F2A93B");
              });
          });
        }, Promise.resolve()).then(function () {
          return { date: today, collectedAt: new Date().toISOString(), units: units, tasks: tasks };
        });
      })
      .then(function (payload) {
        if (!payload.units.length) throw new Error("沒有取得任何單位資料");
        if (!quiet) say("送往看板伺服器…");
        return fetch(cfg.url.replace(/\/$/, "") + "/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Push-Token": cfg.tok },
          body: JSON.stringify(payload)
        }).then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok || !j.ok) throw new Error(j.error || ("伺服器回應 " + r.status));
            return payload;
          });
        });
      });
  }

  /* ---------- 啟動 ---------- */

  ui();

  var url = localStorage.getItem(CFG_URL);
  var tok = localStorage.getItem(CFG_TOK);

  if (!url) {
    url = prompt("請輸入看板伺服器網址\n例如 https://duty-board.onrender.com");
    if (!url) { say("已取消。", "#F2A93B"); return; }
    localStorage.setItem(CFG_URL, url.trim());
  }
  if (!tok) {
    tok = prompt("請輸入推送通行碼\n（即 Render 上設定的 PUSH_TOKEN）");
    if (!tok) { say("已取消。", "#F2A93B"); return; }
    localStorage.setItem(CFG_TOK, tok.trim());
  }

  var cfg = { url: localStorage.getItem(CFG_URL), tok: localStorage.getItem(CFG_TOK) };
  say("看板伺服器：" + cfg.url);

  function run(quiet) {
    getAuth()
      .then(function (auth) {
        say("已取得授權，開始查詢…");
        return collect(auth, cfg, quiet);
      })
      .then(function (p) {
        var t = new Date();
        say("完成　" + p2(t.getHours()) + ":" + p2(t.getMinutes()) +
            "　單位 " + p.units.length + " 個、勤務 " + p.tasks.length + " 項", "#3DBE6B");
      })
      .catch(function (e) {
        say("失敗：" + e.message, "#E4392B");
        if (/401|403/.test(e.message)) {
          // 授權可能過期，清掉快取，下次自動重新攔截
          window.__collectorAuth = null;
          say("授權可能已過期，下次自動更新時會重新取得。", "#F2A93B");
        }
      });
  }

  run(false);

  if (window.__collectTimer) clearInterval(window.__collectTimer);
  window.__collectTimer = setInterval(function () { run(true); }, PUSH_INTERVAL_MS);
  say("已開啟自動更新，每 4 小時一次。關閉本視窗即停止。", "#93A6B6");
  say("提醒：本分頁須保持開啟才會自動更新；系統若因閒置逾時登出，下次更新會自動嘗試重新取得授權。", "#93A6B6");
})();
