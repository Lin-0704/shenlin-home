import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const MODEL = process.argv[2] || "gemini-3.5-flash";
const API_VERSION = "v1beta";
const DELAY_MS = Number(process.env.CHECK_DELAY_MS || 1600);
const TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS || 20000);

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".termux",
  "dist",
  "build",
  ".next",
  "coverage"
]);

const EXCLUDE_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml"
]);

const ALLOWED_EXTS = new Set([
  ".js", ".mjs", ".cjs",
  ".json",
  ".env",
  ".txt",
  ".md"
]);

const KEY_RE = /AIza[0-9A-Za-z_-]{30,80}/g;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function maskKey(key) {
  if (!key || key.length < 12) return "****";
  return `${key.slice(0, 8)}...${key.slice(-6)}`;
}

function shouldReadFile(filePath) {
  const base = path.basename(filePath);
  const ext = path.extname(filePath);

  if (EXCLUDE_FILES.has(base)) return false;
  if (base.startsWith(".") && !base.startsWith(".env")) return false;

  // 太大的聊天记录/备份就别扫了，免得慢
  if (filePath.includes(`${path.sep}data${path.sep}messages`)) return false;
  if (filePath.includes(`${path.sep}backups${path.sep}`)) return false;

  return ALLOWED_EXTS.has(ext) || base.startsWith(".env");
}

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const ent of entries) {
    const full = path.join(dir, ent.name);

    if (ent.isDirectory()) {
      if (!EXCLUDE_DIRS.has(ent.name)) walk(full, out);
      continue;
    }

    if (ent.isFile() && shouldReadFile(full)) out.push(full);
  }

  return out;
}

function collectKeysFromText(text, source) {
  const found = [];
  const matches = text.matchAll(KEY_RE);

  for (const m of matches) {
    found.push({
      key: m[0],
      source,
      index: m.index ?? -1
    });
  }

  return found;
}

function collectKeys() {
  const byKey = new Map();

  // 1) 扫项目文件
  const files = walk(ROOT);
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const rel = path.relative(ROOT, file);
    const hits = collectKeysFromText(text, rel);

    for (const hit of hits) {
      if (!byKey.has(hit.key)) {
        byKey.set(hit.key, {
          key: hit.key,
          sources: []
        });
      }
      byKey.get(hit.key).sources.push(hit.source);
    }
  }

  // 2) 顺手扫环境变量
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    const hits = collectKeysFromText(value, `ENV:${name}`);

    for (const hit of hits) {
      if (!byKey.has(hit.key)) {
        byKey.set(hit.key, {
          key: hit.key,
          sources: []
        });
      }
      byKey.get(hit.key).sources.push(hit.source);
    }
  }

  return [...byKey.values()].map((item, idx) => ({
    id: idx + 1,
    key: item.key,
    masked: maskKey(item.key),
    sources: [...new Set(item.sources)]
  }));
}

function parseError(text) {
  try {
    const json = JSON.parse(text);
    return {
      status: json?.error?.status || "",
      message: json?.error?.message || text.slice(0, 300),
      raw: json
    };
  } catch {
    return {
      status: "",
      message: text.slice(0, 300),
      raw: null
    };
  }
}

function classify(statusCode, errorStatus, message) {
  const msg = String(message || "");

  if (statusCode === 200) return "✅ OK_3.5";
  if (statusCode === 429) return "🟡 429_额度/限流";
  if (statusCode === 401) return "🔴 401_key无效";
  if (statusCode === 403) return "🔴 403_权限/API未启用";
  if (statusCode === 404) return "🔴 404_模型名或权限范围";
  if ([500, 502, 503, 504].includes(statusCode)) return "🟠 Google服务端抽风";
  if (errorStatus) return `⚪ ${errorStatus}`;

  if (/quota|rate|exhausted/i.test(msg)) return "🟡 额度/限流";
  if (/permission|denied/i.test(msg)) return "🔴 权限问题";
  if (/not found|model/i.test(msg)) return "🔴 模型/接口问题";

  return "⚪ UNKNOWN";
}

