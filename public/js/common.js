// ===== Common utilities shared across all pages =====

// Auth guard — redirects to login if not authenticated
function requireAuth(callback) {
  fetch('/api/session').then(r => r.json()).then(d => {
    if (!d.authenticated) { window.location.href = '/login.html'; return; }
    if (callback) callback();
  });
}

// Escape HTML to prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Alias for compatibility
const escHtml = escapeHtml;

// Clock — Mauritius timezone (UTC+4)
function updateClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const now = new Date();
  const mu = new Date(now.toLocaleString('en-US', { timeZone: 'Indian/Mauritius' }));
  const hh = String(mu.getHours()).padStart(2, '0');
  const mm = String(mu.getMinutes()).padStart(2, '0');
  const ss = String(mu.getSeconds()).padStart(2, '0');
  el.textContent = `\u{1F1F2}\u{1F1FA} ${hh}:${mm}:${ss}`;
}

function startClock() {
  updateClock();
  setInterval(updateClock, 1000);
}

// Toast notifications
let _toastTimer = null;
function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast toast-${type} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.classList.remove('show'); }, 3000);
}

// Logout handler
function setupLogout() {
  function doLogout() {
    fetch('/api/logout', { method: 'POST' }).then(() => window.location.href = '/login.html');
  }
  const btn = document.getElementById('logoutBtn');
  if (btn) btn.addEventListener('click', doLogout);
  const btnMobile = document.getElementById('logoutBtnMobile');
  if (btnMobile) btnMobile.addEventListener('click', doLogout);
}

// Hamburger menu
function setupHamburgerMenu() {
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const mobileMenu = document.getElementById('mobileMenu');
  const backdrop = document.getElementById('mobileBackdrop');
  if (!hamburgerBtn || !mobileMenu) return;
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
  hamburgerBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (mobileMenu.classList.contains('open')) closeMenu(); else openMenu();
  });
  if (backdrop) backdrop.addEventListener('click', closeMenu);
  document.addEventListener('click', e => {
    if (!mobileMenu.contains(e.target) && e.target !== hamburgerBtn) closeMenu();
  });
  mobileMenu.querySelectorAll('.btn-nav').forEach(function(link) {
    link.addEventListener('click', closeMenu);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && mobileMenu.classList.contains('open')) {
      closeMenu();
      hamburgerBtn.focus();
    }
  });
}

// Visibility-aware interval — pauses when tab is hidden
function createSmartInterval(fn, intervalMs) {
  let timer = null;
  let lastRun = 0;

  function run() {
    lastRun = Date.now();
    fn();
  }

  function start() {
    if (timer) clearInterval(timer);
    timer = setInterval(run, intervalMs);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stop();
    } else {
      // If enough time has passed, run immediately then restart
      const elapsed = Date.now() - lastRun;
      if (elapsed >= intervalMs) run();
      start();
    }
  });

  start();
  return { start, stop };
}

// Initialize common UI on every page
function initCommon(callback) {
  setupLogout();
  setupHamburgerMenu();
  startClock();
  requireAuth(callback);
}
