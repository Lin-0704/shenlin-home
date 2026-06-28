import fs from "fs";

const CONFIG = "config.json";
const VALID_OLD = "data/valid-keys.json";
const NEW_KEYS_FILE = "data/new-keys.txt";
const RESULT_FILE = "data/recheck-key-result.json";

const model = "gemini-3.5-flash";
const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf-8"));

function unique(arr) {
  return [...new Set((arr || []).map(x => String(x).trim()).filter(Boolean))];
}

function mask(k) {
  return k.slice(0, 10) + "..." + k.slice(-6);
}

function readJsonList(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const x = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(x => x && !x.startsWith("#") && !x.includes("在这里粘"));
}

async function testKey(key, i) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{
      role: "user",
      parts: [{ text: "ping，只回答ok" }]
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 10 }
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}

    if (r.ok) {
      return { i, key, ok: true, status: r.status, code: "", reason: "OK" };
    }

    return {
      i,
      key,
      ok: false,
      status: r.status,
      code: j?.error?.status || "",
      reason: j?.error?.message || text.slice(0, 200)
    };
  } catch (e) {
    return {
      i,
      key,
      ok: false,
      status: "NETWORK",
      code: "",
      reason: String(e?.message || e)
    };
  }
}

const oldGood = readJsonList(VALID_OLD);
const newKeys = readLines(NEW_KEYS_FILE);
const candidates = unique([...oldGood, ...newKeys]);

console.log("检测模型：", model);
console.log("旧可用 key：", oldGood.length);
console.log("新粘贴 key：", newKeys.length);
console.log("合并候选：", candidates.length);
console.log("");

if (!candidates.length) {
  console.error("没有候选 key。检查 data/new-keys.txt 或 data/valid-keys.json");
  process.exit(1);
}

const results = [];
for (let i = 0; i < candidates.length; i++) {
  const r = await testKey(candidates[i], i + 1);
  results.push(r);
  console.log(`${r.ok ? "✅" : "❌"} #${r.i} ${mask(r.key)} status=${r.status} ${r.code || ""} ${r.reason}`);
}

const good = results.filter(r => r.ok).map(r => r.key);
const bad = results.filter(r => !r.ok);

let chatN, screenN, proactiveN;
if (good.length >= 22) {
  chatN = 15;
  screenN = 4;
  proactiveN = 3;
} else if (good.length >= 15) {
  chatN = 10;
  screenN = 3;
  proactiveN = 2;
} else if (good.length >= 9) {
  chatN = 6;
  screenN = 2;
  proactiveN = 1;
} else {
  chatN = Math.max(1, Math.ceil(good.length * 0.7));
  screenN = Math.max(1, Math.floor(good.length * 0.2));
  proactiveN = Math.max(1, good.length - chatN - screenN);
}

cfg.apiKeys = good;
cfg.apiKey = good[0] || "";

cfg.chatApiKeys = good.slice(0, chatN);
cfg.screenApiKeys = good.slice(chatN, chatN + screenN);
cfg.proactiveApiKeys = good.slice(chatN + screenN, chatN + screenN + proactiveN);

if (!cfg.screenApiKeys.length) cfg.screenApiKeys = good;
if (!cfg.proactiveApiKeys.length) cfg.proactiveApiKeys = good;

cfg.model = "gemini-3.5-flash";
cfg.screenModel = "gemini-3.5-flash";
cfg.proactiveModel = "gemini-3.5-flash";

fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
fs.writeFileSync("data/valid-keys.json", JSON.stringify(good, null, 2));

fs.writeFileSync(RESULT_FILE, JSON.stringify({
  checkedAt: new Date().toISOString(),
  model,
  totalCandidates: candidates.length,
  goodCount: good.length,
  badCount: bad.length,
  goodMasked: good.map(mask),
  badMasked: bad.map(r => ({
    index: r.i,
    key: mask(r.key),
    status: r.status,
    code: r.code || "",
    reason: r.reason
  })),
  chatCount: cfg.chatApiKeys.length,
  screenCount: cfg.screenApiKeys.length,
  proactiveCount: cfg.proactiveApiKeys.length
}, null, 2));

console.log("");
console.log("重新检测 + 分组完成：");
console.log("可用总数 =", good.length);
console.log("chatApiKeys =", cfg.chatApiKeys.length);
console.log("screenApiKeys =", cfg.screenApiKeys.length);
console.log("proactiveApiKeys =", cfg.proactiveApiKeys.length);
console.log("报告：", RESULT_FILE);
