/* ============================================================
   全縣勤務看板採集器（局本部帳號專用）— 可讀版
   （實際使用請用 collector-county-bookmarklet.txt 的書籤版，邏輯與本檔一致）

   跟 collector.js（成功大隊自己用的採集器）是完全獨立、互不影響的
   兩支程式，差異只在：
   1. 查詢時不帶 depts 篩選（送空陣列），系統會回傳「這個帳號看得到
      的全部單位」——用局本部帳號查會拿到全縣 34 個單位，不是只有
      成功大隊自己的 6 個（已用探測書籤實測確認，見
      docs/API筆記.md 第九節）
   2. 每個單位額外標記所屬大隊（BRIGADE_BY_DEPT），供看板依大隊分組
      顯示
   3. 推送到伺服器的欄位名稱不同（countyUnits／countyTasks／
      countyOutStatus，不是 units／tasks／outStatus），伺服器會存成
      完全獨立的一份資料，不會跟成功大隊自己的資料互相覆蓋

   其餘邏輯（取得授權、交接班日期判斷、多分頁協調、伺服器沒資料時
   自動補跑）跟 collector.js 完全比照辦理，這些是已經在成功大隊的
   採集器上驗證過有效的修正，不重新發明。

   第一次執行會問你 Render 網址與通行碼（跟成功大隊那支用同一組，
   同一個伺服器），記在這台電腦的瀏覽器裡，之後不再問。
   ============================================================ */

