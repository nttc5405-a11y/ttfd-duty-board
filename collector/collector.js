/* ============================================================
   勤務看板採集器 — 可讀版
   （實際使用請用 collector-bookmarklet.txt 的書籤版，邏輯與本檔一致）

   在 ttfd2 勤務系統頁面上執行。它會：
   1. 取得目前登入身分的授權標頭（不讀、不存你的帳號密碼）
   2. 向系統要今天成功大隊 6 個單位的勤務表
   3. 把「以人為單位」的排班轉成「以時段為單位」的看板格式
   4. 送到你自己的 Render 伺服器，供電視牆與手機讀取
   5. 完整資料每 4 小時自動重跑一次（勤務表修正不頻繁，不需要更密集），
      即時出勤狀態另外每 30 分鐘查一次（只打 shift-status/list 這支，
      不重查整份勤務表，對系統負擔比較小，資料也比較即時）

   第一次執行會問你 Render 網址與通行碼，記在這台電腦的瀏覽器裡，之後不再問。
   ============================================================ */

(function () {

  var CFG_URL = "__board_endpoint";
  var CFG_TOK = "__board_token";

  // 完整資料的自動更新間隔。勤務表修正不頻繁，不需要更密集；拉長
  // 間隔也降低系統登入授權過期、每次都要重新攔截的機率。
  var PUSH_INTERVAL_MS = 4 * 60 * 60 * 1000;

  // 即時出勤狀態的更新間隔，比完整資料短，因為這塊是分秒在變的
  // 即時狀態，但也不需要短於看板本身向伺服器要資料的頻率（5 分鐘），
  // 短於那個看板也不會更快顯示，只是白白多打請求。
  var OUT_STATUS_INTERVAL_MS = 30 * 60 * 1000;

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
    head.appendChild(document.createTextNode("勤務看板採集器 v10"));

    var stop = document.createElement("button");
    stop.textContent = "停止並關閉";
    stop.style.cssText =
      "margin-left:auto;background:#7E2019;color:#fff;border:0;border-radius:3px;" +
      "padding:5px 12px;font-size:12px;cursor:pointer";
    stop.onclick = function () {
      if (window.__collectTimer) clearTimeout(window.__collectTimer);
      if (window.__collectOutTimer) clearInterval(window.__collectOutTimer);
      window.__collectTimer = null;
      window.__collectOutTimer = null;
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

  // 跟 waitForNameMap() 同一個道理：自動模式一開頁面就立刻嘗試點
  // 「查詢」按鈕，這時候 Angular 路由可能還沒渲染出按鈕，只檢查一次
  // 找不到就放棄，會導致後面誤用「其他背景請求剛好夾帶的授權」
  // （可能是尚未完整、或範圍不對的權杖），打 shift/list 直接 401。
  // 正解：跟讀表格一樣用輪詢，多等幾秒讓按鈕真的出現再點。
  function waitForQueryClick(maxWaitMs) {
    return new Promise(function (resolve) {
      var waited = 0, step = 300;
      (function poll() {
        if (clickQueryButton()) { resolve(true); return; }
        waited += step;
        if (waited >= maxWaitMs) { resolve(false); return; }
        setTimeout(poll, step);
      })();
    });
  }

  function getAuth() {
    installAuthWatcher();
    if (window.__collectorAuth) return Promise.resolve(window.__collectorAuth);

    say("嘗試自動觸發查詢以取得授權…");
    return waitForQueryClick(10000).then(function (clicked) {
      say(clicked ? "已自動點擊查詢，等待系統回應…" : "找不到查詢按鈕，請手動按一次頁面上的「查詢」。", clicked ? null : "#F2A93B");

      return waitForAuth(15000).catch(function () {
        say("尚未取得授權，請確認已登入並停在勤務表列表頁，手動按一次「查詢」。", "#F2A93B");
        return waitForAuth(60000);
      });
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

  // 自動模式一開頁面就會立刻嘗試採集，這時候畫面上的表格可能還在
  // 渲染中（尤其是自動觸發查詢、不是人手動等頁面穩定後才點）。
  // 直接讀一次表格常常抓到空表格，導致單位名稱整批退回代碼顯示。
  // 正解：輪詢等表格內容連續兩次讀到同樣的筆數（判斷已經穩定），
  // 或等到上限時間，才把目前讀到的結果拿去用。
  function waitForNameMap(maxWaitMs) {
    return new Promise(function (resolve) {
      var waited = 0, step = 300, lastCount = -1, stableTicks = 0;
      (function poll() {
        var m = nameMap();
        var count = Object.keys(m).length;
        if (count > 0 && count === lastCount) stableTicks++;
        else stableTicks = 0;
        lastCount = count;
        waited += step;
        if ((count > 0 && stableTicks >= 2) || waited >= maxWaitMs) resolve(m);
        else setTimeout(poll, step);
      })();
    });
  }

  /* ---------- 主流程 ---------- */

  // 把 shift-status/list 的回應整理成看板要用的「即時出勤」格式。
  // 只留不在隊、且不是請假的人（請假已經在「今日未到勤」顯示過了，
  // 這裡只留真的在外出勤/外出的即時狀態）。刻意只挑這幾欄，原始回應
  // 裡的內部 ID、系統雜項欄位一律不帶出去。
  // unit 這個名稱是「這個分頁當下算出來的」，可能因為前面提到的各種
  // 時序問題而不準；額外帶上原始 dept ID，讓伺服器可以用它手上最新、
  // 最完整的單位對照表重新校正一次，不管是哪個分頁、哪個時間點送來的
  // 都一樣準——不能只靠「客戶端這次剛好算對」。
  function buildOutStatus(statusList, deptToName) {
    var out = [];
    (statusList || []).forEach(function (u) {
      var unitName = deptToName[u.dept] || u.dept;
      (u.outDeptUsers || []).forEach(function (p) {
        if (p.leave === true) return;
        out.push({
          unit: unitName,
          dept: u.dept,
          name: p.name || p.no || "",
          reason: p.recordKind || "",
          car: (p.recordCalls || []).join("、"),
          since: p.statusAt || ""
        });
      });
    });
    return out;
  }

  // 上一次完整採集算出的「單位 ID → 單位名稱」對照，讓即時出勤的
  // 快速查詢不用重新查一次勤務表列表就能標出單位名稱。
  var lastDeptToName = null;

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

    var deptToName = {};

    return waitForNameMap(8000).then(function (names) {
      if (!quiet && !Object.keys(names).length) {
        say("提醒：畫面單位列表尚未載入完成，單位名稱暫時以代碼顯示。", "#F2A93B");
      }

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
                  deptToName[row.dept] = nm;
                  units.push(transform(row, d, nm));
                  tasks = tasks.concat(tasksOf(d, nm));
                  if (!quiet) say("  " + nm + "　日 " + row.day + " ／ 夜 " + row.night);
                })
                .catch(function (e) {
                  if (!quiet) say("  取細表失敗：" + e.message, "#F2A93B");
                });
            });
          }, Promise.resolve()).then(function () {
            lastDeptToName = deptToName;
            return { date: today, collectedAt: new Date().toISOString(), units: units, tasks: tasks, outStatus: [] };
          });
        })
        .then(function (payload) {
          // 即時出勤狀態是加分項目，查不到也不該讓整次採集失敗。
          return api("POST", "/api/v2/shift-status/list", { depts: DEPTS }, auth)
            .then(function (statusList) {
              payload.outStatus = buildOutStatus(statusList, deptToName);
              if (!quiet && payload.outStatus.length) {
                say("  即時出勤 " + payload.outStatus.length + " 人");
              }
              return payload;
            })
            .catch(function (e) {
              if (!quiet) say("  即時出勤狀態查詢失敗（不影響其餘資料）：" + e.message, "#F2A93B");
              return payload;
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
    });
  }

  // 只查即時出勤狀態、不重查整份勤務表的輕量版本，給 30 分鐘排程用。
  // 用「快速推送」（body 只有 outStatus）送到伺服器，伺服器那邊會
  // 合併進現有資料，不會把勤務表洗掉。
  function collectOutStatusOnly(auth, cfg, quiet) {
    if (!lastDeptToName) {
      if (!quiet) say("尚未有完整資料可對照單位名稱，這次即時出勤更新先跳過。", "#F2A93B");
      return Promise.resolve(null);
    }
    return api("POST", "/api/v2/shift-status/list", { depts: DEPTS }, auth)
      .then(function (statusList) {
        var outStatus = buildOutStatus(statusList, lastDeptToName);
        return fetch(cfg.url.replace(/\/$/, "") + "/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Push-Token": cfg.tok },
          body: JSON.stringify({ outStatus: outStatus })
        }).then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok || !j.ok) throw new Error(j.error || ("伺服器回應 " + r.status));
            return outStatus;
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

  /* ---------- 排程 ----------
     不是單純每 4 小時跑一次：如果距離下次固定排程之間會跨過當天的
     07:00，就提前在 07:00 那個時間點多跑一次，讓新的一天一開始就有
     新鮮資料，而不是要等到 4 小時的排程剛好轉到才更新。
     這只在「這個分頁從半夜到隔天都沒被關掉」時才有意義——電腦關機、
     分頁被關掉都會讓這個排程跟著消失，隔天早上還是需要有人登入後
     點一次書籤。 */
  var DAILY_HOUR = 7;

  function msUntilNextRun(now) {
    var next7 = new Date(now);
    next7.setHours(DAILY_HOUR, 0, 0, 0);
    if (next7 <= now) next7.setDate(next7.getDate() + 1);
    var msTo7 = next7.getTime() - now.getTime();
    return Math.min(PUSH_INTERVAL_MS, msTo7);
  }

  function scheduleNext() {
    var wait = msUntilNextRun(new Date());
    window.__collectTimer = setTimeout(function () {
      run(true);
      scheduleNext();
    }, wait);
  }

  // 即時出勤的獨立排程，比完整資料短，只打 shift-status/list 這支。
  function runOutStatus(quiet) {
    getAuth()
      .then(function (auth) {
        return collectOutStatusOnly(auth, cfg, quiet);
      })
      .then(function (outStatus) {
        // 尚無單位對照，collectOutStatusOnly 已經有訊息了
        if (!outStatus) return;
        var t = new Date();
        say("即時出勤更新　" + p2(t.getHours()) + ":" + p2(t.getMinutes()) +
            "　" + outStatus.length + " 人在外", "#3DBE6B");
      })
      .catch(function (e) {
        say("即時出勤更新失敗：" + e.message, "#F2A93B");
        if (/401|403/.test(e.message)) window.__collectorAuth = null;
      });
  }

  run(false);

  if (window.__collectTimer) clearTimeout(window.__collectTimer);
  scheduleNext();

  if (window.__collectOutTimer) clearInterval(window.__collectOutTimer);
  window.__collectOutTimer = setInterval(function () { runOutStatus(true); }, OUT_STATUS_INTERVAL_MS);

  say("已開啟自動更新：完整資料每 4 小時（並在每天 07:00 額外多跑一次），即時出勤每 30 分鐘。關閉本視窗即停止。", "#93A6B6");
  say("提醒：本分頁須保持開啟才會自動更新；系統若因閒置逾時登出，下次更新會自動嘗試重新取得授權。", "#93A6B6");
})();
