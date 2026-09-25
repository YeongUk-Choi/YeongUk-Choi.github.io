// 월간 달력 일정. start/end는 "YYYY-MM-DD"(end 포함). kind: beamtime | conference | travel | event (색만 다름)
// confirmed: ["시작","끝"] (선택) — 본 일정 범위. 범위 밖의 날은 예비일로 반투명 표시. 없으면 전체가 본 일정.
// 2026-09-24 UK 지시: 주간 요일표 → 월간 달력. 첫 일정: PAL 4D PES 빔타임 (10/4–7, UK 수정 지시).
window.SITE = window.SITE || {};
window.SITE.schedule = {
  weekStart: 0,                                // 0 = 일요일 시작, 1 = 월요일 시작
  events: [
    // confirmed: 본 일정 범위. 그 밖의 날(10/4, 10/7)은 예비일로 달력에서 반투명하게 그린다 (2026-09-25 UK 지시)
    { start: "2026-10-04", end: "2026-10-07", confirmed: ["2026-10-05", "2026-10-06"], title: "PAL : 4D PES", kind: "beamtime", note: "Pohang Accelerator Laboratory" },
    // 2026-09-25 UK 지시: 본 일정 10/20–22, 예비일 10/19·10/23
    { start: "2026-10-19", end: "2026-10-23", confirmed: ["2026-10-20", "2026-10-22"], title: "PAL : 3A XRS", kind: "beamtime", note: "Pohang Accelerator Laboratory" },
    // 2026-09-25 UK 지시: 본 일정 10/27–30, 예비일 10/26·10/31
    { start: "2026-10-26", end: "2026-10-31", confirmed: ["2026-10-27", "2026-10-30"], title: "PAL : 2A MS_MPK", kind: "beamtime", note: "Pohang Accelerator Laboratory" }
  ]
};
