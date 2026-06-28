import fs from "fs";

const CONFIG = "config.json";
const OLD_VALID = "data/valid-keys.json";
const NEW_KEYS_FILE = "data/new-keys.txt";
const OUT_CHECK = "data/key-pool-check-result.json";

const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf-8"));
const model = "gemini-3.5-flash";

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
    .filter(x => x && !x.startsWith("#"));
}

async function testKey(key, index) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{
      role: "user",
      parts: [{ text: "ping，只回答ok" }]
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 10
    }
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
      return { index, key, ok: true, status: r.status, reason: "OK" };
    }

    return {
      index,
      key,
      ok: false,
      status: r.status,
      code: j?.error?.status || "",
      reason: j?.error?.message || text.slice(0, 200)
    };
  } catch (e) {
    return {
      index,
      key,
      ok: false,
      status: "NETWORK",
      code: "",
      reason: String(e?.message || e)
    };
  }
}

function interleave(a, b) {
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return unique(out);
}

const oldFromLastCheck = readJsonList(OLD_VALID);
const oldFallback = unique([...(cfg.apiKeys || []), cfg.apiKey]);
const oldKeys = oldFromLastCheck.length ? oldFromLastCheck : oldFallback;
const newKeys = readLines(NEW_KEYS_FILE);

if (!newKeys.length) {
  console.error("data/new-keys.txt 里没有新 key。先把新号那10个key一行一个放进去。");
  process.exit(1);
}

console.log(`老号候选：${oldKeys.length} 个`);
console.log(`新号候选：${newKeys.length} 个`);
console.log(`检测模型：${model}`);
console.log("");

const oldResults = [];
for (let i = 0; i < oldKeys.length; i++) {
  const r = await testKey(oldKeys[i], i + 1);
  oldResults.push(r);
  console.log(`${r.ok ? "✅" : "❌"} OLD #${r.index} ${mask(r.key)} status=${r.status} ${r.code || ""} ${r.reason}`);
}

console.log("");

const newResults = [];
for (let i = 0; i < newKeys.length; i++) {
  const r = await testKey(newKeys[i], i + 1);
  newResults.push(r);
  console.log(`${r.ok ? "✅" : "❌"} NEW #${r.index} ${mask(r.key)} status=${r.status} ${r.code || ""} ${r.reason}`);
}

const goodOld = oldResults.filter(r => r.ok).map(r => r.key);
const goodNew = newResults.filter(r => r.ok).map(r => r.key);

const mixed = interleave(goodOld, goodNew);

if (mixed.length < 22) {
  console.log("");
  console.log(`⚠️ 当前可用总数只有 ${mixed.length} 个，少于 22。脚本仍会按现有可用 key 分配。`);
}

const chatApiKeys = mixed.slice(0, 15);
const screenApiKeys = mixed.slice(15, 19);
const proactiveApiKeys = mixed.slice(19, 22);

cfg.apiKeys = mixed;
cfg.apiKey = mixed[0] || "";
cfg.chatApiKeys = chatApiKeys.length ? chatApiKeys : mixed;
cfg.screenApiKeys = screenApiKeys.length ? screenApiKeys : mixed;
cfg.proactiveApiKeys = proactiveApiKeys.length ? proactiveApiKeys : mixed;

cfg.model = "gemini-3.5-flash";
cfg.screenModel = "gemini-3.5-flash";
cfg.proactiveModel = "gemini-3.5-flash";

fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));

fs.writeFileSync(OUT_CHECK, JSON.stringify({
  checkedAt: new Date().toISOString(),
  model,
  oldGood: goodOld.map(mask),
  newGood: goodNew.map(mask),
  oldBad: oldResults.filter(r => !r.ok).map(r => ({
    index: r.index,
    key: mask(r.key),
    status: r.status,
    code: r.code || "",
    reason: r.reason
  })),
  newBad: newResults.filter(r => !r.ok).map(r => ({
    index: r.index,
    key: mask(r.key),
    status: r.status,
    code: r.code || "",
    reason: r.reason
  })),
  totalGood: mixed.length,
  chatCount: cfg.chatApiKeys.length,
  screenCount: cfg.screenApiKeys.length,
  proactiveCount: cfg.proactiveApiKeys.length
}, null, 2));

console.log("");
console.log("分组完成：");
console.log("总可用 apiKeys =", cfg.apiKeys.length);
console.log("chatApiKeys =", cfg.chatApiKeys.length);
console.log("screenApiKeys =", cfg.screenApiKeys.length);
console.log("proactiveApiKeys =", cfg.proactiveApiKeys.length);
console.log("坏 key 已自动排除。报告：data/key-pool-check-result.json");
