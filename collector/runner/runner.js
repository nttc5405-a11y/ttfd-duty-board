/* ============================================================
   勤務看板「背景採集」程式

   做什麼：用一個專用的 Chrome 資料夾（裡面存著你的登入狀態），在背景
   （看不到視窗）打開 ttfd2 頁面，把現有的採集器程式碼塞進去跑一次，
   等結果出來就關掉。排程器定時執行它，就不用手動開瀏覽器分頁。

   用法（在這個資料夾打開命令提示字元）：
     node runner.js --setup      第一次設定：會跳出 Chrome 視窗，你自己登入，
                                 並在命令列輸入看板網址與通行碼
     node runner.js              背景執行一次採集（排程器就是跑這個）
     node runner.js --county     同上，但跑全縣版採集器（局本部帳號用，
                                 要用另一個資料夾，見下面 --profile）

   選項：
     --county            改用 collector-county.user.js；預設用另一個登入資料夾 profile-county
     --profile 名稱      指定登入資料夾名稱（預設 profile；--county 時預設 profile-county）
     --show              背景執行時改成顯示視窗（除錯用）

   結束代碼：0 成功；2 登入已過期（需要重新跑 --setup）；
             3 採集失敗；4 逾時；1 其他錯誤。
   紀錄寫在 logs\ 資料夾，每天一個檔。
   ============================================================ */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright-core");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const COUNTY = has("--county");
const SETUP = has("--setup");
const SHOW = has("--show");
const PROFILE_NAME = val("--profile") || (COUNTY ? "profile-county" : "profile");
const SCRIPT_FILE = COUNTY ? "collector-county.user.js" : "collector.user.js";

const HERE = __dirname;
const PROFILE_DIR = path.join(HERE, PROFILE_NAME);
const LOG_DIR = path.join(HERE, "logs");
const SCRIPT_PATH = path.join(HERE, "..", SCRIPT_FILE);
const TARGET = "https://ttfd2.firemis.tw/#/shift/list";
const CFG_URL = "__board_endpoint";
const CFG_TOK = "__board_token";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
];

function p2(n) { return n < 10 ? "0" + n : "" + n; }
function stamp(d) {
  d = d || new Date();
  return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) +
    " " + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
}

function log(msg) {
  const line = "[" + stamp() + "][" + PROFILE_NAME + "] " + msg;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const d = new Date();
    const f = path.join(LOG_DIR, "run-" + d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + ".log");
    fs.appendFileSync(f, line + "\n", "utf8");
  } catch (e) { /* 紀錄寫不進去不影響主流程 */ }
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && fs.existsSync(p)) return p;
  throw new Error("找不到 Chrome，請確認已安裝 Google Chrome。");
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 檢查機制：記錄每次結果，連續失敗時在電腦螢幕跳出訊息 ---- */
const STATUS_FILE = path.join(LOG_DIR, "status-" + PROFILE_NAME + ".json");

function notify(text) {
  try {
    // msg 不加 /W 就不會卡住等人按確定，不會擋到排程下一次執行
    require("child_process").execFileSync("msg", [process.env.USERNAME || "*", "/TIME:3600", text],
      { timeout: 10000, windowsHide: true });
    log("已在螢幕跳出提醒訊息");
  } catch (e) {
    log("提醒訊息送不出去（不影響採集）：" + (e && e.message ? e.message.split("\n")[0] : e));
  }
}

