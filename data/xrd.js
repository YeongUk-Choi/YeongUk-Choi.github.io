// Enable only after deploying the updated Apps Script and encrypted app package.
// The existing PPMS endpoint is reused. Never put XRD_CODE or XRD_APP_KEY here.
// 켜는 순서: ① Apps Script에 XRD_CODE·XRD_APP_KEY·XRD_APP_VERSION 설정 → ② 새 버전 배포
// → ③ 그 키로 암호화한 assets/dl/xrd-app.enc + manifest 푸시 → ④ 여기를 true 로.
// 순서를 건너뛰면 Software 카드의 실행 버튼만 떠 있고 문은 안 열립니다.
window.XRD_GATE = {enabled: false};
