const list = document.getElementById("memoryList");
const count = document.getElementById("memoryCount");
const refreshBtn = document.getElementById("refreshBtn");

const form = document.getElementById("memoryForm");
const contentInput = document.getElementById("memoryContent");
const categoryInput = document.getElementById("memoryCategory");
const importanceInput = document.getElementById("memoryImportance");
const keywordsInput = document.getElementById("memoryKeywords");
const submitBtn = document.getElementById("memorySubmitBtn");
const dedupeBtn = document.getElementById("memoryDedupeBtn");
const cancelBtn = document.getElementById("memoryCancelBtn");
const dedupeResult = document.getElementById("dedupeResult");

const searchInput = document.getElementById("memorySearch");
const categoryFilter = document.getElementById("memoryCategoryFilter");
const enabledFilter = document.getElementById("memoryEnabledFilter");

let editingId = null;
let allMemories = [];

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseKeywords(raw) {
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function resetForm() {
  editingId = null;
  contentInput.value = "";
  categoryInput.value = "preference";
  importanceInput.value = "0.8";
  keywordsInput.value = "";
  submitBtn.textContent = "写入记忆库";
  cancelBtn.hidden = true;
}

function getFilteredMemories() {
  const q = (searchInput.value || "").trim().toLowerCase();
  const cat = categoryFilter.value;
  const enabled = enabledFilter.value;

  return allMemories.filter((m) => {
    const keywords = parseKeywords(m.keywords);
    const haystack = [
      m.content,
      m.category,
      m.source,
      keywords.join(",")
    ].join(" ").toLowerCase();

    if (q && !haystack.includes(q)) return false;
    if (cat && m.category !== cat) return false;
    if (enabled !== "" && String(m.enabled) !== enabled) return false;

    return true;
  });
}

function render(memories) {
  count.textContent = `${memories.length} / ${allMemories.length} 条记忆`;

  if (!memories.length) {
    list.innerHTML = `<div class="empty-memory">没有找到符合条件的记忆。</div>`;
    return;
  }

  list.innerHTML = memories.map((m) => {
    const keywords = parseKeywords(m.keywords);
    const enabledClass = m.enabled ? "" : " is-disabled";
    const enabledText = m.enabled ? "启用" : "禁用";

    return `
      <article class="memory-card${enabledClass}">
        <div class="memory-card-top">
          <span class="memory-id">#${m.id}</span>
          <span class="memory-category">${escapeHtml(m.category || "general")}</span>
          <span class="memory-importance">重要度 ${escapeHtml(m.importance ?? 0.5)}</span>
          <span class="memory-enabled">${enabledText}</span>
        </div>

        <div class="memory-content">${escapeHtml(m.content)}</div>

        <div class="memory-keywords">
          ${keywords.map(k => `<span>${escapeHtml(k)}</span>`).join("")}
        </div>

        <div class="memory-meta">
          来源：${escapeHtml(m.source || "unknown")}
          ${m.updated_at ? ` · 更新：${formatTime(m.updated_at)}` : ""}
        </div>

        <div class="memory-actions">
          <button type="button"
            data-action="edit"
            data-id="${m.id}"
            data-content="${escapeHtml(m.content)}"
            data-category="${escapeHtml(m.category || "general")}"
            data-importance="${escapeHtml(m.importance ?? 0.5)}"
            data-keywords="${escapeHtml(keywords.join(","))}">
            修改
          </button>

          <button type="button" data-action="toggle" data-id="${m.id}" data-enabled="${m.enabled ? 1 : 0}">
            ${m.enabled ? "禁用" : "启用"}
          </button>

          <button type="button" data-action="delete" data-id="${m.id}" class="danger">
            删除
          </button>
        </div>
      </article>
    `;
  }).join("");
}

function renderFiltered() {
  render(getFilteredMemories());
}

async function loadMemories() {
  count.textContent = "读取中...";
  list.innerHTML = "";

  try {
    const res = await fetch("/api/memories");
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "读取失败");
    }

    allMemories = data;
    renderFiltered();
  } catch (e) {
    count.textContent = "读取失败";
    list.innerHTML = `<div class="empty-memory">出错了：${escapeHtml(e.message || e)}</div>`;
  }
}

refreshBtn.addEventListener("click", loadMemories);
searchInput.addEventListener("input", renderFiltered);
categoryFilter.addEventListener("change", renderFiltered);
enabledFilter.addEventListener("change", renderFiltered);