function recordAndNotify(code) {
  if (SETUP) return;
  let st = { fails: 0, lastOk: null };
  try { Object.assign(st, JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"))); } catch (e) { /* 第一次執行 */ }
  if (code === 0) {
    if (st.fails > 0) log("已恢復正常（先前連續失敗 " + st.fails + " 次）");
    st.fails = 0;
    st.lastOk = stamp();
  } else {
    st.fails++;
    const n = st.fails;
    if (code === 2) {
      // 登入過期：第 1 次馬上提醒，之後每 4 次（約 2 小時）再提醒一次
      if (n % 4 === 1) {
        notify("【勤務看板】背景採集已停止：ttfd2 登入過期。請雙擊 collector\\runner 資料夾裡的「重新登入.bat」登入一次。");
      }
    } else if (n >= 2 && n % 4 === 2) {
      // 其他失敗：連續 2 次才提醒（偶發一次不吵人），之後每 4 次再提醒
      notify("【勤務看板】背景採集連續失敗 " + n + " 次。請看 collector\\runner\\logs 資料夾裡今天的紀錄檔。");
    }
  }
  st.lastCode = code;
  st.lastRun = stamp();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(st, null, 2), "utf8");
  } catch (e) { /* 寫不進去不影響主流程 */ }
}

/* 頁面頂端顯示「尚未登入」＝沒有登入（已實測）。
   頁面是單頁應用程式，剛載入時內容可能還沒出來，所以輪詢等它穩定。 */
async function loginState(page, maxMs) {
  const end = Date.now() + maxMs;
  let last = "unknown";
  let inCount = 0;
  while (Date.now() < end) {
    let s = null;
    try {
      s = await page.evaluate(() => ({
        txt: document.body ? document.body.innerText : "",
        pw: !!document.querySelector("input[type=password]"),
      }));
    } catch (e) { /* 換頁中 */ }
    if (s) {
      if (/尚未登入/.test(s.txt) || s.pw) { last = "out"; inCount = 0; }
      else if (s.txt.length > 30) {
        // 沒有「尚未登入」字樣、也沒有密碼欄，且頁面有內容：連續 2 次看到才算已登入
        inCount++;
        if (inCount >= 2) return "in";
        last = "unknown";
      }
    }
    await sleep(700);
  }
  return last;
}

/* 把採集器塞進頁面跑，等狀態視窗出現「完成」或「失敗」。 */
async function injectAndWait(page, timeoutMs) {
  const src = fs.readFileSync(SCRIPT_PATH, "utf8");
  await page.evaluate(src);

  const end = Date.now() + timeoutMs;
  let shown = 0;
  while (Date.now() < end) {
    let lines = [];
    try {
      lines = await page.evaluate(() => {
        const b = (document.getElementById("__collector__") || document.getElementById("__countyCollector__"));
        return b ? b.innerText.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      });
    } catch (e) { /* 忽略 */ }
    for (; shown < lines.length; shown++) log("  採集器：" + lines[shown]);

    const text = lines.join("\n");
    if (/完成\s*\d{1,2}:\d{2}/.test(text)) return "ok";
    if (/尚未設定看板伺服器網址或通行碼/.test(text)) return "noconfig";
    if (/失敗：/.test(text)) {
      // 失敗訊息出現後多等一下，看是否是暫時性的（採集器內部有重試）
      await sleep(4000);
      try {
        lines = await page.evaluate(() => {
          const b = (document.getElementById("__collector__") || document.getElementById("__countyCollector__"));
          return b ? b.innerText.split("\n").map((s) => s.trim()).filter(Boolean) : [];
        });
      } catch (e) { /* 忽略 */ }
      for (; shown < lines.length; shown++) log("  採集器：" + lines[shown]);
      if (/完成\s*\d{1,2}:\d{2}/.test(lines.join("\n"))) return "ok";
      return "fail";
    }
    await sleep(1000);
  }
  return "timeout";
}

async function launch(headless) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: findChrome(),
    headless,
    viewport: { width: 1366, height: 800 },
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

