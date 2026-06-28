import fs from "fs";

const cfg = JSON.parse(fs.readFileSync("config.json", "utf-8"));
const model = cfg.model || "gemini-3.5-flash";
const keys = [...new Set([
  ...(cfg.apiKeys || []),
  cfg.apiKey,
].filter(Boolean))];

function mask(k) {
  if (!k) return "";
  return k.slice(0, 10) + "..." + k.slice(-6);
}

async function testKey(key, i) {
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
      return { i, key, masked: mask(key), ok: true, status: r.status, reason: "OK" };
    }

    const msg = j?.error?.message || text.slice(0, 180);
    const code = j?.error?.status || "";

    return {
      i,
      key,
      masked: mask(key),
      ok: false,
      status: r.status,
      code,
      reason: msg
    };
  } catch (e) {
    return {
      i,
      key,
      masked: mask(key),
      ok: false,
      status: "NETWORK",
      reason: String(e?.message || e)
    };
  }
}

console.log(`测试模型：${model}`);
console.log(`待测 key 数：${keys.length}`);
console.log("");

const results = [];
for (let i = 0; i < keys.length; i++) {
  const result = await testKey(keys[i], i + 1);
  results.push(result);

  const mark = result.ok ? "✅" : "❌";
  console.log(`${mark} #${result.i} ${result.masked} status=${result.status} ${result.code || ""} ${result.reason}`);
}

const good = results.filter(r => r.ok).map(r => r.key);
const bad = results.filter(r => !r.ok);

fs.writeFileSync("data/key-check-result.json", JSON.stringify({
  checkedAt: new Date().toISOString(),
  model,
  total: keys.length,
  goodCount: good.length,
  badCount: bad.length,
  goodMasked: results.filter(r => r.ok).map(r => r.masked),
  badMasked: bad.map(r => ({
    index: r.i,
    key: r.masked,
    status: r.status,
    code: r.code || "",
    reason: r.reason
  }))
}, null, 2));

fs.writeFileSync("data/valid-keys.json", JSON.stringify(good, null, 2));

console.log("");
console.log(`可用：${good.length} 个`);
console.log(`不可用/限流/失效：${bad.length} 个`);
console.log("结果已写入：data/key-check-result.json");
console.log("可用 key 已写入：data/valid-keys.json");
