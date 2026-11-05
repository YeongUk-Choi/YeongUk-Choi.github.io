/* The shared lab-code entry follows Phase Viewer, but RSM files/calculation
   are entirely local. Only action=xrdcheck contacts the existing endpoint. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id), cfg = window.SITE.rsm;
  const key = 'rsm-studio-open';
  const open = () => { $('rsm-gate').hidden = true; $('rsm-app').hidden = false; window.RsmApp.start(); };
  let accepted = false;
  try { accepted = sessionStorage.getItem(key) === '1'; } catch (_) { /* private browser */ }
  $('end-session').addEventListener('click', () => { try { sessionStorage.removeItem(key); } catch (_) {} location.reload(); });
  if (!cfg.gate || accepted) { open(); return; }
  $('rsm-gate').hidden = false;
  $('gate-form').addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('gate-code').value;
    $('gate-code').value = '';
    $('gate-submit').disabled = $('gate-code').disabled = true;
    $('gate-status').textContent = '코드를 확인하고 있습니다…';
    try {
      const url = window.SITE.phases && window.SITE.phases.relayUrl;
      if (!url) throw new Error('코드 확인 서비스가 설정되지 않았습니다.');
      const r = await fetch(url, {method:'POST', body:new URLSearchParams({action:'xrdcheck',code}), credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',signal:AbortSignal.timeout(30000)});
      if (!r.ok) throw new Error(`코드 확인 서비스: HTTP ${r.status}`);
      const j = await r.json();
      if (!j || j.ok !== true) {
        const msg = String(j && j.error || '');
        throw new Error(/lock|too many/i.test(msg) ? '코드 오류가 누적되어 잠겼습니다. 10분 후 시도하세요.' : /wrong/i.test(msg) ? '공용 코드가 올바르지 않습니다.' : '공용 코드를 확인하지 못했습니다.');
      }
      try { sessionStorage.setItem(key,'1'); } catch (_) {}
      $('gate-status').textContent = ''; open();
    } catch (err) { $('gate-status').textContent = err.message; }
    finally { $('gate-submit').disabled = $('gate-code').disabled = false; }
  });
})();
