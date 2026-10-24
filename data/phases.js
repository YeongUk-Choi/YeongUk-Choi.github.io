// Crystal Phase Viewer 설정. 2026-10-24 신설.
//
// 이 페이지는 두 가지 방법으로 COD 자료를 얻는다.
//   ① 미리 받아 둔 조성  data/phases/<조성>.json  — 항상 쓴다. 즉시 뜨고, COD가 죽어 있어도 된다.
//   ② 즉석 검색          Apps Script 중계(relayUrl) — ①에 없는 조성일 때만 쓴다.
//
// COD는 Access-Control-Allow-Origin 헤더를 보내지 않으므로 브라우저가 직접 부를 수 없다.
// 그래서 ②는 중계를 거친다. 계약은 scripts/apps-script/COD_PROXY.md.
//
// **live 는 새 Apps Script 를 배포해 확인한 뒤에만 true 로 바꾼다.**
// 켜기 전에 켜면 안 되는 이유: 옛 스크립트는 모르는 action 을 "코드 틀림"으로 처리하고,
// 다섯 번 틀리면 헬륨 병 기록까지 10분간 잠긴다. 방문자가 페이지를 열기만 해도 잠길 수 있다.
// 확인 방법: 배포 주소에 ?action=cod&formula=VO2 를 붙여 열었을 때 ok:true 가 오면 된 것.
//
// gate 는 연구실 공용 코드 화면이다. XRD Studio 와 **같은 코드**(Apps Script 의 XRD_CODE)를
// 쓰고, 확인 방법도 같다(POST action=xrdcheck). 비밀 유지 장치가 아니라 — COD 자료는 공개이고
// 이 페이지 코드는 브라우저에서 읽힌다 — 이 페이지가 쓰는 연구실 Apps Script 배포본의
// 실행·URL Fetch 몫을 지키기 위한 것이다. 그 배포본은 헬륨 재응축기 기록도 같이 받는다.
window.SITE = window.SITE || {};
window.SITE.phases = {
  // 연구실 Apps Script 웹앱. data/ppms.js 의 apiUrl 과 같은 주소다(같은 배포본).
  // 코드 확인(gate)과 COD 중계(live)가 둘 다 이 주소를 쓴다.
  relayUrl: "https://script.google.com/macros/s/AKfycby8gAEUJxLM9gJ_1x6U6g_v8N2yCMB9Rvum194fPG1Op7W8CPesnHKLdTpgotJ9FbudOA/exec",
  live: false,    // COD 즉석 검색. 위 확인(?action=cod 가 ok:true)을 마친 뒤 true.
  gate: true      // 공용 코드 화면. xrdcheck 는 이미 배포돼 있으므로 live 와 무관하게 지금도 동작한다.
};
