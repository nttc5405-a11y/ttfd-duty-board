/* ============================================================
   Google 行事曆（iCal 訂閱網址）讀取與整理

   輸入：一組公開或私人的 iCal 訂閱網址（.ics），不需要登入、不需要
   OAuth——網址本身就是通行證，這也是為什麼私人網址要當密碼一樣存
   在環境變數裡，不要放進程式碼或 git 記錄。

   輸出：跟看板前端（web/index.html 的 CAL 陣列）同一種格式：
     [{ d:"YYYY-MM-DD", items:[{t 或 allday, title, loc, cal, tag, link}] }]

   這支檔案只負責「抓、解析、整理」，不負責排程、不負責供應——那些
   在 server.js。單一日曆來源失敗不會讓其他來源跟著失敗（用
   Promise.allSettled）。
   ============================================================ */

"use strict";

const ical = require("node-ical");

const WINDOW_DAYS = 45; // 只保留從今天起算 45 天內的行程，避免無限累積

function p2(n) {
  return n < 10 ? "0" + n : "" + n;
}

function dateKey(d) {
  return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
}

function timeRange(start, end) {
  return p2(start.getHours()) + ":" + p2(start.getMinutes()) + "–" +
         p2(end.getHours()) + ":" + p2(end.getMinutes());
}

function isAllDay(ev) {
  return ev.datetype === "date" || !!(ev.start && ev.start.dateOnly === true);
}

// 從訂閱網址本身取出日曆 ID，組「查看完整內容」連結要用
// 例：.../calendar/ical/ttfd007%40eoc.ttfd.gov.tw/public/basic.ics
function calendarIdFromUrl(url) {
  var m = String(url).match(/\/ical\/([^/]+)\//);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return m[1];
  }
}

// Google 行事曆網頁連結的 eid，是 base64("事件ID 日曆ID")（不含尾端 =）。
// 已用真實事件驗證過這個公式正確。
function buildLink(uid, calendarId) {
  if (!uid || !calendarId) return "";
  var rawId = String(uid).replace(/@google\.com$/i, "");
  var raw = rawId + " " + calendarId;
  var eid = Buffer.from(raw, "utf8").toString("base64").replace(/=+$/, "");
  return "https://www.google.com/calendar/event?eid=" + eid;
}

function trimLoc(loc) {
  if (!loc) return "";
  // 地址常常一整串很長，只取逗號前第一段，看板欄位窄，夠用就好
  return String(loc).split(",")[0].split("，")[0].trim().slice(0, 40);
}

async function fetchOneSource(src) {
  var data = await ical.async.fromURL(src.url, {});
  var calendarId = calendarIdFromUrl(src.url);

  var now = new Date();
  var rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var rangeEnd = new Date(rangeStart.getTime() + WINDOW_DAYS * 86400000);

  // 重複事件的「例外場次」（單一場次被改期或取消）另外記下來，
  // 展開重複規則時遇到同一天就用例外內容取代，而不是兩個都顯示。
  var overridesByUid = {};
  Object.keys(data).forEach(function (k) {
    var ev = data[k];
    if (ev.type === "VEVENT" && ev.recurrenceid) {
      overridesByUid[ev.uid] = overridesByUid[ev.uid] || [];
      overridesByUid[ev.uid].push(ev);
    }
  });

  var out = [];

  function pushEvent(ev, start, end) {
    if (!ev.summary) return;
    var allday = isAllDay(ev);
    var item = {
      d: dateKey(start),
      allday: allday,
      t: allday ? null : timeRange(start, end),
      title: String(ev.summary).trim(),
      loc: trimLoc(ev.location),
      cal: src.name,
      tag: src.tag,
      link: buildLink(ev.uid, calendarId)
    };
    out.push(item);
  }

  Object.keys(data).forEach(function (k) {
    var ev = data[k];
    if (ev.type !== "VEVENT") return;
    if (ev.recurrenceid) return; // 例外場次在下面比對重複規則時處理
    if (ev.status === "CANCELLED") return;

    if (ev.rrule) {
      var dates = [];
      try {
        dates = ev.rrule.between(rangeStart, rangeEnd, true);
      } catch (e) {
        dates = [];
      }
      var duration = (ev.end && ev.start) ? (ev.end.getTime() - ev.start.getTime()) : 0;

      dates.forEach(function (occStart) {
        var key = dateKey(occStart);
        var overrides = overridesByUid[ev.uid] || [];
        var ov = null;
        for (var i = 0; i < overrides.length; i++) {
          if (overrides[i].recurrenceid && dateKey(overrides[i].recurrenceid) === key) {
            ov = overrides[i];
            break;
          }
        }
        if (ov) {
          if (ov.status !== "CANCELLED" && ov.start && ov.end) pushEvent(ov, ov.start, ov.end);
          return;
        }
        pushEvent(ev, occStart, new Date(occStart.getTime() + duration));
      });
    } else {
      if (!ev.start || !ev.end) return;
      if (ev.end < rangeStart || ev.start > rangeEnd) return;
      pushEvent(ev, ev.start, ev.end);
    }
  });

  return out;
}

async function fetchAllCalendars(sources) {
  var results = await Promise.allSettled(sources.map(fetchOneSource));

  var flat = [];
  var errors = [];
  results.forEach(function (r, i) {
    if (r.status === "fulfilled") {
      flat = flat.concat(r.value);
    } else {
      errors.push(sources[i].name + "：" + (r.reason && r.reason.message));
    }
  });

  var byDate = {};
  flat.forEach(function (item) {
    if (!byDate[item.d]) byDate[item.d] = [];
    byDate[item.d].push(item);
  });

  var days = Object.keys(byDate).sort().map(function (d) {
    var items = byDate[d]
      .slice()
      .sort(function (a, b) {
        if (a.allday !== b.allday) return a.allday ? -1 : 1;
        return (a.t || "").localeCompare(b.t || "");
      })
      .map(function (it) {
        var o = { title: it.title, cal: it.cal, tag: it.tag };
        if (it.allday) o.allday = true; else o.t = it.t;
        if (it.loc) o.loc = it.loc;
        if (it.link) o.link = it.link;
        return o;
      });
    return { d: d, items: items };
  });

  return { days: days, errors: errors, fetchedAt: new Date().toISOString() };
}

module.exports = { fetchAllCalendars };
