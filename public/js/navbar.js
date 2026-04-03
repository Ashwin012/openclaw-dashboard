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
 */
(function () {
  var NAV_ITEMS = [
    { icon: '🏠', label: 'Accueil',       href: '/home.html', homeAlias: true },
    { icon: '🔧', label: 'Dev',           href: '/dev', matchPrefix: true },
    { icon: '🤖', label: 'Agents',        href: '/agents.html' },
    { icon: '🏛️', label: 'Royal Heights', href: '/royal-heights.html',
      subPaths: ['/royal-heights-prospection.html', '/royal-heights-russia.html'] },
    { icon: '⚡', label: 'SynapCoin',     href: '/synapcoin-marketing.html' },
    { icon: '🐝', label: 'SynapHive',     href: '/synaphive-marketing.html' },
    { icon: '📄', label: 'SC Docs',       href: '/synapcoin-docs.html' },
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

  function inject() {
    var script = document.currentScript ||
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
