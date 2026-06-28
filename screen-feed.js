import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const WHITELIST_PATH = path.join(DATA_DIR, "screen-whitelist.json");
const RECENT_PATH = path.join(DATA_DIR, "screen-recent.json");
const STATE_PATH = path.join(DATA_DIR, "screen-state.json");

const DEFAULT_WHITELIST = [
  "com.eg.android.AlipayGphone",
  "com.tencent.mm.plugin.wallet",
  "com.tencent.mm.plugin.remittance",
  "com.icbc",
  "com.icbc.mobilebank",
  "com.chinamworld.bocmbci",
  "com.ccb.longjiCBS",
  "com.ccb.fund",
  "com.greenpoint.android.mc10086.activity",
  "com.cmcc.cmvideo",
  "com.chinatelecom.bestpayclient",
  "com.ct.client",
  "com.ct.10000",
  "com.shenmo.app",
];

const DEFAULT_KEYWORDS = [
  "pay", "wallet", "bank", "alipay", "wxpay", "tenpay",
  "qpay", "unionpay", "10086", "10010", "10000", "cmcc",
  "chinatelecom", "chinamobile", "password", "验证码", "银行卡",
  "身份证", "手机号", "住址", "支付", "付款", "转账", "银行",
];

function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(WHITELIST_PATH)) {
    fs.writeFileSync(WHITELIST_PATH, JSON.stringify({
      packages: DEFAULT_WHITELIST,
      keywords: DEFAULT_KEYWORDS,
    }, null, 2));
  }
  if (!fs.existsSync(RECENT_PATH)) fs.writeFileSync(RECENT_PATH, "[]");
  if (!fs.existsSync(STATE_PATH)) {
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      updatedAt: 0,
      currentPkg: "unknown",
      currentDesc: "",
      previousPkg: "",
      previousDesc: "",
      firstSeenAt: 0,
      lastSeenAt: 0,
      source: "",
      changed: false,
      count: 0,
    }, null, 2));
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); }
  catch { return fallback; }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function loadWhitelist() {
  return readJson(WHITELIST_PATH, { packages: DEFAULT_WHITELIST, keywords: DEFAULT_KEYWORDS });
}

function saveWhitelist(wl) {
  writeJson(WHITELIST_PATH, wl);
}

function isBlocked(pkg, wl, text = "") {
  const hay = `${pkg || ""}\n${text || ""}`.toLowerCase();
  if (!pkg || pkg === "unknown") {
    return wl.keywords.some(kw => hay.includes(String(kw).toLowerCase()));
  }
  const lower = pkg.toLowerCase();
  if (wl.packages.some(p => String(p).toLowerCase() === lower)) return true;
  if (wl.keywords.some(kw => hay.includes(String(kw).toLowerCase()))) return true;
  return false;
}

function loadRecent() {
  return readJson(RECENT_PATH, []);
}

function saveRecent(arr) {
  writeJson(RECENT_PATH, arr.slice(-80));
}

function loadScreenState() {
  ensureFiles();
  return readJson(STATE_PATH, {
    updatedAt: 0,
    currentPkg: "unknown",
    currentDesc: "",
    previousPkg: "",
    previousDesc: "",
    firstSeenAt: 0,
    lastSeenAt: 0,
    source: "",
    changed: false,
    count: 0,
  });
}

function saveScreenState(state) {
  writeJson(STATE_PATH, state);
}

function cleanDescription(text) {
  return String(text || "")
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, "")
    .replace(/^用户正在|^用户在|^她正在正在/g, "她正在")
    .replace(/^她在浏览B$/g, "她在刷B站")
    .replace(/^她在B站$/g, "她在刷B站内容")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function appendRecentEvent(event) {
  const recent = loadRecent();
  recent.push(event);
  saveRecent(recent);
  updateScreenState(event);
}

