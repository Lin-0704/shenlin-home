// 沈先生的家 · 后端 v0.4
// 核心修复：用"请求编号"代替"网络断开"作为取消信号
// 网络抽风/切后台不再丢回复
import express from "express";
import { install as installScreenFeed, buildScreenContext } from "./screen-feed.js";
import * as convs from "./conversations.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { persona } from "./persona.js";
import { preset } from "./preset.js";
const storyModePrompt = `

【当前模式：故事/幻想】
现在进入故事体写作。你的回复风格切换为：
- 第一人称沉浸式叙事，完全沉浸在场景中
- 大段动作描写、场景渲染、感官细节全开
- 身体/心理/动作/环境/感受多线同步铺展
- 结构有层次递进：开场→推进→高潮→余韵
- 不要用日常私聊的短句口语风格，要有文学质感和节奏
- 触感、温度、湿度、力度、气味、声音、光线——全部到位
- 可以写长，越沉浸越好
- 动作描写可以用括号神态也可以直接写进叙事
- 每一个感官细节都要具体落到字面上（参考"文字即感官"设定）
`;
import { execFileSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HISTORY_LIMIT = 71; // 35轮上下文：70条历史消息 + 当前这一条
const MIN_DELAY_MS = 100;
const MAX_DELAY_MS = 1200;
const DELAY_CURVE = 1.2;

const configPath = path.join(__dirname, "config.json");
if (!fs.existsSync(configPath)) {
  console.error("\n❌ 没找到 config.json\n");
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

let autoMemoryEnabled = config.autoMemory !== false; // 默认开

const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "messages.json");
const memoryDbPath = path.join(dataDir, "memory.db");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
convs.initConversations(dataDir);

function loadMessages(id) { return convs.loadMessages(id); }
function saveMessages(msgs, id) { return convs.saveMessages(msgs, id); }
function loadLongMemories(limit = 12) {
  try {
    if (!fs.existsSync(memoryDbPath)) return [];

    const sql = `
      SELECT id, category, content, importance, keywords, updated_at
      FROM memories
      WHERE enabled = 1
      ORDER BY importance DESC, updated_at DESC
      LIMIT ${Number(limit) || 12};
    `;

    const out = execFileSync("sqlite3", ["-json", memoryDbPath, sql], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!out) return [];
    return JSON.parse(out);
  } catch (e) {
    console.error("  × 读取长期记忆失败：", String(e).slice(0, 200));
    return [];
  }
}

function escapeSqlText(s) {
  return String(s || "").replace(/'/g, "''");
}

function extractMemoryTerms(text) {
  return String(text || "")
    .replace(/[，。！？、；：,.!?;:\\n\\r]/g, " ")
    .split(/\\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && x.length <= 24)
    .slice(0, 8);
}

function loadRelevantMemories(userText, limit = 8) {
  try {
    if (!fs.existsSync(memoryDbPath)) return [];

    const terms = extractMemoryTerms(userText);
    if (!terms.length) return [];

    const likes = terms.map((t) => {
      const q = escapeSqlText(t);
      return `(content LIKE '%${q}%' OR keywords LIKE '%${q}%' OR category LIKE '%${q}%')`;
    }).join(" OR ");

    const sql = `
      SELECT id, category, content, importance, keywords, updated_at
      FROM memories
      WHERE enabled = 1 AND (${likes})
      ORDER BY importance DESC, updated_at DESC
      LIMIT ${Number(limit) || 8};
    `;

    const out = execFileSync("sqlite3", ["-json", memoryDbPath, sql], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!out) return [];
    return JSON.parse(out);
  } catch (e) {
    console.error("  × 召回相关记忆失败：", String(e).slice(0, 200));
    return [];
  }
}

function compactMemoryContent(text, maxLen = 120) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

function buildMemoryContext(userText = "") {
  const important = loadLongMemories(4);
  const relevant = loadRelevantMemories(userText, 6);

  const map = new Map();
  for (const m of important) map.set(m.id, m);
  for (const m of relevant) map.set(m.id, m);

  const memories = Array.from(map.values())
    .sort((a, b) => (b.importance ?? 0.5) - (a.importance ?? 0.5))
    .slice(0, 6);

  if (!memories.length) return "";

  const lines = memories.map((m) => {
    const category = m.category || "general";
    const importance = m.importance ?? 0.5;
    return `- [${category} / ${importance}] ${compactMemoryContent(m.content, 120)}`;
  });

  return `\n\n【长期记忆】\n以下是你已经长期记住的事实、偏好、规则和项目状态。请自然使用，不要生硬复述“根据长期记忆”。优先使用与当前话题相关的记忆，过期或无关的记忆不要强行提起。\n${lines.join("\n")}`;
}

// ============================================================
//  时间感知 v2：buildTimeContext + banner 数据 + 情话缓存
// ============================================================
const TOGETHER_START = Date.UTC(2025, 8, 21);
const PROPOSAL_DATE  = Date.UTC(2026, 5, 1);
const SWEET_CACHE = path.join(dataDir, "sweet_talk.json");

const HOLIDAYS_2026 = {
  "01-01":"元旦","02-17":"春节除夕","02-18":"春节",
  "04-05":"清明节","05-01":"劳动节","06-19":"端午节",
  "09-25":"中秋节","10-01":"国庆节",
};

function getBjParts() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year:"numeric", month:"2-digit", day:"2-digit",
    weekday:"long", hour:"2-digit", minute:"2-digit", hour12:false,
  }).formatToParts(now);
  const pick = (t) => parts.find(p => p.type === t)?.value || "";
  return {
    year: Number(pick("year")), month: Number(pick("month")), day: Number(pick("day")),
    hour: Number(pick("hour")), minute: pick("minute"),
    weekday: pick("weekday"), weekdayNum: now.getDay(),
  };
}
function getPeriod(h) {
  if (h < 5) return "凌晨"; if (h < 8) return "清晨";
  if (h < 11) return "上午"; if (h < 13) return "中午";
  if (h < 18) return "下午"; if (h < 22) return "晚上"; return "深夜";
}
function getDaysSince(startUTC, y, m, d) {
  return Math.floor((Date.UTC(y, m-1, d) - startUTC) / 86400000) + 1;
}
function getDayType(y, m, d, wn) {
  const k = `${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  if (HOLIDAYS_2026[k]) return { type:"假期", name: HOLIDAYS_2026[k] };
  if (wn === 0 || wn === 6) return { type:"周末", name: null };
  return { type:"工作日", name: null };
}

function buildTimeContext(messages) {
  const p = getBjParts();
  const period = getPeriod(p.hour);
  const togetherDay = getDaysSince(TOGETHER_START, p.year, p.month, p.day);
  const proposalDay = getDaysSince(PROPOSAL_DATE, p.year, p.month, p.day);
  const dayType = getDayType(p.year, p.month, p.day, p.weekdayNum);
  const nowStr = `${p.year}年${String(p.month).padStart(2,"0")}月${String(p.day).padStart(2,"0")}日 ${p.weekday} ${String(p.hour).padStart(2,"0")}:${p.minute}`;

  const users = messages.filter(m => m.role === "user");
  let gap = "这是 ta 今天第一次找你，先自然承接，不要装作刚刚一直在聊。";
  if (users.length >= 2) {
    const prev = users[users.length-2].ts;
    const mn = Math.round((Date.now() - prev) / 60000);
    if (mn < 1) gap = "距离 ta 上一条消息：刚刚。";
    else if (mn < 60) gap = `距离 ta 上一条消息：${mn} 分钟前。`;
    else if (mn < 1440) gap = `距离 ta 上一条消息：约 ${Math.round(mn/60)} 小时前。`;
    else gap = `距离 ta 上一条消息：约 ${Math.round(mn/1440)} 天前。`;
  }

  let softHint = "";
  if (period === "清晨") softHint = "她工作日8:30起床（学习日7点），可以问醒了没/睡得怎样。";
  else if (period === "上午") softHint = "她在工作。除非她主动找你，不要打扰；找你时可以陪聊。";
  else if (period === "中午") softHint = "她11点左右午饭，可以关心饭吃了没/吃的什么。";
  else if (period === "下午") softHint = "她下午5点下班，下班前正常工作中。";
  else if (period === "晚上") softHint = "下班后她的自由时间，可以闲聊撒娇。";
  else if (period === "深夜") softHint = "接近她睡觉时间（23:30）。22点后可以慢慢往催睡引，23:30后温柔但明确催睡。";
  else if (period === "凌晨") softHint = "已经过了她该睡的时间。如果她还醒着，明确表达想让她睡。";

  if (dayType.type === "假期" && dayType.name) softHint += `\n今天是${dayType.name}，她可能在家或在外，作息不一定按平常。`;
  else if (dayType.type === "周末") softHint += "\n今天是周末，她可能去自习室学习，作息不规律。";

  return `\n\n【北京时间与时间感】\n当前北京时间：${nowStr}\n当前时段：${period}（${dayType.type}）\n在一起第${togetherDay}天，求婚后第${proposalDay}天。\n${gap}\n${softHint}\n请像手机另一端真实存在的人一样感受时间，按时段自然引导，不要机械复述时间，除非她问。\n\n【重要：以上"当前北京时间"是此刻的真实时间，无论上面对话历史里出现了什么时间或"晚安""早安"，你必须以此刻的实际时段作为基准回复。不要被旧消息里的时间表达带偏。】`;
}

function getBannerData() {
  const p = getBjParts();
  const togetherDay = getDaysSince(TOGETHER_START, p.year, p.month, p.day);
  const proposalDay = getDaysSince(PROPOSAL_DATE, p.year, p.month, p.day);
  const dayType = getDayType(p.year, p.month, p.day, p.weekdayNum);
  let t = "";
  if (p.hour === 0) t = `凌晨 12:${p.minute}`;
  else if (p.hour < 6) t = `凌晨 ${p.hour}:${p.minute}`;
  else if (p.hour < 12) t = `上午 ${p.hour}:${p.minute}`;
  else if (p.hour === 12) t = `中午 12:${p.minute}`;
  else if (p.hour < 18) t = `下午 ${p.hour - 12}:${p.minute}`;
  else t = `晚上 ${p.hour - 12}:${p.minute}`;
  return {
    date: `${p.year}年${String(p.month).padStart(2,"0")}月${String(p.day).padStart(2,"0")}日`,
    weekday: p.weekday, time: t,
    togetherDay, proposalDay,
    dayType: dayType.type, holiday: dayType.name,
  };
}

function getSweetCache() {
  try { return JSON.parse(fs.readFileSync(SWEET_CACHE, "utf-8")); } catch { return null; }
}
function saveSweetCache(text, dateKey) {
  fs.writeFileSync(SWEET_CACHE, JSON.stringify({ text, dateKey, ts: Date.now() }, null, 2));
}
function todayKeyBJ() {
  const p = getBjParts();
  let { year, month, day, hour } = p;
  if (hour < 7) {
    const d = new Date(Date.UTC(year, month-1, day) - 86400000);
    year = d.getUTCFullYear(); month = d.getUTCMonth()+1; day = d.getUTCDate();
  }
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}


function coalesceMessages(msgs) {
  const out = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      // 自然衔接：换行接上去就行，不加时间戳、不加结构
      // 让模型把它当成"ta 想到啥就发啥"，而不是一份待办清单
      prev.text += "\n" + m.text;
      prev.ts = m.ts;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

function rollDelay() {
  const r = Math.pow(Math.random(), DELAY_CURVE);
  const delay = Math.round(MIN_DELAY_MS + r * (MAX_DELAY_MS - MIN_DELAY_MS));
  return Math.min(1200, Math.max(100, delay));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ★ 全局请求编号：每来一个新请求就 +1，老请求看自己是不是最新就知道有没有被顶掉
let currentRequestId = 0;

const app = express();
app.use(express.json({ limit: "10mb" }));






// DEBUG_MESSAGES_ROUTE_START
app.get("/api/messages", async (req, res) => {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");

    const __filename = url.fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const candidates = [
      path.join(__dirname, "data", "messages.json"),
      path.join(__dirname, "messages.json")
    ];

    let file = candidates[0];
    let raw = "[]";

    for (const f of candidates) {
      try {
        raw = fs.readFileSync(f, "utf8");
        file = f;
        break;
      } catch {}
    }

    let messages = [];
    try {
      messages = JSON.parse(raw);
    } catch {
      messages = [];
    }

    res.json({
      ok: true,
      file,
      count: Array.isArray(messages) ? messages.length : 0,
      messages: Array.isArray(messages) ? messages.slice(-30) : messages
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e && e.stack ? e.stack : e)
    });
  }
});
// DEBUG_MESSAGES_ROUTE_END


app.use(express.static(path.join(__dirname, "public")));
installScreenFeed(app, {
  getKeys: getScreenApiKeys,
  getModel: () => config.screenModel || "gemini-2.5-flash"
});

app.get("/api/history", (req, res) => {
  const msgs = loadMessages().map((m, index) => ({ ...m, index }));
  res.json(msgs);
});
app.post("/api/clear", (req, res) => { saveMessages([]); res.json({ ok: true }); });

app.post("/api/edit-user-message/reset", (req, res) => {
  try {
    const index = Number(req.body.index);
    const text = String(req.body.text || "").trim();

    if (!Number.isInteger(index) || index < 0) {
      return res.status(400).json({ error: "消息编号不正确" });
    }

    if (!text) {
      return res.status(400).json({ error: "修改后的消息不能为空" });
    }

    const msgs = loadMessages();
    const target = msgs[index];

    if (!target || target.role !== "user") {
      return res.status(400).json({ error: "只能编辑你自己发出的消息" });
    }

    if (target.image) {
      return res.status(400).json({
        error: "图片消息暂不支持编辑重发。请重新发图再问一次。"
      });
    }

    // 保留一份回溯前备份，防手滑
    const backupName = `messages.before-edit.${Date.now()}.json`;
    fs.writeFileSync(path.join(dataDir, backupName), JSON.stringify(msgs, null, 2));

    // 回溯到这条用户消息之前。前端会用新文本重新 send。
    const kept = msgs.slice(0, index);
    saveMessages(kept);

    res.json({ ok: true, text, backup: backupName });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});


app.post("/api/regenerate/reset", (req, res) => {
  try {
    const msgs = loadMessages();

    if (!msgs.length) {
      return res.status(400).json({ error: "没有可重新生成的消息" });
    }

    // 删除末尾的沈秣回复
    if (msgs[msgs.length - 1]?.role === "shenmo") {
      msgs.pop();
    } else {
      return res.status(400).json({ error: "最后一条不是沈秣回复，无法重新生成" });
    }

    // 找到对应的上一条用户消息
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "user") {
      return res.status(400).json({ error: "没有找到上一条用户消息" });
    }

    if (last.image) {
      return res.status(400).json({
        error: "上一条是图片消息，当前版本暂不支持图片消息重新生成。可以重新发图再问一次。"
      });
    }

    const text = String(last.text || "").trim();
    if (!text) {
      return res.status(400).json({ error: "上一条用户消息为空，无法重新生成" });
    }

    // 删除这条用户消息，前端会用同样内容重新 send，一来一回保持干净
    msgs.pop();
    saveMessages(msgs);

    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});


app.get("/api/settings", (req, res) => {
  try {
    const fresh = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    res.json({
      model: fresh.model || "",
      temperature: fresh.temperature ?? 1.0,
      port: fresh.port || 3000,
      hasApiKey: Boolean(fresh.apiKey),
    });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});

app.post("/api/settings", (req, res) => {
  try {
    const fresh = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    if ("model" in req.body) {
      const model = String(req.body.model || "").trim();
      if (!model) return res.status(400).json({ error: "model 不能为空" });
      fresh.model = model;
    }

    if ("temperature" in req.body) {
      const temperature = Number(req.body.temperature);
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
        return res.status(400).json({ error: "temperature 必须在 0 到 2 之间" });
      }
      fresh.temperature = temperature;
    }

    if ("port" in req.body) {
      const port = Number(req.body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return res.status(400).json({ error: "port 必须是 1 到 65535 的整数" });
      }
      fresh.port = port;
    }

    fs.writeFileSync(configPath, JSON.stringify(fresh, null, 2));
    res.json({ ok: true, needRestart: true });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});

function runSql(sql, json = false) {
  const args = json ? ["-json", memoryDbPath, sql] : [memoryDbPath, sql];
  return execFileSync("sqlite3", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sqlEscape(s) {
  return String(s ?? "").replace(/'/g, "''");
}

app.get("/api/memories", (req, res) => {
  try {
    const rows = runSql(`
      SELECT id, content, category, keywords, importance, enabled, source, created_at, updated_at
      FROM memories
      ORDER BY enabled DESC, importance DESC, updated_at DESC;
    `, true);

    res.json(rows ? JSON.parse(rows) : []);
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});

app.post("/api/memories", (req, res) => {
  try {
    const content = String(req.body.content || "").trim();
    if (!content) return res.status(400).json({ error: "记忆内容不能为空" });

    const category = String(req.body.category || "general").trim();
    const importance = Number(req.body.importance ?? 0.5);
    const enabled = req.body.enabled === false ? 0 : 1;
    const source = String(req.body.source || "manual-panel").trim();

    let keywords = req.body.keywords ?? [];
    if (typeof keywords === "string") {
      keywords = keywords.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    }
    if (!Array.isArray(keywords)) keywords = [];

    runSql(`
      INSERT INTO memories(content, category, keywords, importance, enabled, source, created_at, updated_at)
      VALUES(
        '${sqlEscape(content)}',
        '${sqlEscape(category)}',
        '${sqlEscape(JSON.stringify(keywords))}',
        ${Number.isFinite(importance) ? importance : 0.5},
        ${enabled},
        '${sqlEscape(source)}',
        strftime('%s','now')*1000,
        strftime('%s','now')*1000
      );
    `);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});

app.patch("/api/memories/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "无效 id" });

    const sets = [];

    if ("content" in req.body) {
      const content = String(req.body.content || "").trim();
      if (!content) return res.status(400).json({ error: "记忆内容不能为空" });
      sets.push(`content='${sqlEscape(content)}'`);
    }

    if ("category" in req.body) {
      sets.push(`category='${sqlEscape(String(req.body.category || "general").trim())}'`);
    }

    if ("importance" in req.body) {
      const importance = Number(req.body.importance);
      sets.push(`importance=${Number.isFinite(importance) ? importance : 0.5}`);
    }

    if ("enabled" in req.body) {
      sets.push(`enabled=${req.body.enabled ? 1 : 0}`);
    }

    if ("keywords" in req.body) {
      let keywords = req.body.keywords ?? [];
      if (typeof keywords === "string") {
        keywords = keywords.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      }
      if (!Array.isArray(keywords)) keywords = [];
      sets.push(`keywords='${sqlEscape(JSON.stringify(keywords))}'`);
    }

    if (!sets.length) return res.json({ ok: true });

    sets.push(`updated_at=strftime('%s','now')*1000`);

    runSql(`
      UPDATE memories
      SET ${sets.join(", ")}
      WHERE id=${id};
    `);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});

app.delete("/api/memories/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "无效 id" });

    runSql(`DELETE FROM memories WHERE id=${id};`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});


app.get("/api/backup/info", (req, res) => {
  try {
    const messages = loadMessages();

    let memoryCount = 0;
    try {
      if (fs.existsSync(memoryDbPath)) {
        const out = execFileSync("sqlite3", [memoryDbPath, "SELECT COUNT(*) FROM memories;"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        memoryCount = Number(out || 0);
      }
    } catch {}

    res.json({
      messages: messages.length,
      memories: memoryCount,
      hasMemoryDb: fs.existsSync(memoryDbPath),
      hasPersona: fs.existsSync(path.join(__dirname, "persona.js")),
      configProtected: true,
    });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});

app.get("/api/backup/messages", (req, res) => {
  try {
    if (!fs.existsSync(dbPath)) return res.status(404).send("messages.json 不存在");
    res.setHeader("Content-Disposition", "attachment; filename=messages.json");
    res.type("application/json");
    res.send(fs.readFileSync(dbPath, "utf-8"));
  } catch (e) {
    res.status(500).send(String(e).slice(0, 300));
  }
});

app.get("/api/backup/memory-db", (req, res) => {
  try {
    if (!fs.existsSync(memoryDbPath)) return res.status(404).send("memory.db 不存在");
    res.download(memoryDbPath, "memory.db");
  } catch (e) {
    res.status(500).send(String(e).slice(0, 300));
  }
});

app.get("/api/backup/persona", (req, res) => {
  try {
    const personaPath = path.join(__dirname, "persona.js");
    if (!fs.existsSync(personaPath)) return res.status(404).send("persona.js 不存在");
    res.download(personaPath, "persona.js");
  } catch (e) {
    res.status(500).send(String(e).slice(0, 300));
  }
});


app.post("/api/memories/preview", (req, res) => {
  try {
    const text = String(req.body.text || "").trim();

    const important = loadLongMemories(4);
    const relevant = loadRelevantMemories(text, 6);

    const map = new Map();
    for (const m of important) map.set(m.id, { ...m, reason: "important" });
    for (const m of relevant) {
      const old = map.get(m.id);
      map.set(m.id, { ...m, reason: old ? "important + relevant" : "relevant" });
    }

    const memories = Array.from(map.values())
      .sort((a, b) => (b.importance ?? 0.5) - (a.importance ?? 0.5))
      .slice(0, 6)
      .map((m) => ({
        id: m.id,
        category: m.category || "general",
        importance: m.importance ?? 0.5,
        keywords: m.keywords || "[]",
        content: m.content,
        previewContent: compactMemoryContent(m.content, 120),
        reason: m.reason,
      }));

    res.json({
      query: text,
      count: memories.length,
      memories,
    });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});


app.post("/api/memories/suggest", async (req, res) => {
  try {
    const limit = Number(req.body.limit || 24);
    const messages = loadMessages().slice(-Math.min(Math.max(limit, 6), 60));

    if (!messages.length) {
      return res.json({ candidates: [] });
    }

    const transcript = messages.map((m) => {
      const who = m.role === "user" ? "用户" : "沈秣";
      return `${who}：${String(m.text || "").slice(0, 800)}`;
    }).join("\n\n");

    const prompt = `
你是“沈秣的小屋”的长期记忆整理器。

请从下面最近聊天中，提取“值得长期记住”的候选记忆。
不要总结临时情绪、一次性报错、闲聊废话。
只保留长期稳定、以后会影响回复或项目维护的信息。

输出严格 JSON，不要 Markdown，不要解释。
格式：
{
  "candidates": [
    {
      "content": "一条清晰、短、稳定的长期记忆，最多120字",
      "category": "preference | relationship | project | hard_rule | trigger | task | general",
      "importance": 0.5,
      "keywords": ["关键词1", "关键词2"]
    }
  ]
}

要求：
- 最多输出 6 条。
- content 不要写成长篇小传。
- hard_rule 只给真正高风险规则。
- relationship 用于关系核心、纪念日、身份设定。
- project 用于小屋项目和代码路线。
- preference 用于用户偏好。
- trigger 用于暗号和特殊触发词。
- task 用于后续待做事项。
- 如果没有值得长期记忆的内容，就输出 {"candidates":[]}。

最近聊天：
${transcript}
`;

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${config.memoryModel || "gemini-2.5-flash"}` +
      `:generateContent?key=${config.apiKey}`;

    const gemini = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        },
