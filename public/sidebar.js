// ============================================================
//  侧边栏 · 多窗口管理
//  自包含模块：注入样式、创建按钮、对接后端
//  不动 app.js 一行代码
// ============================================================
(function () {
  const css = `
    .sidebar-menu-btn {
      background: none; border: none;
      color: #c9a86a; font-size: 24px; line-height: 1;
      padding: 0 8px; margin-right: 4px;
      cursor: pointer; flex-shrink: 0;
    }
    .sidebar-drawer {
      position: fixed; top: 0; left: 0; bottom: 0;
      width: 78%; max-width: 320px;
      background: #16141a;
      border-right: 1px solid rgba(201, 168, 106, 0.2);
      transform: translateX(-105%);
      transition: transform 0.28s ease;
      z-index: 1000;
      display: flex; flex-direction: column;
      padding: max(20px, env(safe-area-inset-top)) 0 max(12px, env(safe-area-inset-bottom));
      box-shadow: 4px 0 24px rgba(0,0,0,0.5);
      font-family: "Noto Serif SC", serif;
    }
    body.sidebar-open .sidebar-drawer { transform: translateX(0); }
    .sidebar-backdrop {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.55);
      opacity: 0; pointer-events: none;
      transition: opacity 0.28s ease;
      z-index: 999;
    }
    body.sidebar-open .sidebar-backdrop { opacity: 1; pointer-events: auto; }
    .sidebar-header {
      font-family: "Cormorant Garamond", "Noto Serif SC", serif;
      font-size: 19px; color: #c9a86a;
      padding: 8px 22px 16px;
      letter-spacing: 2px;
      border-bottom: 1px solid rgba(201, 168, 106, 0.12);
      margin-bottom: 8px;
    }
    .sidebar-list { flex: 1; overflow-y: auto; padding: 4px 0; }
    .sidebar-item {
      display: flex; align-items: center; gap: 6px;
      padding: 13px 18px;
      cursor: pointer;
      transition: background 0.15s;
      border-left: 2px solid transparent;
    }
    .sidebar-item:active { background: rgba(201, 168, 106, 0.06); }
    .sidebar-item.active {
      background: rgba(201, 168, 106, 0.10);
      border-left-color: #c9a86a;
    }
    .sidebar-item-name {
      flex: 1; font-size: 15.5px; color: #ece7df;
    }
    .sidebar-item.active .sidebar-item-name { color: #c9a86a; }
    .sidebar-item-menu {
      background: none; border: none; color: #8a8378;
      font-size: 20px; padding: 4px 10px;
      border-radius: 6px;
    }
    .sidebar-item-menu:active { background: rgba(201, 168, 106, 0.1); }
    .sidebar-new {
      margin: 12px 18px 4px;
      padding: 11px 16px;
      background: transparent;
      border: 1px solid rgba(201, 168, 106, 0.4);
      color: #c9a86a;
      border-radius: 22px;
      font-family: inherit;
      font-size: 14.5px;
      letter-spacing: 1px;
    }
    .sidebar-new:active { background: rgba(201, 168, 106, 0.15); }
  `;
  document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function init() {
    const topbar = document.querySelector(".topbar");
    if (!topbar) { setTimeout(init, 200); return; }

    // ☰ 按钮，放到顶栏最左
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "sidebar-menu-btn";
    menuBtn.textContent = "☰";
    menuBtn.title = "切换窗口";
    menuBtn.addEventListener("click", openDrawer);
    topbar.insertBefore(menuBtn, topbar.firstChild);

    // 抽屉
    const drawer = document.createElement("div");
    drawer.className = "sidebar-drawer";
    drawer.innerHTML = `
      <div class="sidebar-header">窗口</div>
      <div class="sidebar-list">加载中…</div>
      <button type="button" class="sidebar-new">+ 新窗口</button>
    `;
    document.body.appendChild(drawer);

    // 遮罩
    const backdrop = document.createElement("div");
    backdrop.className = "sidebar-backdrop";
    backdrop.addEventListener("click", closeDrawer);
    document.body.appendChild(backdrop);

    drawer.querySelector(".sidebar-new").addEventListener("click", newWindow);
  }

  function openDrawer() {
    document.body.classList.add("sidebar-open");
    refresh();
  }
  function closeDrawer() {
    document.body.classList.remove("sidebar-open");
  }

  async function refresh() {
    const list = document.querySelector(".sidebar-list");
    try {
      const res = await fetch("/api/conversations");
      const { active, conversations } = await res.json();
      list.innerHTML = "";
      conversations.forEach((c) => {
        const item = document.createElement("div");
        item.className = "sidebar-item" + (c.id === active ? " active" : "");
        item.innerHTML = `
          <div class="sidebar-item-name">${escapeHtml(c.name)}</div>
          <button type="button" class="sidebar-item-menu" title="更多">⋯</button>
        `;
        item.querySelector(".sidebar-item-name").addEventListener("click", () => switchTo(c.id));
        item.querySelector(".sidebar-item-menu").addEventListener("click", (e) => {
          e.stopPropagation();
          showItemMenu(c);
        });
        list.appendChild(item);
      });
    } catch (e) {
      list.textContent = "加载失败:" + String(e);
    }
  }

  async function switchTo(id) {
    try {
      await fetch("/api/conversations/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      location.reload();
    } catch (e) { alert("切换失败:" + String(e)); }
  }

  async function newWindow() {
    const name = prompt("新窗口叫什么名字?", "新窗口");
    if (!name) return;
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const { id } = await res.json();
      switchTo(id);
    } catch (e) { alert("新建失败:" + String(e)); }
  }

  async function showItemMenu(c) {
    const choice = prompt(
      `「${c.name}」要做什么?\n  1 = 改名\n  2 = 删除\n  (取消)`,
      ""
    );
    if (choice === "1") {
      const name = prompt("改成什么名字?", c.name);
      if (name && name !== c.name) {
        await fetch("/api/conversations/" + c.id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        refresh();
      }
    } else if (choice === "2") {
      if (confirm(`确定删除「${c.name}」?\n这个窗口的聊天记录会全部消失,不可恢复。`)) {
        await fetch("/api/conversations/" + c.id, { method: "DELETE" });
        location.reload();
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

// ============================================================
//  隐藏入口:头像长按 3 秒 → 弹暗号框 → 暗号对了召唤「调教」
// ============================================================
(function () {
  function attach() {
    const avatar = document.querySelector(".topbar .avatar, .topavatar")
                || document.querySelector(".topbar .avatar");
    if (!avatar) { setTimeout(attach, 300); return; }

    let timer = null;
    let triggered = false;
    const HOLD_MS = 3000;

    function startHold(e) {
      triggered = false;
      // 一点点视觉反馈：缓慢变暗，告诉你"按住中"
      avatar.style.transition = "opacity " + HOLD_MS + "ms linear";
      avatar.style.opacity = "0.4";
      timer = setTimeout(() => {
        triggered = true;
        cancelHold();
        promptSecret();
      }, HOLD_MS);
    }
    function cancelHold() {
      clearTimeout(timer);
      timer = null;
      avatar.style.transition = "opacity 0.2s";
      avatar.style.opacity = "";
    }

    avatar.addEventListener("touchstart", startHold, { passive: true });
    avatar.addEventListener("touchend", cancelHold);
    avatar.addEventListener("touchmove", cancelHold);
    avatar.addEventListener("touchcancel", cancelHold);
    avatar.addEventListener("mousedown", startHold);
    avatar.addEventListener("mouseup", cancelHold);
    avatar.addEventListener("mouseleave", cancelHold);

    // 防止长按之后的"click"事件触发别的逻辑
    avatar.addEventListener("click", (e) => {
      if (triggered) { e.preventDefault(); e.stopPropagation(); triggered = false; }
    }, true);
  }

  async function promptSecret() {
    const secret = prompt("……?", "");
    if (!secret) return;
    try {
      const res = await fetch("/api/conversations/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      if (res.ok) {
        // 暗号对,后端已切到那个窗口,刷新进入
        location.reload();
      } else {
        // 故意不告诉对错,装作什么都没发生
        // (这样别人误触也猜不出来)
      }
    } catch {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
})();
