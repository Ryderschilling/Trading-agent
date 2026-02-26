/* Visual-only UI helpers: theme + pages dropdown (no app logic changes) */
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