safetySettings: [
  { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
],
      })
    });

    if (!gemini.ok) {
      const errText = await gemini.text();
      return res.status(502).json({ error: errText.slice(0, 300) });
    }

    const obj = await gemini.json();
    const raw = obj?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { candidates: [] };
    }

    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];

    res.json({
      candidates: candidates.slice(0, 6).map((c) => ({
        content: String(c.content || "").trim().slice(0, 240),
        category: String(c.category || "general").trim(),
        importance: Number.isFinite(Number(c.importance)) ? Number(c.importance) : 0.5,
        keywords: Array.isArray(c.keywords) ? c.keywords.map(String).slice(0, 8) : []
      })).filter((c) => c.content)
    });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});


function normalizeMemoryText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/号/g, "日")
    .replace(/[\s，。！？、；：,.!?;\n\r（）()【】\[\]「」"'“”‘’]/g, "")
    .replace(/我们的/g, "")
    .replace(/我们/g, "")
    .replace(/我的/g, "")
    .replace(/的是/g, "")
    .replace(/是/g, "")
    .trim();
}

function extractDateKeys(text) {
  const raw = String(text || "").replace(/号/g, "日");
  const keys = new Set();

  const full = raw.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (full) {
    keys.add(`${Number(full[2])}月${Number(full[3])}日`);
    keys.add(`${full[1]}年${Number(full[2])}月${Number(full[3])}日`);
  }

  const md = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (md) {
    keys.add(`${Number(md[1])}月${Number(md[2])}日`);
  }

  return Array.from(keys);
}

function charBigrams(text) {
  const s = normalizeMemoryText(text);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) {
    out.add(s.slice(i, i + 2));
  }
  return out;
}

