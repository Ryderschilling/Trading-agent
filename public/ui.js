/* Visual-only UI helpers: theme + pages dropdown (no app logic changes) */

// -----------------------
// Toast notification system
// -----------------------
(function () {
  "use strict";

  function getContainer() {
    let container = document.getElementById("__toastContainer");
    if (!container) {
      container = document.createElement("div");
      container.id = "__toastContainer";
      container.className = "toast-container";
      document.body.appendChild(container);
    }
    return container;
  }

  window.showToast = function showToast(message, type) {
    const validType = type === "error" || type === "success" || type === "info" ? type : "info";
    const container = getContainer();

    const toast = document.createElement("div");
    toast.className = "toast toast-" + validType;
    toast.textContent = String(message || "");

    container.appendChild(toast);

    // Trigger fade-in on next frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.add("toast-visible"));
    });

    const remove = () => {
      toast.classList.remove("toast-visible");
      toast.classList.add("toast-hiding");
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    };

    const timer = setTimeout(remove, 4000);
    toast.addEventListener("click", () => { clearTimeout(timer); remove(); });
  };
})();
(function () {
    "use strict";
  
    const THEME_KEY = "ta_theme";
    const html = document.documentElement;
  
    function preferredFallback() {
      try {
        return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      } catch {
        return "dark";
      }
    }
  
    function applyTheme(theme) {
      html.setAttribute("data-theme", theme);
      try { localStorage.setItem(THEME_KEY, theme); } catch {}
      const btn = document.getElementById("themeToggle");
      if (btn) btn.textContent = theme === "dark" ? "🌙" : "☀️";
    }
  
    function initTheme() {
      let stored = null;
      try { stored = localStorage.getItem(THEME_KEY); } catch {}
      // Default MUST be dark on first visit
      const theme = stored || "dark" || preferredFallback();
      applyTheme(theme === "light" ? "light" : "dark");
    }
  
    function wireTheme() {
      const btn = document.getElementById("themeToggle");
      if (!btn) return;
      btn.addEventListener("click", () => {
        const cur = html.getAttribute("data-theme") || "dark";
        applyTheme(cur === "dark" ? "light" : "dark");
      });
    }
  
    function wirePagesMenu() {
      const btn = document.getElementById("pagesMenuBtn");
      const menu = document.getElementById("pagesMenu");
      if (!btn || !menu) return;
  
      const open = () => { menu.classList.add("open"); btn.setAttribute("aria-expanded", "true"); };
      const close = () => { menu.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); };
      const isOpen = () => menu.classList.contains("open");
  
      btn.setAttribute("type", "button");
      btn.setAttribute("aria-haspopup", "menu");
      btn.setAttribute("aria-expanded", "false");
  
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        isOpen() ? close() : open();
      });
  
      document.addEventListener("click", (e) => {
        if (!isOpen()) return;
        if (menu.contains(e.target) || btn.contains(e.target)) return;
        close();
      });
  
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close();
      });
    }

    function wireTopbarSolidOnScroll() {
        const topbar = document.querySelector(".topbar");
        if (!topbar) return;
      
        const scroller = document.scrollingElement || document.documentElement;
      
        const getY = () => {
          // Works across Safari/Chrome + cases where scroll is on the document element
          return window.scrollY || scroller.scrollTop || 0;
        };
      
        let ticking = false;
      
        const update = () => {
          ticking = false;
          topbar.classList.toggle("is-solid", getY() > 8);
        };
      
        const onScroll = () => {
          if (ticking) return;
          ticking = true;
          requestAnimationFrame(update);
        };
      
        update();
        window.addEventListener("scroll", onScroll, { passive: true });
        document.addEventListener("scroll", onScroll, { passive: true, capture: true });
      }
  
      initTheme();

      document.addEventListener("DOMContentLoaded", () => {
        wireTheme();
        wirePagesMenu();
        wireTopbarSolidOnScroll();
      });
      
      })();

      // Make sticky topbar solid after scrolling (prevents “see-through” jumble)
