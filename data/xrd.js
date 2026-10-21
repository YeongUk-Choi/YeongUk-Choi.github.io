// The existing PPMS endpoint checks the shared lab code. Do not put XRD_CODE here.
// 켜는 순서: ① Apps Script에 XRD_CODE 설정 → ② xrdcheck 지원 버전 배포
// → ③ 평문 앱 assets/xrd/ 배포 → ④ 여기를 true 로.
// 이 값은 Software 진입 버튼과 코드 화면의 스위치입니다. 앱 주소로 직접 접속할 수 있습니다.
// 2026-10-21 켬: 네 단계 모두 확인(xrdcheck 가 맞는 코드에 ok:true, 틀린 코드에 "Wrong code.").
window.XRD_GATE = {enabled: true};
