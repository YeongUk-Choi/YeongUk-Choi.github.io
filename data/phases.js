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
window.SITE = window.SITE || {};
window.SITE.phases = {
  relayUrl: "",   // 예: https://script.google.com/macros/s/…/exec  (PPMS 와 같은 웹앱)
  live: false     // 위 확인을 마친 뒤 true
};