cancelBtn.addEventListener("click", resetForm);

list.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;

  const id = btn.dataset.id;
  const action = btn.dataset.action;

  try {
    if (action === "edit") {
      editingId = id;
      contentInput.value = btn.dataset.content || "";
      categoryInput.value = btn.dataset.category || "general";
      importanceInput.value = btn.dataset.importance || "0.5";
      keywordsInput.value = btn.dataset.keywords || "";

      submitBtn.textContent = `保存 #${id}`;
      cancelBtn.hidden = false;
      form.scrollIntoView({ behavior: "smooth", block: "start" });
      contentInput.focus();
      return;
    }

    if (action === "toggle") {
      const enabledNow = btn.dataset.enabled === "1";
      const res = await fetch(`/api/memories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabledNow })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "操作失败");
      await loadMemories();
      return;
    }

    if (action === "delete") {
      if (!confirm("确定删除这条记忆吗？删了就真的没了。")) return;

      const res = await fetch(`/api/memories/${id}`, {
        method: "DELETE"
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "删除失败");
      await loadMemories();
      return;
    }
  } catch (err) {
    alert("操作失败：" + (err.message || err));
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const content = contentInput.value.trim();
  if (!content) {
    alert("先写记忆内容。");
    return;
  }

  const payload = {
    content,
    category: categoryInput.value.trim() || "general",
    importance: Number(importanceInput.value || 0.5),
    keywords: keywordsInput.value
  };

  try {
    // 写入前做一次轻量去重提醒
    const checkRes = await fetch("/api/memories/dedupe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        ignoreId: editingId ? Number(editingId) : 0
      })
    });

    const checkData = await checkRes.json().catch(() => ({}));
    if (checkRes.ok && checkData.matches && checkData.matches.length) {
      renderDedupeResult(checkData);
      const ok = confirm(`发现 ${checkData.matches.length} 条可能重复的记忆，仍然保存吗？`);
      if (!ok) return;
    }

    const url = editingId ? `/api/memories/${editingId}` : "/api/memories";
    const method = editingId ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "保存失败");

    resetForm();
    await loadMemories();
  } catch (e) {
    alert("保存失败：" + (e.message || e));
  }
});

loadMemories();

const previewInput = document.getElementById("previewInput");
const previewBtn = document.getElementById("previewBtn");
const previewResult = document.getElementById("previewResult");

function renderPreview(data) {
  if (!data.memories || !data.memories.length) {
    previewResult.innerHTML = `<div class="empty-memory">没有召回到记忆。</div>`;
    return;
  }

  previewResult.innerHTML = `
    <div class="preview-title">本次预计注入 ${data.count} 条记忆：</div>
    ${data.memories.map((m) => {
      const keywords = parseKeywords(m.keywords);
      return `
        <article class="preview-card">
          <div class="memory-card-top">
            <span class="memory-id">#${m.id}</span>
            <span class="memory-category">${escapeHtml(m.category)}</span>
            <span class="memory-importance">重要度 ${escapeHtml(m.importance)}</span>
            <span class="memory-enabled">${escapeHtml(m.reason)}</span>
          </div>
          <div class="memory-content">${escapeHtml(m.previewContent)}</div>
          <div class="memory-keywords">
            ${keywords.map(k => `<span>${escapeHtml(k)}</span>`).join("")}
          </div>
        </article>
      `;
    }).join("")}
  `;
}

previewBtn.addEventListener("click", async () => {
  const text = previewInput.value.trim();
  if (!text) {
    alert("先输入一句测试话。");
    return;
  }

  previewResult.textContent = "预览中...";

  try {
    const res = await fetch("/api/memories/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "预览失败");

    renderPreview(data);
  } catch (e) {
    previewResult.innerHTML = `<div class="empty-memory">预览失败：${escapeHtml(e.message || e)}</div>`;
  }
});

const suggestBtn = document.getElementById("suggestBtn");
const suggestResult = document.getElementById("suggestResult");

function renderSuggest(data) {
  const candidates = data.candidates || [];

  if (!candidates.length) {
    suggestResult.innerHTML = `<div class="empty-memory">没有提取到值得长期记住的内容。</div>`;
    return;
  }

  suggestResult.innerHTML = candidates.map((c, idx) => {
    const kws = Array.isArray(c.keywords) ? c.keywords : [];
    return `
      <article class="suggest-card">
        <div class="memory-card-top">
          <span class="memory-id">候选 ${idx + 1}</span>
          <span class="memory-category">${escapeHtml(c.category || "general")}</span>
          <span class="memory-importance">重要度 ${escapeHtml(c.importance ?? 0.5)}</span>
        </div>

        <div class="memory-content">${escapeHtml(c.content)}</div>

        <div class="memory-keywords">
          ${kws.map(k => `<span>${escapeHtml(k)}</span>`).join("")}
        </div>

        <div class="memory-actions">
          <button type="button"
            data-action="use-suggest"
            data-content="${escapeHtml(c.content)}"
            data-category="${escapeHtml(c.category || "general")}"
            data-importance="${escapeHtml(c.importance ?? 0.5)}"
            data-keywords="${escapeHtml(kws.join(","))}">
            填入表单
          </button>

          <button type="button"
            data-action="save-suggest"
            data-content="${escapeHtml(c.content)}"
            data-category="${escapeHtml(c.category || "general")}"
            data-importance="${escapeHtml(c.importance ?? 0.5)}"
            data-keywords="${escapeHtml(kws.join(","))}">
            直接写入
          </button>
        </div>
      </article>
    `;
  }).join("");
}

suggestBtn.addEventListener("click", async () => {
  if (!confirm("这会调用一次 Gemini 来总结最近聊天。继续吗？")) return;

  suggestBtn.disabled = true;
  suggestResult.textContent = "生成中...";

  try {
    const res = await fetch("/api/memories/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 24 })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "生成失败");

    renderSuggest(data);
  } catch (e) {
    suggestResult.innerHTML = `<div class="empty-memory">生成失败：${escapeHtml(e.message || e)}</div>`;
  } finally {
    suggestBtn.disabled = false;
  }
});

suggestResult.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;

  if (action === "use-suggest") {
    editingId = null;
    contentInput.value = btn.dataset.content || "";
    categoryInput.value = btn.dataset.category || "general";
    importanceInput.value = btn.dataset.importance || "0.5";
    keywordsInput.value = btn.dataset.keywords || "";

    submitBtn.textContent = "写入记忆库";
    cancelBtn.hidden = false;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    contentInput.focus();
    return;
  }

  if (action === "save-suggest") {
    if (!confirm("确定把这条候选记忆直接写入长期记忆库吗？")) return;

    const payload = {
      content: btn.dataset.content || "",
      category: btn.dataset.category || "general",
      importance: Number(btn.dataset.importance || 0.5),
      keywords: btn.dataset.keywords || ""
    };

    try {
      const res = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "写入失败");

      btn.textContent = "已写入";
      btn.disabled = true;
      await loadMemories();
    } catch (err) {
      alert("写入失败：" + (err.message || err));
    }
  }
});

function renderDedupeResult(data) {
  const matches = data.matches || [];

  if (!matches.length) {
    dedupeResult.innerHTML = `<div class="dedupe-ok">没有发现明显重复，可以写入。</div>`;
    return;
  }

  dedupeResult.innerHTML = `
    <div class="dedupe-warn">发现 ${matches.length} 条可能重复的记忆：</div>
    ${matches.map((m) => {
      const keywords = parseKeywords(m.keywords);
      return `
        <article class="dedupe-card">
          <div class="memory-card-top">
            <span class="memory-id">#${m.id}</span>
            <span class="memory-category">${escapeHtml(m.category || "general")}</span>
            <span class="memory-importance">重要度 ${escapeHtml(m.importance ?? 0.5)}</span>
            <span class="memory-enabled">相似分 ${escapeHtml(m.duplicateScore)}</span>
          </div>

          <div class="memory-content">${escapeHtml(m.content)}</div>

          <div class="memory-keywords">
            ${keywords.map(k => `<span>${escapeHtml(k)}</span>`).join("")}
          </div>
        </article>
      `;
    }).join("")}
  `;
}

async function checkDedupe() {
  const content = contentInput.value.trim();
  if (!content) {
    alert("先写记忆内容，再检查重复。");
    return;
  }

  dedupeResult.textContent = "检查中...";

  try {
    const res = await fetch("/api/memories/dedupe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        ignoreId: editingId ? Number(editingId) : 0
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "检查失败");

    renderDedupeResult(data);
  } catch (e) {
    dedupeResult.innerHTML = `<div class="empty-memory">检查失败：${escapeHtml(e.message || e)}</div>`;
  }
}

dedupeBtn.addEventListener("click", checkDedupe);