(function () {

  var CFG_URL = "__board_endpoint";
  var CFG_TOK = "__board_token";

  var PUSH_INTERVAL_MS = 4 * 60 * 60 * 1000;
  var OUT_STATUS_INTERVAL_MS = 30 * 60 * 1000;

  // 全縣 34 個單位的大隊對照（見 docs/API筆記.md 第九節，用局本部
  // 帳號探測 shift/list 省略 depts 篩選的回應，比對畫面單位/主管
  // 欄位確認）。局本部旗下 3 個單位沒有自己的「大隊」，歸在「局本部」
  // 這個群組底下；其餘 4 個大隊各自的「大隊」本身也算進自己那組。
  var BRIGADE_BY_DEPT = {
    "593eccb1fff0d617e493b68c": "局本部",
    "593f851fa326a612c81cfcb3": "局本部",
    "696808ca4e790948451ed8eb": "局本部",

    "593f82a5a326a612c81cfc99": "台東大隊",
    "593f82d7a326a612c81cfc9a": "台東大隊",
    "696807ff4e790948451ed895": "台東大隊",
    "593f8303a326a612c81cfc9c": "台東大隊",
    "633bbc5e50266a462b420906": "台東大隊",
    "593f82e9a326a612c81cfc9b": "台東大隊",
    "593f8593a326a612c81cfcb8": "台東大隊",
    "593f8453a326a612c81cfca8": "台東大隊",
    "5a5dd762ff615e83c6001f66": "台東大隊",
    "696808634e790948451ed8bf": "台東大隊",
    "593f8465a326a612c81cfca9": "台東大隊",
    "593f8580a326a612c81cfcb7": "台東大隊",

    "593f835aa326a612c81cfc9e": "關山大隊",
    "593f8381a326a612c81cfca0": "關山大隊",
    "593f839ca326a612c81cfca1": "關山大隊",
    "593f83b0a326a612c81cfca2": "關山大隊",
    "593f8478a326a612c81cfcaa": "關山大隊",
    "593f85d0a326a612c81cfcbb": "關山大隊",
    "593f85e7a326a612c81cfcbc": "關山大隊",

    "593f836aa326a612c81cfc9f": "大武大隊",
    "593f8443a326a612c81cfca7": "大武大隊",
    "593f853fa326a612c81cfcb4": "大武大隊",
    "593f855ca326a612c81cfcb5": "大武大隊",
    "593f8431a326a612c81cfca6": "大武大隊",
    "5d8b35b1effb7b7968d08aab": "大武大隊",

    "593f8339a326a612c81cfc9d": "成功大隊",
    "5ee1d63d1679e1139fe2bbe2": "成功大隊",
    "593f83d2a326a612c81cfca4": "成功大隊",
    "5a5d9641ff615e83c6001f56": "成功大隊",
    "593f83c1a326a612c81cfca3": "成功大隊",
    "593f841ba326a612c81cfca5": "成功大隊"
  };

  function p2(n) { return n < 10 ? "0" + n : "" + n; }

  /* ---------- 狀態視窗 ---------- */

  var box, log;
  function ui() {
    var old = document.getElementById("__countyCollector__");
    if (old) old.parentNode.removeChild(old);

    box = document.createElement("div");
    box.id = "__countyCollector__";
    box.style.cssText =
      "position:fixed;right:14px;bottom:14px;z-index:2147483647;width:440px;max-width:92vw;" +
      "background:#12181f;color:#e8eef4;border:1px solid #3a4a5a;border-radius:6px;" +
      "font:13px/1.55 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.6);overflow:hidden";

    var head = document.createElement("div");
    head.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:9px 12px;background:#1b2530;" +
      "border-bottom:1px solid #3a4a5a;font-weight:700";
    head.appendChild(document.createTextNode("全縣勤務看板採集器 v1"));

    var stop = document.createElement("button");
    stop.textContent = "停止並關閉";
    stop.style.cssText =
      "margin-left:auto;background:#7E2019;color:#fff;border:0;border-radius:3px;" +
      "padding:5px 12px;font-size:12px;cursor:pointer";
    stop.onclick = function () {
      if (window.__countyCollectTimer) clearTimeout(window.__countyCollectTimer);
      if (window.__countyCollectOutTimer) clearInterval(window.__countyCollectOutTimer);
      window.__countyCollectTimer = null;
      window.__countyCollectOutTimer = null;
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

  /* ---------- 取得授權標頭（跟 collector.js 完全比照辦理） ---------- */

  function installAuthWatcher() {
    if (window.__countyCollectorPatched) return;
    window.__countyCollectorPatched = true;
    window.__countyAuth = window.__countyAuth || null;
    window.__countyWaiters = [];

    function got(v) {
      if (!v || window.__countyAuth === v) return;
      window.__countyAuth = v;
      var ws = window.__countyWaiters;
      window.__countyWaiters = [];
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
      if (window.__countyAuth) return resolve(window.__countyAuth);
      var done = false;
      var to = setTimeout(function () {
        if (done) return;
        done = true;
        window.__countyWaiters = (window.__countyWaiters || []).filter(function (f) { return f !== onGot; });
        reject(new Error("等待逾時"));
      }, timeoutMs);
      function onGot(v) {
        if (done) return;
        done = true;
        clearTimeout(to);
        resolve(v);
      }
      window.__countyWaiters = window.__countyWaiters || [];
      window.__countyWaiters.push(onGot);
    });
  }

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
    if (window.__countyAuth) return Promise.resolve(window.__countyAuth);

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
    var cols = [items[0]].concat(calls).concat(items.slice(1));

    var slots = {};
    for (var h = 0; h < 24; h++) {
      var bucket = {};
      cols.forEach(function (c) { bucket[c] = []; });

      (d.tables || []).forEach(function (t) {
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
      brigade: BRIGADE_BY_DEPT[row.dept] || "其他",
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

  function tasksOf(d, name, brigade) {
    return (d.works || []).map(function (w) {
      var t = "";
      if (w.start != null && w.end != null) t = p2(w.start) + "-" + p2(w.end);
      else if (w.start != null) t = p2(w.start);
      return {
        unit: name,
        brigade: brigade,
        time: t,
        name: w.content || w.raw || "",
        who: (w.users || []).map(function (u) { return u.name || u.no; }).join(","),
        car: (w.calls || []).join("、"),
        loc: w.place || ""
      };
    });
  }

  /* ---------- 單位名稱（跟 collector.js 的 nameMap() 同一套邏輯） ---------- */

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

  // 全縣有 34 個單位，畫面表格行數比成功大隊那 6 個多很多，穩定
  // 渲染需要的時間可能更長，一樣用輪詢等內容連續兩次不再變化。
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

  function buildOutStatus(statusList, deptToInfo) {
    var out = [];
    (statusList || []).forEach(function (u) {
      var info = deptToInfo[u.dept] || { name: u.dept, brigade: BRIGADE_BY_DEPT[u.dept] || "其他" };
      (u.outDeptUsers || []).forEach(function (p) {
        if (p.leave === true) return;
        out.push({
          unit: info.name,
          brigade: info.brigade,
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

  // 上一次完整採集算出的「單位 ID → {名稱,大隊}」對照
  var lastDeptToInfo = null;

  // 交接班是 08:00，不是午夜，跟 collector.js 的 dutyDayOf() 同一套。
  function dutyDayOf(d) {
    var base = new Date(d);
    if (base.getHours() < 8) base.setDate(base.getDate() - 1);
    return base;
  }

  function collect(auth, cfg, quiet) {
    if (!quiet) say("向系統查詢全縣勤務表列表…");

    var now = new Date();
    var dutyDay = dutyDayOf(now);
    var today = dutyDay.getFullYear() + "-" + p2(dutyDay.getMonth() + 1) + "-" + p2(dutyDay.getDate());

    // 不帶 depts 篩選（送空陣列），系統會回傳這個帳號看得到的全部
    // 單位——這是用探測書籤實測確認過的行為，不是猜測。
    var body = {
      depts: [],
      start: dutyDay.toISOString(),
      end: null,
      select: "dept date manager workers day night updatedAt",
      limit: 999
    };

    var deptToInfo = {};

    return waitForNameMap(10000).then(function (names) {
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
                  var brigade = BRIGADE_BY_DEPT[row.dept] || "其他";
                  deptToInfo[row.dept] = { name: nm, brigade: brigade };
                  units.push(transform(row, d, nm));
                  tasks = tasks.concat(tasksOf(d, nm, brigade));
                  if (!quiet) say("  [" + brigade + "] " + nm + "　日 " + row.day + " ／ 夜 " + row.night);
                })
                .catch(function (e) {
                  if (!quiet) say("  取細表失敗：" + e.message, "#F2A93B");
                });
            });
          }, Promise.resolve()).then(function () {
            lastDeptToInfo = deptToInfo;
            return { date: today, collectedAt: new Date().toISOString(), countyUnits: units, countyTasks: tasks, countyOutStatus: [] };
          });
        })
        .then(function (payload) {
          return api("POST", "/api/v2/shift-status/list", { depts: [] }, auth)
            .then(function (statusList) {
              payload.countyOutStatus = buildOutStatus(statusList, deptToInfo);
              if (!quiet && payload.countyOutStatus.length) {
                say("  即時出勤 " + payload.countyOutStatus.length + " 人");
              }
              return payload;
            })
            .catch(function (e) {
              if (!quiet) say("  即時出勤狀態查詢失敗（不影響其餘資料）：" + e.message, "#F2A93B");
              return payload;
            });
        })
        .then(function (payload) {
          if (!payload.countyUnits.length) throw new Error("沒有取得任何單位資料");
          if (!quiet) say("送往看板伺服器…");
          return fetch(cfg.url.replace(/\/$/, "") + "/api/push-county", {
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

  function collectOutStatusOnly(auth, cfg, quiet) {
    if (!lastDeptToInfo) {
      if (!quiet) say("尚未有完整資料可對照單位名稱，這次即時出勤更新先跳過。", "#F2A93B");
      return Promise.resolve(null);
    }
    return api("POST", "/api/v2/shift-status/list", { depts: [] }, auth)
      .then(function (statusList) {
        var outStatus = buildOutStatus(statusList, lastDeptToInfo);
        return fetch(cfg.url.replace(/\/$/, "") + "/api/push-county", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Push-Token": cfg.tok },
          body: JSON.stringify({ countyOutStatus: outStatus })
        }).then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok || !j.ok) {
              var err = new Error(j.error || ("伺服器回應 " + r.status));
              err.status = r.status;
              throw err;
            }
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
    tok = prompt("請輸入推送通行碼\n（即 Render 上設定的 PUSH_TOKEN，跟成功大隊那支用同一組）");
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
            "　單位 " + p.countyUnits.length + " 個、勤務 " + p.countyTasks.length + " 項", "#3DBE6B");
      })
      .catch(function (e) {
        say("失敗：" + e.message, "#E4392B");
        if (/401|403/.test(e.message)) {
          window.__countyAuth = null;
          say("授權可能已過期，下次自動更新時會重新取得。", "#F2A93B");
        }
      });
  }

  var DAILY_HOUR = 8;

  function msUntilNextRun(now) {
    var next = new Date(now);
    next.setHours(DAILY_HOUR, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    var msTo = next.getTime() - now.getTime();
    return Math.min(PUSH_INTERVAL_MS, msTo);
  }

  function scheduleNext() {
    var wait = msUntilNextRun(new Date());
    window.__countyCollectTimer = setTimeout(function () {
      run(true);
      scheduleNext();
    }, wait);
  }

  function runOutStatus(quiet) {
    getAuth()
      .then(function (auth) {
        return collectOutStatusOnly(auth, cfg, quiet);
      })
      .then(function (outStatus) {
        if (!outStatus) return;
        var t = new Date();
        say("即時出勤更新　" + p2(t.getHours()) + ":" + p2(t.getMinutes()) +
            "　" + outStatus.length + " 人在外", "#3DBE6B");
      })
      .catch(function (e) {
        say("即時出勤更新失敗：" + e.message, "#F2A93B");
        if (/401|403/.test(e.message)) window.__countyAuth = null;
        if (e.status === 409) {
          say("伺服器沒有完整資料（可能剛重新啟動），改為立即執行一次完整採集…", "#F2A93B");
          run(true);
        }
      });
  }

  /* ---------- 多分頁協調 ----------
     用跟成功大隊那支不同的 key，避免互相干擾——這兩支收集的是不同
     資料、給不同帳號用，不應該讓其中一支關掉另一支。 */
  var LEADER_KEY = "ttfd_county_collector_leader_v1";
  var myLeaderId = Date.now() + "_" + Math.random().toString(36).slice(2);

  function claimLeadership() {
    try {
      localStorage.setItem(LEADER_KEY, JSON.stringify({ id: myLeaderId, at: Date.now() }));
    } catch (e) {}
  }

  function retireOldTab() {
    say("偵測到有較新的分頁已接手，本分頁停止自動更新，可以關閉。", "#93A6B6");
    if (window.__countyCollectTimer) clearTimeout(window.__countyCollectTimer);
    if (window.__countyCollectOutTimer) clearInterval(window.__countyCollectOutTimer);
    window.__countyCollectTimer = null;
    window.__countyCollectOutTimer = null;
    try { window.close(); } catch (e) {}
  }

  window.addEventListener("storage", function (e) {
    if (e.key !== LEADER_KEY || !e.newValue) return;
    try {
      if (JSON.parse(e.newValue).id !== myLeaderId) retireOldTab();
    } catch (err) {}
  });

  claimLeadership();

  run(false);

  if (window.__countyCollectTimer) clearTimeout(window.__countyCollectTimer);
  scheduleNext();

  if (window.__countyCollectOutTimer) clearInterval(window.__countyCollectOutTimer);
  window.__countyCollectOutTimer = setInterval(function () { runOutStatus(true); }, OUT_STATUS_INTERVAL_MS);

  say("已開啟自動更新：完整資料每 4 小時（並在每天 08:00 額外多跑一次），即時出勤每 30 分鐘。關閉本視窗即停止。", "#93A6B6");
  say("提醒：本分頁須保持開啟才會自動更新；系統若因閒置逾時登出，下次更新會自動嘗試重新取得授權。", "#93A6B6");
})();
