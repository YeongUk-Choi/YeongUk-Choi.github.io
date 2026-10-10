// PPMS / He 재액화기 패널 설정. 2026-10-10 UK 지시로 신설.
// 측정값은 연구실 PPMS PC(Windows 7)의 수집기가 ppms-status.json / ppms-log.csv 로 올린다(수집기 담당: gpt).
// 헬륨 병 재고는 Google Apps Script 웹앱(apiUrl)을 통해 구글 시트에 기록한다. 비어 있으면 브라우저 안에서만 도는 시연 모드.
window.SITE = window.SITE || {};
window.SITE.ppms = {
  apiUrl: "",                                  // ← Apps Script 배포 후 여기에 웹앱 URL
  statusUrl: "data/ppms-status.json",          // 최근값 한 덩어리
  logUrl: "data/ppms-log.csv",                 // ts,recon_temp_k,dewar_psi,heater_pct,ppms_temp_k,ppms_field_oe
  cylinder: "47 L",
  suppliers: [
    { id: "agas", name: "A gas" },
    { id: "ggas", name: "G gas" }
  ],
  lowStock: 2,                                 // 새 병이 이 수 이하이면 경고
  limits: {
    staleMin: 15,                              // 이 분(分) 넘게 갱신 없으면 "stale"
    pressureSetpoint: 0.45,                    // HRC 듀어 압력 설정값 (psi)
    pressureWarn: 0.15, pressureCrit: 0.30,    // 설정값에서 벗어난 폭 (psi)
    tempWarn: 4.5, tempCrit: 6.0               // 재응축기 콜드팁 보정 온도 (K)
  }
};