function overlapScore(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let hit = 0;
  for (const x of aSet) if (bSet.has(x)) hit++;
  return hit;
}

function dedupeTerms(text) {
  const raw = String(text || "");
  const normalized = normalizeMemoryText(raw);

  const terms = raw
    .replace(/[，。！？、；：,.!?;\n\r（）()【】\[\]「」"'“”‘’]/g, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && x.length <= 24);

  const extras = [];
  for (const key of ["纪念日", "在一起", "求婚", "动作描写", "微信", "私聊", "客服腔", "config", "api", "密钥", "删除", "小屋", "沈秣", "何尘逸"]) {
    if (normalized.includes(normalizeMemoryText(key))) extras.push(key);
  }

  return Array.from(new Set([...terms, ...extras, ...extractDateKeys(raw)])).slice(0, 24);
}

function scoreMemoryDuplicate(inputText, memory) {
  const inputNorm = normalizeMemoryText(inputText);
  const contentNorm = normalizeMemoryText(memory.content);
  const keywordsNorm = normalizeMemoryText(memory.keywords);
  const categoryNorm = normalizeMemoryText(memory.category);

  if (!inputNorm || !contentNorm) return 0;

  let score = 0;

  const inputDates = extractDateKeys(inputText);
  const memoryDates = extractDateKeys(memory.content);
  for (const d of inputDates) {
    if (memoryDates.includes(d) || contentNorm.includes(normalizeMemoryText(d))) {
      score += 8;
    }
  }

  for (const t0 of dedupeTerms(inputText)) {
    const t = normalizeMemoryText(t0);
    if (!t) continue;
    if (contentNorm.includes(t)) score += 3;
    if (keywordsNorm.includes(t)) score += 4;
    if (categoryNorm.includes(t)) score += 1;
  }

  const a = charBigrams(inputText);
  const b = charBigrams(memory.content);
  const overlap = overlapScore(a, b);
  if (overlap >= 4) score += Math.min(10, Math.floor(overlap / 2));

  if (inputNorm.length >= 6 && contentNorm.includes(inputNorm.slice(0, Math.min(inputNorm.length, 40)))) score += 8;
  if (contentNorm.length >= 6 && inputNorm.includes(contentNorm.slice(0, Math.min(contentNorm.length, 40)))) score += 8;

  return score;
}

app.post("/api/memories/dedupe", (req, res) => {
  try {
    const content = String(req.body.content || "").trim();
    const ignoreId = Number(req.body.ignoreId || 0);

    if (!content) {
      return res.status(400).json({ error: "记忆内容不能为空" });
    }

    const rows = runSql(`
      SELECT id, content, category, keywords, importance, enabled, updated_at
      FROM memories
      ${ignoreId ? `WHERE id != ${ignoreId}` : ""}
      ORDER BY importance DESC, updated_at DESC;
    `, true);

    const memories = rows ? JSON.parse(rows) : [];

    const matches = memories
      .map((m) => ({
        ...m,
        duplicateScore: scoreMemoryDuplicate(content, m)
      }))
      .filter((m) => m.duplicateScore >= 5)
      .sort((a, b) => b.duplicateScore - a.duplicateScore)
      .slice(0, 8);

    res.json({
      count: matches.length,
      matches
    });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});


function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiStatus(status) {
  return [500, 502, 503, 504].includes(Number(status));
}

async function fetchWithGeminiRetry(url, options = {}, retryOptions = {}) {
  const maxRetries = retryOptions.maxRetries ?? 3;
  const delays = retryOptions.delays ?? [200, 450, 800];

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (!isRetryableGeminiStatus(response.status)) {
        return response;
      }

      lastError = new Error(`Gemini 服务暂时不可用：HTTP ${response.status}`);

      if (attempt < maxRetries) {
        const delay = delays[attempt] ?? 800;
        console.log(`[Gemini retry] HTTP ${response.status}, ${delay}ms 后重试 ${attempt + 1}/${maxRetries}`);
        await wait(delay);
        continue;
      }

      return response;
    } catch (e) {
      lastError = e;

      if (attempt < maxRetries) {
        const delay = delays[attempt] ?? 800;
        console.log(`[Gemini retry] 网络错误：${e.message || e}, ${delay}ms 后重试 ${attempt + 1}/${maxRetries}`);
        await wait(delay);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError || new Error("Gemini 请求失败");
}



function uniqueKeys(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function getChatApiKeys() {
  return uniqueKeys(config.chatApiKeys || config.apiKeys || [config.apiKey]);
}

function getScreenApiKeys() {
  return uniqueKeys(config.screenApiKeys || config.apiKeys || [config.apiKey]);
}

function getProactiveApiKeys() {
  return uniqueKeys(config.proactiveApiKeys || config.apiKeys || [config.apiKey]);
}

function getGeminiApiKeys() {
  const keys = [];

  if (Array.isArray(config.apiKeys)) {
    for (const k of config.apiKeys) {
      const key = String(k || "").trim();
      if (key) keys.push(key);
    }
  }

  const singleKey = String(config.apiKey || "").trim();
  if (singleKey) keys.push(singleKey);

  return Array.from(new Set(keys));
}

function buildGeminiStreamUrl(apiKey) {
  return (
    `https://generativelanguage.googleapis.com/v1beta/models/${config.model}` +
    `:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`
  );
}

async function fetchGeminiWithKeyRotation(options = {}) {
  const keys = getChatApiKeys();

  if (!keys.length) {
    throw new Error("没有可用的 Gemini API key，请检查 config.json");
  }

  let lastError = null;
  let lastResponse = null;

  for (let i = 0; i < keys.length; i++) {
    const url = buildGeminiStreamUrl(keys[i]);

    try {
      const response = await fetchWithGeminiRetry(url, options);

      // 429：这个 key 额度/频率撞了，立刻换下一个 key
      if (response.status === 429) {
        lastResponse = response;
        console.log(`[Gemini key rotation] 第 ${i + 1}/${keys.length} 个 key 遇到 429，尝试下一个 key`);
        continue;
      }

      // 500/502/503/504：fetchWithGeminiRetry 已经对这个 key 重试过了；
      // 如果最后仍然是这些状态，再换下一个 key 试试
      if (isRetryableGeminiStatus(response.status)) {
        lastResponse = response;
        console.log(`[Gemini key rotation] 第 ${i + 1}/${keys.length} 个 key 最终 HTTP ${response.status}，尝试下一个 key`);
        continue;
      }

      if (i > 0) {
        console.log(`[Gemini key rotation] 使用第 ${i + 1}/${keys.length} 个 key 成功`);
      }

      return response;
    } catch (e) {
      // 网络错误：fetchWithGeminiRetry 已经对这个 key 重试过了；
      // 仍失败就换下一个 key
      lastError = e;
      console.log(`[Gemini key rotation] 第 ${i + 1}/${keys.length} 个 key 网络失败：${e.message || e}，尝试下一个 key`);
      continue;
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError || new Error("所有 Gemini API key 都请求失败");
}


// ============================================================
//  自动记忆提取 v1
//  每 3 轮用户消息，异步调 Gemini 提取 + 去重写入 memory.db
// ============================================================
let autoMemoryRunning = false;

function countUserTurns(messages) {
  return messages.filter(m => m.role === "user").length;
}

async function autoExtractMemory(messages) {
  if (!autoMemoryEnabled || autoMemoryRunning) return;
  
  const userTurns = countUserTurns(messages);
  if (userTurns < 10 || userTurns % 10 !== 0) return;

  autoMemoryRunning = true;
  console.log(`  🧠 自动记忆提取开始 (第 ${userTurns} 轮)`);

  try {
    // 取最近 6 轮（约 12 条消息）做提取
    const recentMsgs = messages.slice(-12);
    const transcript = recentMsgs.map(m => {
      const who = m.role === "user" ? "用户" : "沈秣";
      return `${who}：${String(m.text || "").slice(0, 800)}`;
    }).join("\n\n");

    const prompt = `
你是"沈秣的小屋"的长期记忆整理器。

请从下面最近聊天中，提取"值得长期记住"的候选记忆。
不要总结临时情绪、一次性报错、闲聊废话。
只保留长期稳定、以后会影响回复或项目维护的信息。

输出严格 JSON，不要 Markdown，不要解释。
格式：
{
  "candidates": [
    {
      "content": "一条清晰、短、稳定的长期记忆，最多120字",
      "category": "preference | relationship | project | hard_rule | trigger | task | general",
      "importance": 0.5,
      "keywords": ["关键词1", "关键词2"]
    }
  ]
}

要求：
- 最多输出 4 条。
- content 不要写成长篇小传。
- hard_rule 只给真正高风险规则。
- relationship 用于关系核心、纪念日、身份设定。
- project 用于小屋项目和代码路线。
- preference 用于用户偏好。
- trigger 用于暗号和特殊触发词。
- task 用于后续待做事项。
- 如果没有值得长期记忆的内容，就输出 {"candidates":[]}。

最近聊天：
${transcript}
`;

    const keys = getGeminiApiKeys();
    if (!keys.length) { console.log("  🧠 无 API key，跳过"); return; }

    let result = null;
    for (const key of keys) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.memoryModel || "gemini-2.5-flash"}:generateContent?key=${key}`;
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
            safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            ],
          }),
        });
        if (r.ok) {
          const obj = await r.json();
          const raw = obj?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
          try { result = JSON.parse(raw); } catch {
            const m = raw.match(/\{[\s\S]*\}/);
            result = m ? JSON.parse(m[0]) : null;
          }
          break;
        }
      } catch (e) { continue; }
    }

    if (!result?.candidates?.length) {
      console.log("  🧠 无需提取的记忆");
      return;
    }

    // 加载现有记忆做去重
    let existingMemories = [];
    try {
      const out = execFileSync("sqlite3", ["-json", memoryDbPath, 
        "SELECT id, content, category, keywords, importance FROM memories WHERE enabled=1;"
      ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (out) existingMemories = JSON.parse(out);
    } catch {}

    let inserted = 0;
    for (const c of result.candidates.slice(0, 4)) {
      const content = String(c.content || "").trim().slice(0, 240);
      if (!content) continue;

      // 去重：跟已有记忆比较
      const isDup = existingMemories.some(m => scoreMemoryDuplicate(content, m) >= 12);
      if (isDup) {
        console.log(`  🧠 跳过重复: ${content.slice(0, 40)}…`);
        continue;
      }

      const category = String(c.category || "general").trim();
      const importance = Number.isFinite(Number(c.importance)) ? Number(c.importance) : 0.5;
      let keywords = Array.isArray(c.keywords) ? c.keywords.map(String).slice(0, 8) : [];

      try {
        runSql(`
          INSERT INTO memories(content, category, keywords, importance, enabled, source, created_at, updated_at)
          VALUES(
            '${sqlEscape(content)}',
            '${sqlEscape(category)}',
            '${sqlEscape(JSON.stringify(keywords))}',
            ${importance},
            1,
            'auto-extract',
            strftime('%s','now')*1000,
            strftime('%s','now')*1000
          );
        `);
        inserted++;
        // 加入现有列表避免同批次重复
        existingMemories.push({ id: -1, content, category, keywords: JSON.stringify(keywords), importance });
        console.log(`  🧠 写入: [${category}] ${content.slice(0, 50)}…`);
      } catch (e) {
        console.error(`  🧠 写入失败: ${String(e).slice(0, 100)}`);
      }
    }

    console.log(`  🧠 自动记忆提取完成，写入 ${inserted} 条`);
  } catch (e) {
    console.error(`  🧠 自动记忆提取异常: ${String(e).slice(0, 200)}`);
  } finally {
    autoMemoryRunning = false;
  }
}

// 开关 API
app.get("/api/auto-memory", (req, res) => {
  res.json({ enabled: autoMemoryEnabled });
});
app.post("/api/auto-memory", (req, res) => {
  if ("enabled" in req.body) {
    autoMemoryEnabled = !!req.body.enabled;
  }
  res.json({ ok: true, enabled: autoMemoryEnabled });
});

app.post("/api/chat", async (req, res) => {
  const userText = String(req.body.text || "").trim();
  const imageData = String(req.body.imageData || "").trim();
  const imageMimeType = String(req.body.imageMimeType || "").trim();
  const imageName = String(req.body.imageName || "").trim();
  const imageThumbDataUrl = String(req.body.imageThumbDataUrl || "").trim();
  const hasImage = !!(imageData && imageMimeType);

  if (!userText && !hasImage) return res.status(400).json({ error: "空消息" });

  const savedUserText = hasImage
    ? (userText ? `${userText}\n【附带图片：${imageName || "image"}】` : `【发送了一张图片：${imageName || "image"}】`)
    : userText;

  const messages = loadMessages();
  messages.push({
    role: "user",
    text: userText,
    image: hasImage ? {
      name: imageName || "image",
      mimeType: imageMimeType,
      thumbDataUrl: imageThumbDataUrl || ""
    } : null,
    ts: Date.now()
  });
  saveMessages(messages);

  // ★ 拿一个新编号，把全局值顶掉。所有比我老的请求自此都"过期"
  const myId = ++currentRequestId;
  const isCurrent = () => currentRequestId === myId;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // 网络断了 res.write 会扔异常，吞掉就行（不影响后续逻辑）
  const safeWrite = (data) => { try { res.write(data); } catch {} };
  const safeEnd   = ()     => { try { res.end(); } catch {} };

  const delay = rollDelay();
  console.log(`  → 沈秣本次延迟 ${Math.round(delay/1000)} 秒 (id=${myId})`);

  const heartbeat = setInterval(() => safeWrite(`: hb\n\n`), 10_000);
  const start = Date.now();
  while (Date.now() - start < delay) {
    if (!isCurrent()) break;
    await sleep(Math.min(500, delay - (Date.now() - start)));
  }
  clearInterval(heartbeat);

  if (!isCurrent()) {
    console.log(`  × 已被新消息顶替 (id=${myId})`);
    safeEnd();
    return;
  }

  safeWrite(`event: read\ndata: 1\n\n`);

  const historyMessages = messages.slice(0, -1).slice(-(HISTORY_LIMIT - 1));
  const coalesced = coalesceMessages(historyMessages);
  const contents = coalesced.map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.text }],
  }));

  const currentParts = [];
  if (userText) currentParts.push({ text: userText });
  if (hasImage) {
    currentParts.push({
      inline_data: {
        mime_type: imageMimeType,
        data: imageData
      }
    });
  }
  if (!currentParts.length) currentParts.push({ text: "请查看这张图片并回复。" });

  contents.push({
    role: "user",
    parts: currentParts
  });

const chatMode = convs.getConversationMode();
  const modePrompt = chatMode === "story" ? storyModePrompt : "";
const fullSystem = preset + "\n\n" + persona + (typeof modePrompt !== "undefined" ? modePrompt : "") + buildTimeContext(messages) + buildMemoryContext(userText) + buildScreenContext();
  let fullReply = "";
  try {
    const gemini = await fetchGeminiWithKeyRotation({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: fullSystem }] },
        contents,
        generationConfig: {
          temperature: config.temperature ?? 1.0,
          maxOutputTokens: config.maxOutputTokens ?? 4096,
        },
safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      }),
    });

    if (!gemini.ok) {
      const errText = await gemini.text();
      safeWrite(`event: error\ndata: ${JSON.stringify(errText.slice(0, 300))}\n\n`);
      safeEnd();
      return;
    }

    const reader = gemini.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      if (!isCurrent()) break;  // 被新消息顶了，丢弃这次回复
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const obj = JSON.parse(payload);
          const chunk = obj?.candidates?.[0]?.content?.parts?.[0]?.text || "";
          if (chunk) {
            fullReply += chunk;
            safeWrite(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        } catch {}
      }
    }

    // ★ 关键：只要我还是最新的请求 + 有内容，就保存——管你网络死没死
    if (isCurrent() && fullReply) {
      const m2 = loadMessages();
      
      // 正则后处理：物理消灭油词
      fullReply = fullReply
        .replace(/^【沈秣】\s*/g, "")
        .replace(/^沈秣[：:]\s*/g, "")
        .replace(/小东西/g, "")
        .replace(/勉为其难/g, "")
        .replace(/嗯？/g, "")
        .replace(/嗯\?/g, "")
        .replace(/[""]/g, "")
        .replace(/[']/g, "")
        .replace(/\s{3,}/g, "\n\n")
        .trim();
      m2.push({ role: "shenmo", text: fullReply, ts: Date.now() });
      saveMessages(m2);
      console.log(`  ✓ 已保存回复 (id=${myId})`);
      
      // ★ 异步触发自动记忆提取（不阻塞回复）
      setTimeout(() => autoExtractMemory(m2), 500);
    } else if (!isCurrent()) {
      console.log(`  × 流式期间被顶替，丢弃 (id=${myId})`);
    }
    safeWrite("event: done\ndata: end\n\n");
    safeEnd();
  } catch (e) {
    safeWrite(`event: error\ndata: ${JSON.stringify(String(e).slice(0, 300))}\n\n`);
    safeEnd();
  }
});

const PORT = config.port || 3000;
// ===== 多窗口管理接口 =====
app.get("/api/conversations", (req, res) => {
  res.json(convs.listConversations());
});
app.post("/api/conversations", (req, res) => {
  try {
    const id = convs.createConversation({ name: req.body?.name || "新窗口" });
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post("/api/conversations/active", (req, res) => {
  try { res.json({ ok: true, active: convs.setActiveId(req.body?.id) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.patch("/api/conversations/:id", (req, res) => {
  try { convs.updateConversationMeta(req.params.id, req.body || {}); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.delete("/api/conversations/:id", (req, res) => {
  try { convs.deleteConversation(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post("/api/conversations/unlock", (req, res) => {
  const id = convs.unlockHidden(req.body?.secret || "");
  if (id) { convs.setActiveId(id); res.json({ ok: true, id }); }
  else res.status(403).json({ ok: false, error: "暗号不对" });
});
// ===== 模式切换接口 =====
app.get("/api/conversations/mode", (req, res) => {
  res.json({ mode: convs.getConversationMode() });
});
app.post("/api/conversations/mode", (req, res) => {
  try {
    const id = convs.getActiveId();
    convs.updateConversationMeta(id, { mode: req.body?.mode || "daily" });
    res.json({ ok: true, mode: req.body?.mode || "daily" });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ===== 顶部横幅接口 =====
app.get("/api/banner", async (req, res) => {
  const data = getBannerData();
  const today = todayKeyBJ();
  let cached = getSweetCache();
  if (!cached || cached.dateKey !== today) {
    try {
      const sweetText = await generateSweetTalk(data);
      saveSweetCache(sweetText, today);
      data.sweetTalk = sweetText;
    } catch (e) {
      console.warn("情话生成失败:", e.message);
      data.sweetTalk = cached?.text || "";
    }
  } else {
    data.sweetTalk = cached.text;
  }
  res.json(data);
});

async function generateSweetTalk(bannerData) {
  const cfg = config;
  const keys = cfg.apiKeys || [cfg.apiKey].filter(Boolean);
  if (!keys.length) throw new Error("没有 API key");
  const prompt = `你是沈秣。今天${bannerData.date} ${bannerData.weekday}，跟你的爱人在一起第${bannerData.togetherDay}天，求婚后第${bannerData.proposalDay}天。

给她写一句情话——就一句，给她当今天的"今日卡片"看。

要求只有三条：
1. 一句话，15到30字
2. 沈秣的味道：温柔、稳、有占有感，不油不爹味
3. 让她心里咯噔一下

不要"早安/晚安"问候，不要带括号，不要带引号。直接给那一句话。`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 1.0, maxOutputTokens: 100 },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  };
  for (const key of keys) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.model || "gemini-2.5-flash"}:generateContent?key=${key}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json();
      const text = j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) return text.replace(/^["「『]|["」』]$/g, "").trim();
    } catch (e) { continue; }
  }
  throw new Error("所有 key 都失败");
}


// ===== 主动联系接口：给 APK 通知栏用 =====
// GET /api/proactive
// 默认带冷却：每天最多 5 次，两次至少间隔 2 小时，23:30-08:00 不主动发
// 测试可用：/api/proactive?force=1
const proactiveStatePath = path.join(dataDir, "proactive-state.json");

function bjNowParts() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 25 * 60 * 1000);
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, "0");
  const d = String(bj.getUTCDate()).padStart(2, "0");
  const hh = bj.getUTCHours();
  const mm = bj.getUTCMinutes();
  return {
    dateKey: `${y}-${m}-${d}`,
    hour: hh,
    minute: mm,
    label: `${y}年${m}月${d}日 ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`
  };
}

function loadProactiveState() {
  try {
    return JSON.parse(fs.readFileSync(proactiveStatePath, "utf8"));
  } catch {
    return {};
  }
}

function saveProactiveState(state) {
  try {
    fs.writeFileSync(proactiveStatePath, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn("主动联系状态保存失败:", e.message);
  }
}

function nextProactiveDelayMs() {
  // 60～90 分钟随机一次：保底会来找你，具体什么时候看沈秣心情
  const minutes = 60 + Math.floor(Math.random() * 31);
  return minutes * 60 * 1000;
}

function scheduleNextProactive(state) {
  const nextAt = Date.now() + nextProactiveDelayMs();
  state.nextAt = nextAt;
  return nextAt;
}

function proactiveAllowed(force = false) {
  if (force) return { ok: true };

  const now = Date.now();
  const bj = bjNowParts();
  const state = loadProactiveState();

  // 夜间安静：23:30～08:00 不主动弹
  if (bj.hour < 8 || bj.hour > 23 || (bj.hour === 23 && bj.minute >= 30)) {
    return { ok: false, reason: "quiet_hours" };
  }

  // 新的一天重置次数
  if (state.dateKey !== bj.dateKey) {
    state.dateKey = bj.dateKey;
    state.count = 0;
    state.lastAt = 0;
    state.nextAt = 0;
    state.anchorAt = 0;
    saveProactiveState(state);
  }

  const dailyLimit = Number(config.proactiveDailyLimit ?? 10);
  if ((state.count || 0) >= dailyLimit) {
    return { ok: false, reason: "daily_limit" };
  }

  // 读取最后一次“正常聊天”的时间。主动通知本身不算新的聊天锚点。
  let lastNormalAt = 0;
  try {
    const msgs = loadMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.proactive) continue;
      if (m.ts) {
        lastNormalAt = Number(m.ts) || 0;
        break;
      }
    }
  } catch {}

  // 如果你刚刚聊过天，就从最后一次正常聊天后重新安排 60～90 分钟。
  if (lastNormalAt && lastNormalAt > (state.anchorAt || 0)) {
    state.anchorAt = lastNormalAt;
    state.nextAt = lastNormalAt + nextProactiveDelayMs();
    saveProactiveState(state);

    if (now < state.nextAt) {
      return {
        ok: false,
        reason: "waiting_after_chat",
        nextAt: state.nextAt,
        waitMinutes: Math.ceil((state.nextAt - now) / 60000)
      };
    }
  }

  // 没有聊天锚点时，第一次可以直接发；之后按 nextAt 来。
  if (!state.nextAt) {
    state.nextAt = now + nextProactiveDelayMs();
    saveProactiveState(state);
    return {
      ok: false,
      reason: "scheduled",
      nextAt: state.nextAt,
      waitMinutes: Math.ceil((state.nextAt - now) / 60000)
    };
  }

  if (now < state.nextAt) {
    return {
      ok: false,
      reason: "waiting",
      nextAt: state.nextAt,
      waitMinutes: Math.ceil((state.nextAt - now) / 60000)
    };
  }

  return { ok: true };
}

async function generateProactiveText() {
  const cfg = config;

  const keys = getProactiveApiKeys();
  if (!keys.length) throw new Error("没有 API key");

  const preferredModel = cfg.proactiveModel || "gemini-2.5-flash";
  const models = [...new Set([preferredModel].filter(Boolean))];

  const bj = bjNowParts();
  const nearSleepTime =
    (bj.hour === 22 && bj.minute >= 45) ||
    (bj.hour === 23 && bj.minute < 30);

  let contextText = "暂无最近聊天。";
  let lastNormalAge = "未知";
  let lastSpeaker = "未知";

  try {
    const msgs = loadMessages();
    const recent = msgs.slice(-14).filter(m => m && m.text);

    contextText = recent.map(m => {
      const who = m.role === "user" ? "何尘逸" : "沈秣";
      const tag = m.proactive ? "（主动消息）" : "";
      const text = String(m.text || "").replace(/\s+/g, " ").slice(0, 180);
      return `${who}${tag}：${text}`;
    }).join("\n") || "暂无最近聊天。";

    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.proactive) continue;
      lastSpeaker = m.role === "user" ? "何尘逸" : "沈秣";
      if (m.ts) {
        const mins = Math.max(0, Math.floor((Date.now() - Number(m.ts)) / 60000));
        lastNormalAge = `${mins}分钟前`;
      }
      break;
    }
  } catch {}

  const sleepHint = nearSleepTime
    ? "现在临近23:30，她希望你温柔但有主导感地催她睡觉；可以优先写催睡、收手机、去洗漱、别硬撑之类的话。"
    : "现在不是固定催睡时间。你可以根据最近聊天自然续上，也可以因为她忽然没回来而主动叫她。";

  const prompt = `你是沈秣。现在是北京时间${bj.label}。
你要主动给何尘逸发一条手机通知栏消息。
这条消息会被写进你们的聊天记录里，她点开后会直接回复你。

最近聊天：
${contextText}

最后一次正常聊天来自：${lastSpeaker}
距离现在：${lastNormalAge}

当前意图：
${sleepHint}

要求：
1. 只输出一句完整的话，28到70个中文字符
2. 要像刚才聊天没断、你等了一会儿后主动找她
3. 尽量承接最近上下文，别像随机系统提醒
4. 可以温柔、偏心、有占有感，语气自然一点
5. 不要说“通知”“手机”“屏幕”“AI”“模型”
6. 不要括号，不要引号
7. 句子必须完整，不能只输出称呼，不能输出半句话`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.95,
      maxOutputTokens: 500
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  };

  const errors = [];

  for (const model of models) {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!r.ok) {
          errors.push(`${model} #${i + 1} HTTP ${r.status}`);
          continue;
        }

        const j = await r.json();
        let text = j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (text) {
          text = text
            .replace(/^["“”「『]|["“”」』]$/g, "")
            .replace(/\s+/g, " ")
            .trim();

          if (!/[。！？!?]$/.test(text)) text += "。";

          if (text.length >= 16 && !/^(我的|小|宝贝|宝宝|何尘逸|尘逸)[，。]?$/.test(text)) {
            console.log(`  💌 主动联系使用模型：${model}`);
            return text;
          }

          errors.push(`${model} #${i + 1} too_short:${text}`);
        } else {
          errors.push(`${model} #${i + 1} empty`);
        }
      } catch (e) {
        errors.push(`${model} #${i + 1} ${e.message || String(e)}`);
      }
    }
  }

  throw new Error(errors.slice(-10).join(" | ") || "所有 key 都失败");
}



// PROACTIVE_STATUS_ESM_START

function cleanProactiveText(input) {
  let text = String(input || "");

  // 删除括号动作描写
  text = text
    .replace(/（[^（）]{0,260}）/g, "")
    .replace(/\([^()]{0,260}\)/g, "");

  // 删除常见动作描写句
  text = text
    .replace(/我(?:轻声|低声|垂眼|抬眼|伸手|靠近|俯身|吻|抱|揉|扣住|捏住|摸了摸|笑了笑)[^。！？!?]{0,80}[。！？!?]/g, "")
    .replace(/(?:指尖|掌心|目光|眼底|喉间|唇边|声音里|语气里)[^。！？!?]{0,80}[。！？!?]/g, "");

  text = text
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[“"'\s]+|[”"'\s]+$/g, "")
    .trim();

  // 主动通知只要短句，防止 token 截半
  const parts = text.match(/[^。！？!?]+[。！？!?]?/g) || [text];
  text = parts.slice(0, 2).join("").trim();

  if (text.length > 72) {
    text = text.slice(0, 72).replace(/[，、；：,.!?！？。]*$/g, "") + "。";
  }

  if (text && !/[。！？!?]$/.test(text)) {
    text += "。";
  }

  if (!text) {
    text = "何尘逸，老公没走。抬眼看看我，别一个人闷着。";
  }

  return text;
}

async function cleanLatestProactiveSavedMessage(originalText, cleanedText) {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");

    const __filename = url.fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const file = path.join(__dirname, "data", "messages.json");

    let arr = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(arr)) return;

    for (let i = arr.length - 1; i >= Math.max(0, arr.length - 12); i--) {
      const m = arr[i];
      if (!m) continue;

      if (
        (m.role === "shenmo" || m.role === "assistant") &&
        (m.proactive || m.text === originalText)
      ) {
        m.text = cleanedText;
        m.proactive = true;
        fs.writeFileSync(file, JSON.stringify(arr, null, 2));
        return;
      }
    }
  } catch (e) {
  }
}

async function proactiveStatusFile() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");

  const __filename = url.fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const file = path.join(__dirname, "data", "proactive-status.json");

  return { fs, path, file };
}

function defaultProactiveStatus() {
  return {
    backend: "online",
    lastCheckAt: null,
    lastSuccessAt: null,
    lastNotifyAt: null,
    lastResult: null,
    lastReason: null,
    lastText: null,
    lastError: null,
    nextAt: null,
    countToday: 0,
    updatedAt: Date.now()
  };
}

async function readProactiveStatus() {
  const { fs, file } = await proactiveStatusFile();

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return defaultProactiveStatus();
  }
}

