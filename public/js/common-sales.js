// ===== Common utilities for sales view (no auth) =====

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const escHtml = escapeHtml;

function updateClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const now = new Date();
  const mu = new Date(now.toLocaleString('en-US', { timeZone: 'Indian/Mauritius' }));
  const hh = String(mu.getHours()).padStart(2, '0');
  const mm = String(mu.getMinutes()).padStart(2, '0');
  const ss = String(mu.getSeconds()).padStart(2, '0');
  el.textContent = hh + ':' + mm + ':' + ss;
}

function startClock() {
  updateClock();
  setInterval(updateClock, 1000);
}

let _toastTimer = null;
function showToast(msg, type) {
  type = type || 'success';
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast toast-' + type + ' show';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() { el.classList.remove('show'); }, 3000);
}

function setupHamburgerMenu() {
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const mobileMenu = document.getElementById('mobileMenu');
  if (!hamburgerBtn || !mobileMenu) return;
  hamburgerBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    mobileMenu.classList.toggle('open');
  });
  document.addEventListener('click', function(e) {
    if (!mobileMenu.contains(e.target) && e.target !== hamburgerBtn) {
      mobileMenu.classList.remove('open');
    }
  });
}

function setupLogout() { /* no-op for sales view */ }

function createSmartInterval(fn, intervalMs) {
  var timer = null;
  var lastRun = 0;
  function run() { lastRun = Date.now(); fn(); }
  function start() { if (timer) clearInterval(timer); timer = setInterval(run, intervalMs); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) { stop(); } else { if (Date.now() - lastRun >= intervalMs) run(); start(); }
  });
  start();
  return { start: start, stop: stop };
}
