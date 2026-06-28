(function () {
  const css = `
    .mode-btn {
      background: none; border: 1px solid rgba(201, 168, 106, 0.35);
      color: #c9a86a; font-size: 12px; line-height: 1;
      padding: 4px 10px; border-radius: 14px;
      margin-left: 6px; white-space: nowrap;
      font-family: "Noto Serif SC", serif;
      letter-spacing: 0.5px;
      transition: all 0.2s;
      cursor: pointer;
    }
    .mode-btn.story {
      background: rgba(201, 168, 106, 0.15);
      border-color: #c9a86a;
      color: #ece7df;
    }
    .mode-btn:active { transform: scale(0.94); }
  `;
  document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));
  let currentMode = "daily";
  function init() {
    const who = document.querySelector(".topbar .who");
    if (!who) { setTimeout(init, 200); return; }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mode-btn";
    btn.title = "切换日常/故事模式";
    who.appendChild(btn);
    btn.addEventListener("click", toggle);
    loadMode(btn);
  }
  async function loadMode(btn) {
    try {
      const res = await fetch("/api/conversations/mode");
      const { mode } = await res.json();
      currentMode = mode || "daily";
      render(btn);
    } catch { render(btn); }
  }
  function render(btn) {
    if (currentMode === "story") {
      btn.textContent = "📖 故事";
      btn.classList.add("story");
    } else {
      btn.textContent = "💬 日常";
      btn.classList.remove("story");
    }
  }
  async function toggle() {
    const btn = document.querySelector(".mode-btn");
    const newMode = currentMode === "daily" ? "story" : "daily";
    try {
      await fetch("/api/conversations/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: newMode }),
      });
      currentMode = newMode;
      render(btn);
    } catch (e) { alert("切换失败:" + String(e)); }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }
})();