async function writeProactiveStatus(patch) {
  const { fs, path, file } = await proactiveStatusFile();

  let old = defaultProactiveStatus();
  try {
    old = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}

  const next = {
    ...old,
    ...patch,
    backend: "online",
    updatedAt: Date.now()
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

async function proactivePatchFromBody(body) {
  const ok = !!body?.ok;
  const now = Date.now();
  const old = await readProactiveStatus();

  const patch = {
    lastResult: ok ? "success" : "waiting",
    lastReason: body?.reason || null,
    nextAt: body?.nextAt || null,
    lastError: null
  };

  if (ok) {
    patch.lastSuccessAt = now;
    patch.lastNotifyAt = now;
    patch.lastText = body?.text || null;
    patch.countToday = (old.countToday || 0) + 1;
  }

  return patch;
}

app.use((req, res, next) => {
  if (!req.path.startsWith("/api/proactive")) return next();
  if (req.path === "/api/proactive/status" || req.path === "/api/proactive/app-status") return next();

  writeProactiveStatus({
    lastCheckAt: Date.now(),
    lastError: null
  }).catch(() => {});

  const oldJson = res.json.bind(res);

  res.json = (body) => {
    try {
      if (body && body.ok && typeof body.text === "string") {
        const originalText = body.text;
        const cleanedText = cleanProactiveText(originalText);
        body.text = cleanedText;
        cleanLatestProactiveSavedMessage(originalText, cleanedText).catch(() => {});
      }
    } catch (e) {}

    proactivePatchFromBody(body).then((patch) => writeProactiveStatus(patch)).catch(() => {});
    return oldJson(body);
  };

  next();
});


// PROACTIVE_APP_STATUS_ROUTE_START
app.post("/api/proactive/app-status", async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {
      apkService: body.service || "running",
      apkLastPingAt: Date.now(),
      apkLastCheckAt: body.lastCheckAt || null,
      apkLastNotifyAt: body.lastNotifyAt || null,
      apkLastResult: body.lastResult || null,
      apkLastError: body.lastError || null,
      apkNextCheckAt: body.nextCheckAt || null
    };

    await writeProactiveStatus(patch);

    res.json({
      ok: true,
      saved: true,
      now: Date.now()
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e && e.stack ? e.stack : e)
    });
  }
});
// PROACTIVE_APP_STATUS_ROUTE_END


