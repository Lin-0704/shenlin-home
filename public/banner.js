(function () {
  const css = `
    .shenmo-banner {
      padding: 8px 14px 10px;
      background: linear-gradient(180deg, rgba(40,30,20,0.85) 0%, rgba(22,20,26,0.95) 100%);
      border-bottom: 1px solid rgba(201, 168, 106, 0.15);
      font-family: "Noto Serif SC", serif;
      color: #ece7df;
      text-align: center;
      letter-spacing: 0.5px;
    }
    .shenmo-banner .banner-row1 {
      font-size: 12px; color: #c9a86a;
      display: flex; justify-content: center; align-items: center;
      gap: 8px; flex-wrap: wrap; line-height: 1.5;
    }
    .shenmo-banner .banner-row1 .heart {
      font-size: 13px; animation: pulse 2.4s ease-in-out infinite;
    }
    @keyframes pulse {
      0%,100% { transform: scale(1); opacity: 0.9; }
      50% { transform: scale(1.15); opacity: 1; }
    }
    .shenmo-banner .banner-row1 .dot { color: rgba(201, 168, 106, 0.4); }
    .shenmo-banner .banner-row2 {
      margin-top: 4px; font-size: 12px;
      color: #ece7df; font-style: italic;
      line-height: 1.55; letter-spacing: 0.8px;
      opacity: 0.92; min-height: 1.55em;
    }
    .shenmo-banner .banner-row2.loading { opacity: 0.4; font-style: normal; }
  `;
  document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));

  let bannerEl = null, lastData = null;

  function fmt(d) {
    return `<span class="heart">💗</span>
      <span>${esc(d.date)}</span><span class="dot">·</span>
      <span>${esc(d.weekday)}</span><span class="dot">·</span>
      <span>${esc(d.time)}</span><span class="dot">·</span>
      <span>在一起第${d.togetherDay}天</span><span class="dot">·</span>
      <span>求婚后第${d.proposalDay}天</span>`;
  }
  function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  async function refresh() {
    try {
      const res = await fetch("/api/banner");
      const data = await res.json();
      lastData = data;
      render();
    } catch (e) { console.warn("banner fail", e); }
  }
  function render() {
    if (!bannerEl || !lastData) return;
    bannerEl.querySelector(".banner-row1").innerHTML = fmt(lastData);
    const r2 = bannerEl.querySelector(".banner-row2");
    if (lastData.sweetTalk) { r2.textContent = lastData.sweetTalk; r2.classList.remove("loading"); }
    else { r2.textContent = "……"; r2.classList.add("loading"); }
  }
  function init() {
    const topbar = document.querySelector(".topbar");
    if (!topbar) { setTimeout(init, 200); return; }
    bannerEl = document.createElement("div");
    bannerEl.className = "shenmo-banner";
    bannerEl.innerHTML = `<div class="banner-row1">……</div><div class="banner-row2 loading">……</div>`;
    topbar.insertAdjacentElement("afterend", bannerEl);
    refresh();
    setInterval(refresh, 60 * 1000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
