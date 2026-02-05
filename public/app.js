(() => {
      const socket = io();
    
      const socketDot = document.getElementById("socketDot");
      const enableSoundBtn = document.getElementById("enableSound");
      const feedBody = document.getElementById("feedBody");
      const importantList = document.getElementById("importantList");
      const watchChips = document.getElementById("watchChips");
      const symInput = document.getElementById("symInput");
      const addBtn = document.getElementById("addBtn");
    
      let soundEnabled = false;
    
      // WebAudio “ding” (no mp3 needed)
      function ding() {
        if (!soundEnabled) return;
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = 880;
        g.gain.value = 0.05;
        o.connect(g);
        g.connect(ctx.destination);
        o.start();
        setTimeout(() => {
          o.stop();
          ctx.close();
        }, 140);
      }
    
      enableSoundBtn.addEventListener("click", async () => {
        soundEnabled = true;
        enableSoundBtn.textContent = "Sound Enabled";
        ding(); // unlock audio
      });
    
      function fmtTime(ts) {
        const d = new Date(ts);
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
    
      function row(alert) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${fmtTime(alert.ts)}</td>
          <td><b>${alert.symbol}</b></td>
          <td>${alert.message}</td>
          <td>${alert.market}</td>
          <td>${alert.rs}</td>
          <td>${alert.dir}</td>
          <td>${alert.level}</td>
          <td>${alert.levelPrice ?? "—"}</td>
          <td>${alert.close}</td>
        `;
        return tr;
      }
    
      function importantItem(alert) {
        const div = document.createElement("div");
        div.className = "item";
        const isEntry = alert.message.includes("ENTRY");
        const badge = isEntry ? "red" : "amber";
        div.innerHTML = `
          <div>
            <div><b>${alert.symbol}</b> — ${alert.message}</div>
            <div class="small">${fmtTime(alert.ts)} • Market ${alert.market} • RS ${alert.rs} • ${alert.level} ${alert.levelPrice ?? ""}</div>
          </div>
          <div class="badge ${badge}">${isEntry ? "ENTRY" : "FORMING"}</div>
        `;
        return div;
      }
    
      function renderImportant(alerts) {
        importantList.innerHTML = "";
        const top = alerts
          .filter(a => a.message.includes("SETUP FORMING") || a.message.includes("A+ ENTRY"))
          .slice(-10)
          .reverse();
    
        if (!top.length) {
          importantList.innerHTML = `<div class="small">No active A+ items yet.</div>`;
          return;
        }
        for (const a of top) importantList.appendChild(importantItem(a));
      }
    
      function renderWatchlist(symbols) {
        watchChips.innerHTML = "";
        for (const s of symbols) {
          const chip = document.createElement("div");
          chip.className = "chip";
          const locked = s === "SPY" || s === "QQQ";
          chip.innerHTML = `
            <span>${s}</span>
            ${locked ? `<span class="small">locked</span>` : `<button data-sym="${s}">✕</button>`}
          `;
          watchChips.appendChild(chip);
        }
    
        watchChips.querySelectorAll("button[data-sym]").forEach(btn => {
          btn.addEventListener("click", async () => {
            const sym = btn.getAttribute("data-sym");
            await fetch("/api/watchlist/remove", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ symbol: sym })
            });
          });
        });
      }
    
      addBtn.addEventListener("click", async () => {
        const sym = (symInput.value || "").trim().toUpperCase();
        if (!sym) return;
        symInput.value = "";
        await fetch("/api/watchlist/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: sym })
        });
      });
    
      symInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addBtn.click();
      });
    
      socket.on("connect", () => {
        socketDot.style.background = "#22c55e";
      });
    
      socket.on("disconnect", () => {
        socketDot.style.background = "#ef4444";
      });
    
      let allAlerts = [];
    
      socket.on("init", (payload) => {
        allAlerts = payload.alerts || [];
        feedBody.innerHTML = "";
        for (const a of allAlerts.slice().reverse()) feedBody.appendChild(row(a));
        renderImportant(allAlerts);
        renderWatchlist(payload.symbols || []);
      });
    
      socket.on("watchlist", (payload) => {
        renderWatchlist(payload.symbols || []);
      });
    
      socket.on("alert", (alert) => {
        allAlerts.push(alert);
        feedBody.prepend(row(alert));
        feedBody.firstElementChild?.classList.add("new-animate");
        renderImportant(allAlerts);
        importantList.firstElementChild?.classList.add("new-animate");
        ding();
    
        const old = document.title;
        document.title = "NEW ALERT • Trading Agent";
        setTimeout(() => (document.title = old), 1400);
      });
    })();