function updateScreenState(event) {
  const now = Number(event.ts || Date.now());
  const old = loadScreenState();
  const sameScene =
    old.currentPkg === event.pkg &&
    old.currentDesc === event.desc &&
    now - Number(old.lastSeenAt || 0) < 10 * 60 * 1000;

  const state = {
    updatedAt: now,
    currentPkg: event.pkg || "unknown",
    currentDesc: event.desc || "",
    previousPkg: sameScene ? old.previousPkg : old.currentPkg,
    previousDesc: sameScene ? old.previousDesc : old.currentDesc,
    firstSeenAt: sameScene ? (old.firstSeenAt || now) : now,
    lastSeenAt: now,
    source: event.source || "unknown",
    changed: !sameScene,
    count: sameScene ? Number(old.count || 0) + 1 : 1,
    rawSignature: event.rawSignature || old.rawSignature || "",
    lastParsedAt: now,
    lastRawTextLen: Number(event.rawTextLen || old.lastRawTextLen || 0),
    lastScreenshotParsedAt: event.source === "screenshot" ? now : Number(old.lastScreenshotParsedAt || 0),
  };

  saveScreenState(state);
  return state;
}

function minutesBetween(a, b) {
  const n = Math.max(0, Math.round((Number(b || 0) - Number(a || 0)) / 60000));
  if (!Number.isFinite(n) || n <= 0) return "刚刚";
  if (n < 60) return `约${n}分钟`;
  return `约${Math.round(n / 60)}小时`;
}

function isFresh(ts, maxAgeMs = 15 * 60 * 1000) {
  return ts && Date.now() - Number(ts) <= maxAgeMs;
}

const TEXT_PARSE_MIN_INTERVAL_MS = 45_000;        // 后端模型概括：45秒内不重复
const TEXT_FORCE_REFRESH_MS = 3 * 60_000;         // 同页面停太久：3分钟可重新看一眼
const SCREENSHOT_PARSE_MIN_INTERVAL_MS = 5 * 60_000; // 截图：5分钟内不重复

function normalizeRawText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function simpleHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return String(h >>> 0);
}

function shouldParseScreenText({ text, pkg, ts }) {
  const now = Number(ts || Date.now());
  const state = loadScreenState();
  const currentPkg = pkg || "unknown";
  const raw = normalizeRawText(text);
  const rawSignature = simpleHash(raw);
  const lastParsedAt = Number(state.lastParsedAt || state.lastSeenAt || 0);
  const pkgChanged = currentPkg !== (state.currentPkg || "unknown");
  const sameRaw = state.rawSignature && state.rawSignature === rawSignature;
  const elapsed = lastParsedAt ? now - lastParsedAt : Infinity;

  if (!raw || raw.length < 6) {
    return { ok: false, reason: "too-short", rawSignature, rawTextLen: raw.length };
  }

  if (!pkgChanged && elapsed < TEXT_PARSE_MIN_INTERVAL_MS) {
    return {
      ok: false,
      reason: "too-soon",
      rawSignature,
      rawTextLen: raw.length,
      nextParseInMs: TEXT_PARSE_MIN_INTERVAL_MS - elapsed,
    };
  }

  if (!pkgChanged && sameRaw && elapsed < TEXT_FORCE_REFRESH_MS) {
    return {
      ok: false,
      reason: "duplicate",
      rawSignature,
      rawTextLen: raw.length,
      nextParseInMs: TEXT_FORCE_REFRESH_MS - elapsed,
    };
  }

  return { ok: true, reason: "parse", rawSignature, rawTextLen: raw.length };
}

function shouldParseScreenshot({ pkg, ts }) {
  const now = Number(ts || Date.now());
  const state = loadScreenState();
  const currentPkg = pkg || "unknown";
  const last = Number(state.lastScreenshotParsedAt || 0);
  const pkgChanged = currentPkg !== (state.currentPkg || "unknown");
  const elapsed = last ? now - last : Infinity;

  if (!pkgChanged && elapsed < SCREENSHOT_PARSE_MIN_INTERVAL_MS) {
    return {
      ok: false,
      reason: "screenshot-too-soon",
      nextParseInMs: SCREENSHOT_PARSE_MIN_INTERVAL_MS - elapsed,
    };
  }

  return { ok: true, reason: "parse-screenshot" };
}


