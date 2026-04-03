/**
 * navbar.js — Shared navbar injector for Dev Dashboard
 *
 * Usage (dashboard pages):
 *   <script src="/js/navbar.js"></script>
 *
 * Usage (Royal Heights sales pages — no auth, no logout):
 *   <script src="/js/navbar.js" data-mode="sales"></script>
 *
 * The script auto-detects the active page from window.location.pathname.
 * Place as the FIRST child of <body>.
 *
 * Self-contained: injects its own CSS when style.css is not loaded (e.g. Tailwind pages).
 */
(function () {
  // Capture currentScript eagerly — it's null inside DOMContentLoaded callbacks
  var _currentScript = document.currentScript;

  var NAV_ITEMS = [
    { icon: '🏠', label: 'Accueil',       href: '/home.html', homeAlias: true },
    { icon: '🔧', label: 'Dev',           href: '/dev', matchPrefix: true },
    { icon: '🤖', label: 'Agents',        href: '/agents.html' },
    { icon: '🏛️', label: 'Royal Heights', href: '/royal-heights.html',
      subPaths: ['/royal-heights-prospection.html', '/royal-heights-russia.html', '/prospection-rh.html'] },
    { icon: '⚡', label: 'SynapCoin',     href: '/synapcoin-marketing.html',
      subPaths: ['/synapcoin-docs.html'] },
    { icon: '🐝', label: 'SynapHive',     href: '/synaphive-marketing.html' },
    { icon: '⚙️', label: 'Profil',        href: '/profile.html' },
  ];

  var SALES_ITEMS = [
    { icon: '🏛️', label: 'Projet',         href: '/sales/royal-heights' },
    { icon: '📊', label: 'Prospection IA', href: '/sales/royal-heights/prospection-ia' },
    { icon: '📋', label: 'Prospection',    href: '/sales/royal-heights/prospection' },
    { icon: '🇷🇺', label: 'Marché Russe',   href: '/sales/royal-heights/russia' },
  ];

  function normPath(p) {
    return p.replace(/\/$/, '') || '/';
  }

  function isActive(item) {
    var path = normPath(window.location.pathname);
    if (typeof item === 'string') return path === item;
    var href = normPath(item.href);
    if (item.matchPrefix) return path === href || path.startsWith(href + '/');
    if (item.homeAlias) return path === '/' || path === href;
    if (item.subPaths && item.subPaths.indexOf(path) !== -1) return true;
    return path === href;
  }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function buildLinks(items) {
    return items.map(function (item) {
      var active = isActive(item) ? ' active' : '';
      var ariaCurrent = active ? ' aria-current="page"' : '';
      return '<a href="' + escAttr(item.href) + '" class="btn-nav' + active + '"' + ariaCurrent + ' title="' + escAttr(item.label) + '">' +
        item.icon + ' ' + escAttr(item.label) + '</a>';
    }).join('');
  }

  /** Inject navbar CSS when style.css is not loaded (e.g. Tailwind pages) */
  function ensureStyles() {
    // Check if navbar styles already exist (style.css loaded)
    if (document.querySelector('link[href*="style.css"]')) return;
    var style = document.createElement('style');
    style.textContent =
      '#appNavbar{background:#161b22;border-bottom:1px solid #30363d;padding:0 16px 0 20px;height:52px;display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:100;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;font-size:14px}' +
      '#appNavbar .logo{font-size:14px;font-weight:700;margin-right:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-0.2px}' +
      '#appNavbar .logo a{color:#e6edf3;text-decoration:none;display:inline-flex;align-items:center;gap:6px}' +
      '#appNavbar .logo a:hover{color:#79b8ff;text-decoration:none}' +
      '#appNavbar .logo .logo-icon{color:#58a6ff;font-style:normal}' +
      '#appNavbar .clock{font-size:12px;color:#8b949e;font-variant-numeric:tabular-nums;white-space:nowrap;flex-shrink:0}' +
      '.header-nav{display:flex;gap:4px;align-items:center;flex-shrink:0}' +
      '.btn-nav{padding:4px 10px;border-radius:6px;border:1px solid transparent;background:transparent;color:#8b949e;font-size:12px;font-weight:500;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;transition:color .15s,background .15s,border-color .15s;line-height:1.4;font-family:inherit}' +
      '.btn-nav:hover{background:#21262d;border-color:#30363d;color:#e6edf3;text-decoration:none}' +
      '.btn-nav.active{background:rgba(88,166,255,.1);border-color:rgba(88,166,255,.4);color:#58a6ff}' +
      '.btn-nav.active:hover{background:rgba(88,166,255,.15);color:#79b8ff}' +
      '.btn-logout-home{padding:4px 8px;border-radius:6px;border:1px solid transparent;background:transparent;color:#6e7681;font-size:12px;cursor:pointer;transition:color .15s;white-space:nowrap;flex-shrink:0;font-family:inherit}' +
      '.btn-logout-home:hover{color:#f85149}' +
      '.btn-nav:focus-visible,.hamburger-btn:focus-visible,.btn-logout-home:focus-visible{outline:2px solid #58a6ff;outline-offset:2px}' +
      '.hamburger-btn{display:none;background:transparent;border:1px solid #30363d;color:#8b949e;width:32px;height:32px;border-radius:6px;cursor:pointer;flex-direction:column;gap:4px;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s,color .15s}' +
      '.hamburger-btn:hover{background:#21262d;color:#e6edf3}' +
      '.hamburger-btn .bar{display:block;width:16px;height:2px;background:currentColor;border-radius:1px;transition:transform .2s ease,opacity .2s ease;transform-origin:center;flex-shrink:0}' +
      '.hamburger-btn[aria-expanded="true"] .bar:nth-child(1){transform:translateY(6px) rotate(45deg)}' +
      '.hamburger-btn[aria-expanded="true"] .bar:nth-child(2){opacity:0;transform:scaleX(0)}' +
      '.hamburger-btn[aria-expanded="true"] .bar:nth-child(3){transform:translateY(-6px) rotate(-45deg)}' +
      '.mobile-backdrop{display:none;position:fixed;inset:0;top:52px;background:rgba(0,0,0,.4);z-index:98}' +
      '.mobile-backdrop.open{display:block}' +
      '.mobile-menu{position:fixed;top:52px;left:0;right:0;background:#161b22;border-bottom:1px solid #30363d;z-index:99;display:flex;flex-direction:column;padding:8px 12px 12px;gap:3px;box-shadow:0 8px 24px rgba(0,0,0,.5);transform:translateY(-100%);opacity:0;visibility:hidden;transition:transform .2s ease,opacity .2s ease,visibility .2s;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}' +
      '.mobile-menu.open{transform:translateY(0);opacity:1;visibility:visible}' +
      '.mobile-menu .btn-nav{padding:10px 12px;font-size:13px;width:100%;justify-content:flex-start;border-color:transparent;color:#e6edf3}' +
      '.mobile-menu .btn-nav:hover{background:#21262d;border-color:#30363d}' +
      '.mobile-menu .btn-nav.active{background:rgba(88,166,255,.1);border-color:rgba(88,166,255,.4);color:#58a6ff}' +
      '.mobile-menu .btn-logout-home{padding:10px 12px;font-size:13px;width:100%;text-align:left;border-top:1px solid #21262d;margin-top:4px;padding-top:12px;color:#8b949e}' +
      'body.menu-open{overflow:hidden}' +
      '.readonly-badge{font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(88,166,255,.1);border:1px solid rgba(88,166,255,.3);color:#58a6ff;white-space:nowrap;flex-shrink:0}' +
      '@media(max-width:960px){.header-nav{display:none}.hamburger-btn{display:inline-flex}#appNavbar .clock{display:none}}' +
      '@media(max-width:480px){#appNavbar{height:48px;padding:0 12px}.mobile-menu{top:48px}.mobile-backdrop{top:48px}}' +
      '@media(prefers-reduced-motion:reduce){.btn-nav,.hamburger-btn,.btn-logout-home,.hamburger-btn .bar,.mobile-menu{transition:none}}';
    document.head.appendChild(style);
  }

  function inject() {
    ensureStyles();

    var script = _currentScript ||
      document.querySelector('script[src*="navbar.js"]');
    var mode = script ? script.getAttribute('data-mode') : null;
    var isSales = mode === 'sales';
    var items = isSales ? SALES_ITEMS : NAV_ITEMS;
    var links = buildLinks(items);

    var logoInner = isSales
      ? '🏛️ Royal Heights'
      : '<em class="logo-icon">◆</em> Dev Dashboard';
    var logoHref = isSales ? '/sales/royal-heights' : '/home.html';

    var readonlyBadge = isSales
      ? '<span class="readonly-badge">👁 Vue lecture seule</span>'
      : '';

    var logoutDesktop = isSales
      ? ''
      : '<button class="btn-logout-home" id="logoutBtn" title="Déconnexion">🚪</button>';

    var logoutMobile = isSales
      ? ''
      : '<button class="btn-logout-home" id="logoutBtnMobile">🚪 Déconnexion</button>';

    var html =
      '<header class="home-header" id="appNavbar">' +
        '<div class="logo"><a href="' + escAttr(logoHref) + '">' + logoInner + '</a></div>' +
        readonlyBadge +
        '<button class="hamburger-btn" id="hamburgerBtn" aria-label="Menu" aria-expanded="false">' +
          '<span class="bar"></span><span class="bar"></span><span class="bar"></span>' +
        '</button>' +
        '<nav class="header-nav" role="navigation" aria-label="Navigation principale">' +
          links + logoutDesktop +
        '</nav>' +
        '<div class="clock" id="clock">--:--:--</div>' +
      '</header>' +
      '<div class="mobile-backdrop" id="mobileBackdrop"></div>' +
      '<div class="mobile-menu" id="mobileMenu" role="navigation" aria-label="Menu mobile">' +
        links + logoutMobile +
      '</div>';

    document.body.insertAdjacentHTML('afterbegin', html);

    // Always wire up behavior from here — set flag so common.js skips duplicates
    setupBehavior(isSales);
    window.__navbarReady = true;
  }

  /** Wire up hamburger menu, logout, and clock — sets __navbarReady to prevent common.js duplication */
  function setupBehavior(isSales) {
    var hamburgerBtn = document.getElementById('hamburgerBtn');
    var mobileMenu = document.getElementById('mobileMenu');
    var backdrop = document.getElementById('mobileBackdrop');

    if (hamburgerBtn && mobileMenu) {
      function closeMenu() {
        mobileMenu.classList.remove('open');
        if (backdrop) backdrop.classList.remove('open');
        document.body.classList.remove('menu-open');
        hamburgerBtn.setAttribute('aria-expanded', 'false');
      }
      function openMenu() {
        mobileMenu.classList.add('open');
        if (backdrop) backdrop.classList.add('open');
        document.body.classList.add('menu-open');
        hamburgerBtn.setAttribute('aria-expanded', 'true');
      }
      hamburgerBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        mobileMenu.classList.contains('open') ? closeMenu() : openMenu();
      });
      if (backdrop) backdrop.addEventListener('click', closeMenu);
      document.addEventListener('click', function (e) {
        if (mobileMenu.classList.contains('open') &&
            !mobileMenu.contains(e.target) && e.target !== hamburgerBtn) closeMenu();
      });
      mobileMenu.querySelectorAll('.btn-nav').forEach(function (link) {
        link.addEventListener('click', closeMenu);
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && mobileMenu.classList.contains('open')) {
          closeMenu();
          hamburgerBtn.focus();
        }
      });
    }

    // Logout
    if (!isSales) {
      function doLogout() {
        fetch('/api/logout', { method: 'POST' }).then(function () {
          window.location.href = '/login.html';
        });
      }
      var btn = document.getElementById('logoutBtn');
      if (btn) btn.addEventListener('click', doLogout);
      var btnMobile = document.getElementById('logoutBtnMobile');
      if (btnMobile) btnMobile.addEventListener('click', doLogout);
    }

    // Clock (Mauritius timezone) — pauses when tab is hidden
    var clockEl = document.getElementById('clock');
    if (clockEl) {
      function updateClock() {
        var now = new Date();
        var mu = new Date(now.toLocaleString('en-US', { timeZone: 'Indian/Mauritius' }));
        var hh = String(mu.getHours()).padStart(2, '0');
        var mm = String(mu.getMinutes()).padStart(2, '0');
        var ss = String(mu.getSeconds()).padStart(2, '0');
        clockEl.textContent = '\u{1F1F2}\u{1F1FA} ' + hh + ':' + mm + ':' + ss;
      }
      var clockTimer = setInterval(updateClock, 1000);
      updateClock();
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          clearInterval(clockTimer);
        } else {
          updateClock();
          clockTimer = setInterval(updateClock, 1000);
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