async function setup() {
  log("=== 第一次設定 ===");
  console.log("\n接下來會跳出一個 Chrome 視窗。");
  console.log("請在那個視窗裡自己登入 ttfd2（帳號密碼只在視窗裡輸入，不會經過這支程式）。\n");

  const { ctx, page } = await launch(false);
  try {
    await page.goto(TARGET, { waitUntil: "load", timeout: 60000 });

    // 之前已經存過網址／通行碼的話，直接按 Enter 就沿用，不用重打
    const old = await page.evaluate(([k1, k2]) => ({ u: localStorage.getItem(k1), t: localStorage.getItem(k2) }), [CFG_URL, CFG_TOK]);
    let endpoint = old.u || "";
    let token = old.t || "";
    if (endpoint && token) {
      const a = await ask("這個資料夾已經存有看板網址與通行碼（" + endpoint + "）。直接按 Enter 沿用，輸入 n 再按 Enter 重設：");
      if (/^n/i.test(a)) { endpoint = ""; token = ""; }
    }
    if (!endpoint || !token) {
      endpoint = (await ask("看板伺服器網址（例如 https://ttfd-duty-board.onrender.com）：")).replace(/\/+$/, "");
      if (!/^https:\/\//.test(endpoint)) { console.log("網址要以 https:// 開頭，請重跑。"); return 1; }
      token = await ask("看板通行碼（貼上後按 Enter）：");
      if (!token) { console.log("通行碼不能空白，請重跑。"); return 1; }
      await page.evaluate(([k1, v1, k2, v2]) => { localStorage.setItem(k1, v1); localStorage.setItem(k2, v2); },
        [CFG_URL, endpoint, CFG_TOK, token]);
      log("看板網址與通行碼已存進專用資料夾（通行碼不會寫進紀錄檔）。");
    }

    console.log("\n請在 Chrome 視窗登入。登入成功後這裡會自動繼續（最多等 10 分鐘）。");
    const end = Date.now() + 10 * 60 * 1000;
    let ok = false;
    while (Date.now() < end) {
      const st = await loginState(page, 2000);
      if (st === "in") { ok = true; break; }
      await sleep(1500);
    }
    if (!ok) { log("等不到登入完成，設定中止。"); return 4; }
    log("偵測到已登入，立刻試跑一次採集…");

    await page.goto(TARGET, { waitUntil: "load", timeout: 60000 });
    await sleep(4000);
    const r = await injectAndWait(page, 150000);
    log("試跑結果：" + r);
    if (r === "ok") {
      console.log("\n設定完成。之後直接執行：node runner.js（背景、不用視窗）。");
      return 0;
    }
    console.log("\n試跑沒成功，請看上面的紀錄。");
    return 3;
  } finally {
    await ctx.close();
  }
}

async function runOnce() {
  if (!fs.existsSync(PROFILE_DIR)) {
    log("找不到登入資料夾（" + PROFILE_NAME + "），請先執行：node runner.js --setup" + (COUNTY ? " --county" : ""));
    return 2;
  }
  log("開始背景採集（" + SCRIPT_FILE + "）");
  const { ctx, page } = await launch(SHOW ? false : true);
  try {
    await page.goto(TARGET, { waitUntil: "load", timeout: 60000 });
    const st = await loginState(page, 25000);
    if (st !== "in") {
      log("登入狀態：" + (st === "out" ? "已登出（需要重新登入）" : "頁面沒有正常載入") +
        "。請執行：node runner.js --setup" + (COUNTY ? " --county" : ""));
      return st === "out" ? 2 : 1;
    }
    // 等頁面內容穩定再注入（採集器自己也會等表格，這裡只是再多給一點時間）
    await sleep(3000);
    const r = await injectAndWait(page, 150000);
    if (r === "ok") { log("採集完成"); return 0; }
    if (r === "noconfig") { log("專用資料夾裡沒有看板網址／通行碼，請執行 --setup"); return 2; }
    if (r === "fail") { log("採集失敗（細節見上面採集器訊息）"); return 3; }
    log("逾時，採集沒有在 150 秒內完成");
    return 4;
  } finally {
    await ctx.close();
  }
}

(async () => {
  let code = 1;
  try {
    code = SETUP ? await setup() : await runOnce();
  } catch (e) {
    log("錯誤：" + (e && e.message ? e.message : e));
    code = 1;
  }
  recordAndNotify(code);
  process.exit(code);
})();