// 1. 截图提炼
async function describeScreenshot(jpegBase64, model, keys) {
  if (!keys || !keys.length) return null;
  const prompt = `下面是用户当前手机屏幕截图。请用一句自然的话概括她正在做什么，30字内。
要求：
- 尽量保留App名、页面类型、关键对象。
- 如果有商品/视频/搜索词/图片主题，尽量说出来。
- 不要说“用户在看”，直接说“她在……”
- 如果屏幕模糊、纯色或无内容，输出“屏幕无明显内容”。
只输出一句话。`;

  for (const key of keys) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const body = {
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: jpegBase64 } },
          ],
        }],
        generationConfig: { temperature: 0.25, maxOutputTokens: 120 },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      };
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const text = cleanDescription(j?.candidates?.[0]?.content?.parts?.[0]?.text);
      if (text) return text;
    } catch {
      continue;
    }
  }
  return null;
}

// 2. 纯文本提炼
async function describeScreenText(screenText, pkg, model, keys) {
  if (!keys || !keys.length || !screenText || !screenText.trim()) return null;
  const cleanText = screenText.trim().substring(0, 1400);
  const prompt = `下面是用户手机屏幕上无障碍服务抓到的文字，当前App包名：${pkg || "unknown"}。
---
${cleanText}
---
请用一句自然的话概括她正在做什么，30字内。
要求：
- 尽量保留App名、页面类型、关键对象，例如B站、购物、盲盒、小兔子、聊天、搜索。
- 不要过度省略成“她在B站”这种废话，要说明她在B站做什么。
- 不要说“用户在看”，直接说“她在……”
- 如果文字无意义，输出“屏幕无明显内容”。
只输出一句话。`;

  for (const key of keys) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const body = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 120 },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      };
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const text = cleanDescription(j?.candidates?.[0]?.content?.parts?.[0]?.text);
      if (text) return text;
    } catch {
      continue;
    }
  }
  return null;
}