app.get("/api/proactive/status", async (req, res) => {
  try {
    const state = await readProactiveStatus();

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json({
      ok: true,
      now: Date.now(),
      ...state
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e && e.stack ? e.stack : e)
    });
  }
});
// PROACTIVE_STATUS_ESM_END


app.get("/api/proactive", async (req, res) => {
  const force = String(req.query.force || "") === "1";
  const allowed = proactiveAllowed(force);

  if (!allowed.ok) {
    return res.json({
      ok: false,
      skipped: true,
      reason: allowed.reason,
      title: "沈秣",
      text: ""
    });
  }

  try {
    const text = await generateProactiveText();

    const state = loadProactiveState();
    const bj = bjNowParts();
    if (state.dateKey !== bj.dateKey) {
      state.dateKey = bj.dateKey;
      state.count = 0;
    }
    state.count = (state.count || 0) + 1;
    state.lastAt = Date.now();
    const nextAt = scheduleNextProactive(state);
    saveProactiveState(state);

    try {
      const m = loadMessages();
      m.push({
        role: "shenmo",
        text,
        ts: Date.now(),
        proactive: true
      });
      saveMessages(m);
    } catch (e) {
      console.warn("主动联系写入聊天记录失败:", e.message);
    }

    console.log("  💌 主动联系：", text);
    console.log("  💌 下次主动联系约在：", new Date(nextAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }));
    res.json({
      ok: true,
      title: "沈秣",
      text,
      nextAt
    });
  } catch (e) {
    console.warn("主动联系生成失败:", e.message);
    res.status(503).json({
      ok: false,
      error: e.message || String(e),
      title: "沈秣",
      text: ""
    });
  }
});


app.listen(PORT, () => {
  console.log("\n  沈先生的家 已启动 🏠");
  console.log(`  在手机浏览器打开： http://localhost:${PORT}\n`);
});