(() => {
    const topbar = document.querySelector(".topbar");
    if (!topbar) return;
  
    const onScroll = () => {
      topbar.classList.toggle("is-solid", window.scrollY > 8);
    };
  
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll(); // set initial state
  })();

// Shared AI assistant launcher/panel across all app pages
(() => {
  "use strict";

  const AI_CHAT_STORAGE_KEY = "ta_ai_chat_history_v1";
  const AI_CHAT_PENDING_JOB_KEY = "ta_ai_chat_pending_job_v1";

  function ensureAssistantMarkup() {
    if (document.getElementById("aiOperatorPanel") || !document.body) return;

    const launcher = document.createElement("button");
    launcher.id = "aiOperatorLauncher";
    launcher.className = "ai-chat-launcher";
    launcher.type = "button";
    launcher.setAttribute("aria-controls", "aiOperatorPanel");
    launcher.setAttribute("aria-expanded", "false");
    launcher.innerHTML = `<span class="ai-chat-launcher-mark">AI</span>`;

    const panel = document.createElement("section");
    panel.id = "aiOperatorPanel";
    panel.className = "ai-chat-panel";
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = `
      <div class="ai-chat-head">
        <div class="ai-chat-head-copy">
          <div class="ai-chat-eyebrow">Assistant</div>
          <div class="card-title">Trading Friend</div>
        </div>
        <div class="ai-chat-head-actions">
          <div id="aiOperatorStatus" class="badge">Checking connection…</div>
          <button id="aiOperatorNewChatBtn" class="btn" type="button">New Chat</button>
          <button id="aiOperatorCloseBtn" class="btn ai-chat-close" type="button" aria-label="Close AI Operator">×</button>
        </div>
      </div>

      <div class="ai-chat-body">
        <div id="aiOperatorOutput" class="ai-operator-output ai-chat-feed">
          <div class="small">Type a message below. Ask questions or tell it what to do inside the platform.</div>
        </div>

        <div class="ai-chat-composer">
          <textarea
            id="aiOperatorPrompt"
            class="input ai-operator-prompt"
            placeholder="Type a message"
          ></textarea>
          <div class="ai-operator-actions">
            <button id="aiOperatorAskBtn" class="btn btn-primary" type="button">Send</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(launcher);
    document.body.appendChild(panel);
  }

  function initAssistant() {
    if (window.__taAiHandledByUi) return;
    ensureAssistantMarkup();
    window.__taAiHandledByUi = true;

    const statusEl = document.getElementById("aiOperatorStatus");
    const promptEl = document.getElementById("aiOperatorPrompt");
    const askBtn = document.getElementById("aiOperatorAskBtn");
    const outputEl = document.getElementById("aiOperatorOutput");
    const launcherEl = document.getElementById("aiOperatorLauncher");
    const panelEl = document.getElementById("aiOperatorPanel");
    const closeBtnEl = document.getElementById("aiOperatorCloseBtn");
    const newChatBtnEl = document.getElementById("aiOperatorNewChatBtn");

    if (!statusEl || !promptEl || !askBtn || !outputEl || !launcherEl || !panelEl || !closeBtnEl || !newChatBtnEl) {
      return;
    }

    let aiChatHistory = [];
    let activeJobId = "";
    let activeJobPollTimer = 0;

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (m) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      }[m]));
    }

    function loadAiChatHistory() {
      try {
        const raw = localStorage.getItem(AI_CHAT_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        aiChatHistory = Array.isArray(parsed)
          ? parsed
              .map((item) => ({
                role: item?.role === "assistant" ? "assistant" : "user",
                text: String(item?.text || "").trim(),
              }))
              .filter((item) => item.text)
          : [];
      } catch {
        aiChatHistory = [];
      }
    }

    function saveAiChatHistory() {
      try {
        localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify(aiChatHistory.slice(-30)));
      } catch {}
    }

    function loadPendingJobId() {
      try {
        activeJobId = String(localStorage.getItem(AI_CHAT_PENDING_JOB_KEY) || "").trim();
      } catch {
        activeJobId = "";
      }
    }

    function savePendingJobId(jobId) {
      activeJobId = String(jobId || "").trim();
      try {
        if (activeJobId) {
          localStorage.setItem(AI_CHAT_PENDING_JOB_KEY, activeJobId);
        } else {
          localStorage.removeItem(AI_CHAT_PENDING_JOB_KEY);
        }
      } catch {}
    }

    function stopPollingActiveJob() {
      if (activeJobPollTimer) {
        clearTimeout(activeJobPollTimer);
        activeJobPollTimer = 0;
      }
    }

    function setAssistantWorking(isWorking) {
      outputEl.classList.toggle("is-loading", isWorking);
      panelEl.classList.toggle("is-working", isWorking);
      launcherEl.classList.toggle("is-working", isWorking);
      askBtn.disabled = isWorking;
      askBtn.textContent = isWorking ? "Working" : "Send";
      statusEl.textContent = isWorking ? "Working" : (statusEl.dataset.readyLabel || "Ready");
      statusEl.className = `badge ${isWorking ? "working" : (statusEl.dataset.readyClass || "success")}`;
    }

    function renderAiChatThread() {
      if (!aiChatHistory.length) {
        outputEl.innerHTML = `<div class="small">Type a message below. Ask questions or tell it what to do inside the platform.</div>`;
        return;
      }

      outputEl.innerHTML = aiChatHistory
        .map((item) => `
          <div class="ai-chat-message ai-chat-message-${escapeHtml(item.role)}">
            <div class="ai-chat-message-label">${item.role === "assistant" ? "Trading Friend" : "You"}</div>
            <div class="ai-chat-message-text">${escapeHtml(item.text)}</div>
          </div>
        `)
        .join("");

      outputEl.scrollTop = outputEl.scrollHeight;
    }

    function resetAiChatHistory() {
      aiChatHistory = [];
      saveAiChatHistory();
      renderAiChatThread();
    }

    function renderAiOperatorResult(payload) {
      const assumptions = Array.isArray(payload?.assumptions) ? payload.assumptions : [];
      const warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
      const results = Array.isArray(payload?.results) ? payload.results : [];

      const assumptionsHtml = assumptions.length
        ? `<h3>Assumptions</h3><ul>${assumptions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
        : "";

      const warningsHtml = warnings.length
        ? `<h3>Warnings</h3><ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
        : "";

      const resultsHtml = results.length
        ? `<h3>${payload?.dryRun ? "Planned Actions" : "Execution Results"}</h3><ul>${results
            .map((item) => `<li><b>${escapeHtml(item.status || "planned")}</b> - ${escapeHtml(item.message || "")}</li>`)
            .join("")}</ul>`
        : `<div class="small">No actions returned.</div>`;

      if (payload?.mode === "chat") {
        const assistantText = String(payload?.assistantMessage || "").trim();
        if (assistantText) {
          aiChatHistory.push({ role: "assistant", text: assistantText });
        }
        saveAiChatHistory();
        setAssistantWorking(false);
        renderAiChatThread();
        return;
      }

      setAssistantWorking(false);
      outputEl.innerHTML = `
        <p><b>${escapeHtml(payload?.summary || "Strategy plan ready.")}</b></p>
        <p>${escapeHtml(payload?.assistantMessage || "")}</p>
        ${assumptionsHtml}
        ${warningsHtml}
        ${resultsHtml}
      `;
    }

    function setAssistantOpen(nextOpen) {
      panelEl.classList.toggle("open", nextOpen);
      panelEl.setAttribute("aria-hidden", nextOpen ? "false" : "true");
      launcherEl.setAttribute("aria-expanded", nextOpen ? "true" : "false");

      if (nextOpen) {
        window.setTimeout(() => promptEl.focus(), 40);
      }
    }

    async function refreshAiOperatorStatus() {
      if (activeJobId) return;
      try {
        const res = await fetch("/api/agent/status", { cache: "no-store" });
        const json = await res.json();
        const configured = Boolean(json?.status?.configured);

        statusEl.dataset.readyLabel = configured ? "Ready" : "Missing OpenAI key";
        statusEl.dataset.readyClass = configured ? "success" : "error";
        statusEl.textContent = statusEl.dataset.readyLabel;
        statusEl.className = `badge ${statusEl.dataset.readyClass}`;
      } catch {
        statusEl.dataset.readyLabel = "Agent offline";
        statusEl.dataset.readyClass = "error";
        statusEl.textContent = "Agent offline";
        statusEl.className = "badge error";
      }
    }

    async function pollActiveJob(jobId) {
      if (!jobId) return;
      stopPollingActiveJob();

      try {
        const res = await fetch(`/api/agent/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok || !json?.job) {
          throw new Error(json?.error || `Request failed (${res.status})`);
        }

        const job = json.job;
        if (job.status === "running") {
          setAssistantWorking(true);
          activeJobPollTimer = window.setTimeout(() => {
            void pollActiveJob(jobId);
          }, 1200);
          return;
        }

        savePendingJobId("");

        if (job.status === "done") {
          renderAiOperatorResult(job.result || {});
          window.showToast?.("Reply ready.", "success");
          return;
        }

        throw new Error(job.error || "Unknown error");
      } catch (error) {
        savePendingJobId("");
        setAssistantWorking(false);
        renderAiChatThread();
        window.showToast?.(`AI request failed: ${error?.message || "Unknown error"}`, "error");
      }
    }

    async function runAiOperator(mode, dryRun) {
      if (activeJobId) {
        window.showToast?.("The assistant is still working on the last request.", "info");
        return;
      }

      const message = String(promptEl.value || "").trim();
      if (!message) {
        window.showToast?.("Enter a prompt for the AI operator.", "error");
        promptEl.focus();
        return;
      }

      try {
        const chatHistoryForRequest =
          mode === "chat"
            ? aiChatHistory.slice(-12).map((item) => ({ role: item.role, text: item.text }))
            : [];

        if (mode === "chat") {
          aiChatHistory.push({ role: "user", text: message });
          saveAiChatHistory();
          promptEl.value = "";
          renderAiChatThread();
          outputEl.insertAdjacentHTML(
            "beforeend",
            `<div class="ai-chat-typing" id="aiChatTypingIndicator" aria-live="polite"><span></span><span></span><span></span></div>`
          );
          outputEl.scrollTop = outputEl.scrollHeight;
        }

        setAssistantWorking(true);

        const res = await fetch("/api/agent/jobs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message, dryRun, mode, history: chatHistoryForRequest }),
        });

        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok) {
          throw new Error(json?.error || `Request failed (${res.status})`);
        }
        savePendingJobId(json.jobId || "");
        void pollActiveJob(activeJobId);
      } catch (error) {
        if (mode === "chat" && aiChatHistory.length && aiChatHistory[aiChatHistory.length - 1]?.role === "user") {
          aiChatHistory.pop();
          saveAiChatHistory();
        }
        savePendingJobId("");
        setAssistantWorking(false);
        if (mode === "chat") {
          renderAiChatThread();
        } else {
          outputEl.innerHTML = `<div class="small">Unable to run AI operator: ${escapeHtml(error?.message || "Unknown error")}</div>`;
        }
        window.showToast?.("AI request failed.", "error");
      }
    }

    askBtn.addEventListener("click", () => runAiOperator("chat", true));
    launcherEl.addEventListener("click", () => setAssistantOpen(!panelEl.classList.contains("open")));
    closeBtnEl.addEventListener("click", () => setAssistantOpen(false));
    newChatBtnEl.addEventListener("click", () => {
      resetAiChatHistory();
      promptEl.focus();
    });

    promptEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        runAiOperator("chat", true);
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setAssistantOpen(false);
    });

    loadAiChatHistory();
    loadPendingJobId();
    renderAiChatThread();
    refreshAiOperatorStatus();
    if (activeJobId) {
      outputEl.insertAdjacentHTML(
        "beforeend",
        `<div class="ai-chat-typing" id="aiChatTypingIndicator" aria-live="polite"><span></span><span></span><span></span></div>`
      );
      outputEl.scrollTop = outputEl.scrollHeight;
      setAssistantWorking(true);
      void pollActiveJob(activeJobId);
    }
    setInterval(refreshAiOperatorStatus, 5000);
  }

  document.addEventListener("DOMContentLoaded", initAssistant);
})();