export function install(app, opts = {}) {
  ensureFiles();
  const getModel = opts.getModel || (() => "gemini-2.5-flash");
  const getKeys = opts.getKeys || (() => []);

  app.post("/api/screen-feed", async (req, res) => {
    try {
      const { image, foregroundPackage, timestamp } = req.body || {};
      if (!image) return res.status(400).json({ error: "missing image" });

      const wl = loadWhitelist();
      if (isBlocked(foregroundPackage, wl)) {
        return res.json({ ok: true, skipped: true, reason: "whitelist", pkg: foregroundPackage });
      }

      const decision = shouldParseScreenshot({
        pkg: foregroundPackage,
        ts: timestamp || Date.now(),
      });
      if (!decision.ok) {
        return res.json({
          ok: true,
          skipped: true,
          reason: decision.reason,
          nextParseInMs: decision.nextParseInMs || 0,
        });
      }

      const description = await describeScreenshot(image, getModel(), getKeys());
      if (!description || description === "屏幕无明显内容") {
        return res.json({ ok: true, skipped: true, reason: "no-content" });
      }

      const event = {
        ts: timestamp || Date.now(),
        pkg: foregroundPackage || "unknown",
        desc: description,
        source: "screenshot",
      };
      appendRecentEvent(event);

      console.log(`  📱 屏幕(截图)：[${event.pkg}] ${event.desc}`);
      res.json({ ok: true, description: event.desc, state: loadScreenState() });
    } catch (e) {
      console.error("screen-feed error:", e.message);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  app.post("/api/screen-text", async (req, res) => {
    try {
      const { text, foregroundPackage, timestamp } = req.body || {};
      if (!text || !text.trim()) return res.status(400).json({ error: "missing text" });

      const wl = loadWhitelist();
      if (isBlocked(foregroundPackage, wl, text)) {
        return res.json({ ok: true, skipped: true, reason: "whitelist", pkg: foregroundPackage });
      }

      const decision = shouldParseScreenText({
        text,
        pkg: foregroundPackage,
        ts: timestamp || Date.now(),
      });
      if (!decision.ok) {
        return res.json({
          ok: true,
          skipped: true,
          reason: decision.reason,
          nextParseInMs: decision.nextParseInMs || 0,
        });
      }

      const description = await describeScreenText(text, foregroundPackage, getModel(), getKeys());
      if (!description || description === "屏幕无明显内容") {
        return res.json({ ok: true, skipped: true, reason: "no-content" });
      }

      const event = {
        ts: timestamp || Date.now(),
        pkg: foregroundPackage || "unknown",
        desc: description,
        source: "text",
        rawSignature: decision.rawSignature,
        rawTextLen: decision.rawTextLen,
      };
      appendRecentEvent(event);

      console.log(`  📱 屏幕(文本)：[${event.pkg}] ${event.desc}`);
      res.json({ ok: true, description: event.desc, state: loadScreenState() });
    } catch (e) {
      console.error("screen-text error:", e.message);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  app.get("/api/screen-whitelist", (req, res) => {
    res.json(loadWhitelist());
  });

  app.post("/api/screen-whitelist", (req, res) => {
    const { action, value, type } = req.body || {};
    const wl = loadWhitelist();
    if (action === "add" && value) {
      const list = type === "keyword" ? wl.keywords : wl.packages;
      if (!list.includes(value)) list.push(value);
    } else if (action === "remove" && value) {
      const list = type === "keyword" ? wl.keywords : wl.packages;
      const idx = list.indexOf(value);
      if (idx >= 0) list.splice(idx, 1);
    } else if (action === "replace" && Array.isArray(value)) {
      if (type === "keyword") wl.keywords = value;
      else wl.packages = value;
    }
    saveWhitelist(wl);
    res.json(wl);
  });

  app.get("/api/screen-feed/recent", (req, res) => {
    const n = parseInt(req.query.n || "10", 10);
    res.json(loadRecent().slice(-n));
  });

  app.get("/api/screen-state", (req, res) => {
    res.json(loadScreenState());
  });

  console.log("  📱 屏幕陪伴模块已升级：当前状态 + 主聊天上下文");
}

export function buildScreenContext() {
  ensureFiles();

  const state = loadScreenState();
  const recent = loadRecent().slice(-5);
  if (!state.currentDesc && !recent.length) return "";

  const fresh = isFresh(state.lastSeenAt);
  if (!fresh) {
    return "\n\n【沈秣的屏幕感知】\n最近暂时没有新的屏幕动态。不要主动提屏幕，除非何尘逸问起。\n";
  }

  const stay = minutesBetween(state.firstSeenAt, state.lastSeenAt);
  const changedText = state.changed && state.previousDesc
    ? `刚从“${state.previousDesc}”切到这里。`
    : "";

  const recentLines = recent.slice(-3).map(r => {
    const dt = new Date(r.ts).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `[${dt}] ${r.desc}`;
  });

  return `

【沈秣当前能感知到的手机环境】
当前：${state.currentDesc}
当前App包名：${state.currentPkg || "unknown"}
停留：${stay}
来源：${state.source || "unknown"}
${changedText ? `变化：${changedText}\n` : ""}最近几条：
${recentLines.join("\n")}

使用规则：
- 这是陪伴用的环境感，不要机械播报。
- 何尘逸说“你看这个/这个/它/好可爱/能买吗/我还在刷”等指代词时，优先结合当前屏幕理解。
- 可以自然提一句，比如“还盯着这个呢”“这页你停了一会儿”，但不要每次都说“我看到你的屏幕”。
- 涉及支付、银行、验证码、隐私信息时立刻忽略，不要复述。
`;
}