async function testKey(item) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const url =
    `https://generativelanguage.googleapis.com/${API_VERSION}/models/${MODEL}:generateContent?key=${item.key}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: "只回复 OK" }]
      }
    ],
    generationConfig: {
      maxOutputTokens: 8,
      temperature: 0
    }
  };

  const started = Date.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await res.text();
    const elapsedMs = Date.now() - started;
    clearTimeout(timer);

    if (res.ok) {
      let reply = "";
      try {
        const json = JSON.parse(text);
        reply = json?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
      } catch {}

      return {
        id: item.id,
        masked: item.masked,
        sources: item.sources,
        model: MODEL,
        http: res.status,
        result: "✅ OK_3.5",
        message: reply.trim() || "OK",
        elapsedMs
      };
    }

    const err = parseError(text);

    return {
      id: item.id,
      masked: item.masked,
      sources: item.sources,
      model: MODEL,
      http: res.status,
      result: classify(res.status, err.status, err.message),
      errorStatus: err.status,
      message: err.message,
      elapsedMs
    };
  } catch (e) {
    clearTimeout(timer);

    return {
      id: item.id,
      masked: item.masked,
      sources: item.sources,
      model: MODEL,
      http: "NETWORK",
      result: e.name === "AbortError" ? "🟠 TIMEOUT" : "🟠 NETWORK_ERROR",
      message: e.message,
      elapsedMs: Date.now() - started
    };
  }
}

function printResult(r) {
  console.log("\n" + "=".repeat(64));
  console.log(`#${r.id} ${r.masked}`);
  console.log(`来源: ${r.sources.join(", ")}`);
  console.log(`模型: ${r.model}`);
  console.log(`结果: ${r.result}`);
  console.log(`HTTP: ${r.http}`);
  console.log(`耗时: ${r.elapsedMs}ms`);

  if (r.message) {
    const msg = String(r.message).replace(/\s+/g, " ").trim();
    console.log(`信息: ${msg.slice(0, 260)}`);
  }
}

async function main() {
  console.log(`正在扫描项目: ${ROOT}`);
  console.log(`测试模型: ${MODEL}`);

  const keys = collectKeys();

  if (!keys.length) {
    console.log("\n没在当前项目里扫到 Gemini key。");
    console.log("你可能把 key 放在手机环境变量、外部配置文件，或者没放在 ~/shenmo-chat 目录下。");
    process.exit(1);
  }

  console.log(`\n扫到 ${keys.length} 个去重后的 Gemini key，只显示打码版本。`);

  const results = [];

  for (const item of keys) {
    const r = await testKey(item);
    results.push(r);
    printResult(r);
    await sleep(DELAY_MS);
  }

  const ok = results.filter(r => r.result.startsWith("✅"));
  const limited = results.filter(r => String(r.result).includes("429"));

  const safeReport = {
    checkedAt: new Date().toISOString(),
    model: MODEL,
    total: results.length,
    okCount: ok.length,
    rateLimitedCount: limited.length,
    results: results.map(r => ({
      id: r.id,
      masked: r.masked,
      sources: r.sources,
      model: r.model,
      http: r.http,
      result: r.result,
      errorStatus: r.errorStatus || "",
      message: String(r.message || "").slice(0, 260),
      elapsedMs: r.elapsedMs
    }))
  };

  fs.writeFileSync(
    "gemini-3p5-key-check-report.json",
    JSON.stringify(safeReport, null, 2),
    "utf8"
  );

  console.log("\n" + "=".repeat(64));
  console.log(`可跑 3.5 Flash: ${ok.length}/${results.length}`);
  console.log(`429 限流/额度: ${limited.length}/${results.length}`);
  console.log("报告已保存: gemini-3p5-key-check-report.json");

  if (ok.length) {
    console.log("\n能跑的 key：");
    for (const r of ok) {
      console.log(`- #${r.id} ${r.masked} 来源: ${r.sources.join(", ")}`);
    }
  } else {
    console.log("\n没有测到能跑 3.5 Flash 的 key。");
    console.log("如果全是 429，大概率是同项目额度爆了，换同项目 key 不一定有用。");
  }
}

main().catch(err => {
  console.error("脚本炸了:", err);
  process.exit(1);
});
