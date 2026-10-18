/**
 * Floating "restart dsh" button, injected into the Web UI by nginx.
 *
 * There is no restart affordance in dsh itself (no /api/*restart* route, and the
 * plugin manager only says "takes effect next launch"). The switch behind this
 * button is the container's own /__restart endpoint: it kills dsh, the entrypoint
 * ends the container, and Docker's restart policy rebuilds the stack.
 *
 * Kept dependency-free and defensive: this runs inside somebody else's SPA, so it
 * never throws, never touches the app tree, and removes itself if the page wipes it.
 */
(function () {
  if (window.__dshRestartButtonInstalled) return;
  window.__dshRestartButtonInstalled = true;

  var ID_BTN = '__dsh-restart-btn';
  var ID_STYLE = '__dsh-restart-style';
  var ID_POP = '__dsh-restart-pop';
  var ID_MASK = '__dsh-restart-mask';

  var CSS =
    '#' + ID_BTN + '{position:fixed;right:22px;bottom:22px;z-index:2147483000;' +
    'width:44px;height:44px;border-radius:50%;border:1px solid rgba(148,163,184,.45);' +
    'background:rgba(30,41,59,.82);color:#e2e8f0;cursor:pointer;display:flex;' +
    'align-items:center;justify-content:center;padding:0;box-shadow:0 6px 18px rgba(2,6,23,.35);' +
    'backdrop-filter:blur(6px);transition:transform .15s ease,background .15s ease,opacity .15s ease;' +
    'opacity:.55;font-family:inherit}' +
    '#' + ID_BTN + ':hover{opacity:1;transform:translateY(-1px);background:rgba(37,99,235,.92);color:#fff}' +
    '#' + ID_BTN + '[data-busy="1"]{opacity:1;background:rgba(37,99,235,.92);color:#fff;cursor:progress}' +
    '#' + ID_POP + '{position:fixed;right:22px;bottom:74px;z-index:2147483001;width:236px;' +
    'padding:14px 14px 12px;border-radius:12px;border:1px solid rgba(148,163,184,.35);' +
    'background:rgba(15,23,42,.96);color:#e2e8f0;box-shadow:0 12px 32px rgba(2,6,23,.5);' +
    'font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '#' + ID_POP + ' p{margin:0 0 11px;color:#cbd5e1}' +
    '#' + ID_POP + ' div{display:flex;gap:8px;justify-content:flex-end}' +
    '#' + ID_POP + ' button{flex:0 0 auto;padding:6px 13px;border-radius:8px;cursor:pointer;' +
    'font:12px system-ui,sans-serif;border:1px solid rgba(148,163,184,.4);background:transparent;color:#cbd5e1}' +
    '#' + ID_POP + ' button[data-go="1"]{background:#2563eb;border-color:#2563eb;color:#fff}' +
    '#' + ID_POP + ' button:hover{filter:brightness(1.12)}' +
    '#' + ID_MASK + '{position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(2,6,23,.66);backdrop-filter:blur(3px);' +
    'font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e2e8f0}' +
    '#' + ID_MASK + ' .card{padding:26px 30px;border-radius:14px;text-align:center;' +
    'background:rgba(15,23,42,.96);border:1px solid rgba(148,163,184,.3);box-shadow:0 18px 50px rgba(2,6,23,.55)}' +
    '#' + ID_MASK + ' .spin{width:30px;height:30px;margin:0 auto 14px;border-radius:50%;' +
    'border:3px solid rgba(148,163,184,.28);border-top-color:#60a5fa;animation:__dshspin .8s linear infinite}' +
    '#' + ID_MASK + ' .sub{margin-top:6px;font-size:12px;color:#94a3b8}' +
    '#__dsh-restart-mask .err .spin{display:none}' +
    '@keyframes __dshspin{to{transform:rotate(360deg)}}';

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (html != null) n.innerHTML = html;
    return n;
  }

  /**
   * Probe endpoint: /login answers 200 as soon as dsh serves, with or without a
   * session. Do NOT probe /go here — with a web-auth plugin installed the token
   * exchange behind it is rejected (401), so the poll would never see "up".
   */
  var PROBE = '/login';

  /** /__restart is behind Basic Auth; the browser attaches it for same-origin calls. */
  function waitUntilUp(maxMs) {
    var t0 = Date.now();
    return sleep(3000).then(function loop() {
      if (Date.now() - t0 > maxMs) return false;
      return fetch(PROBE + '?r=' + Date.now(), { cache: 'no-store', redirect: 'follow' })
        .then(function (r) {
          // 200 = fully up; 404 = alive but this build has no /login. Either way
          // the stack is serving again. 5xx means nginx is up but dsh is not yet.
          return r.status === 200 || r.status === 404;
        })
        .catch(function () { return false; })
        .then(function (ok) {
          if (ok) return true;
          return sleep(2000).then(loop);
        });
    });
  }

  function mask(text, sub) {
    var m = document.getElementById(ID_MASK);
    if (!m) {
      m = el('div', { id: ID_MASK });
      document.body.appendChild(m);
    }
    m.innerHTML = '<div class="card"><div class="spin"></div>' +
      '<div class="msg"></div><div class="sub"></div></div>';
    m.querySelector('.msg').textContent = text;
    m.querySelector('.sub').textContent = sub || '';
    return m;
  }

  function restart(btn) {
    closePop();
    btn.setAttribute('data-busy', '1');
    mask('正在重启 dsh…', '预计 10 秒左右，完成后自动回到主界面');

    // The endpoint answers first and kills dsh afterwards, so a rejection here
    // (or a 502 while the container is already down) is expected, not a failure.
    fetch('/__restart', { cache: 'no-store' }).catch(function () {});

    waitUntilUp(120000).then(function (up) {
      if (up) {
        mask('已恢复，正在载入…', '');
        // Go back to the app root, not /go: the session cookie decides whether we
        // land in the UI or on the login page, and re-running the token exchange
        // can fail outright when a web-auth plugin is in charge.
        location.replace('/');
      } else {
        var m = document.getElementById(ID_MASK);
        if (m) {
          m.firstChild.className = 'card err';
          m.querySelector('.msg').textContent = '没能自动恢复';
          m.querySelector('.sub').textContent =
            '请手动刷新；仍不行就到服务器上 docker compose logs dsh-web 看看';
        }
        btn.removeAttribute('data-busy');
      }
    });
  }

  function closePop() {
    var p = document.getElementById(ID_POP);
    if (p) p.remove();
  }

  function confirmPop(btn) {
    if (document.getElementById(ID_POP)) { closePop(); return; }
    var p = el('div', { id: ID_POP });
    p.innerHTML = '<p>重启 dsh？<br>正在跑的任务会中断，配置与会话不受影响。</p>' +
      '<div><button type="button" data-go="0">取消</button>' +
      '<button type="button" data-go="1">确认重启</button></div>';
    document.body.appendChild(p);
    p.querySelector('[data-go="0"]').onclick = closePop;
    p.querySelector('[data-go="1"]').onclick = function () { restart(btn); };
    // dismiss on any outside click, but not on the button itself (it toggles)
    setTimeout(function () {
      document.addEventListener('click', function onDoc(e) {
        if (p.isConnected && !p.contains(e.target) && e.target !== btn) {
          closePop();
          document.removeEventListener('click', onDoc);
        }
      });
    }, 0);
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 200); return; }
    if (document.getElementById(ID_BTN)) return;
    // no restart button on the login screen
    if (location.pathname === '/login') return;

    if (!document.getElementById(ID_STYLE)) {
      var s = el('style', { id: ID_STYLE });
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    var btn = el('button', {
      id: ID_BTN,
      type: 'button',
      title: '重启 dsh',
      'aria-label': '重启 dsh'
    });
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>';
    btn.onclick = function () {
      if (btn.getAttribute('data-busy') === '1') return;
      confirmPop(btn);
    };
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  }
  boot();
})();
