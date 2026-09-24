// 월간 달력 일정. start/end는 "YYYY-MM-DD"(end 포함). kind: beamtime | conference | travel | event (색만 다름)
// 2026-09-24 UK 지시: 주간 요일표 → 월간 달력. 첫 일정: PAL 4D PES 빔타임.
window.SITE = window.SITE || {};
window.SITE.schedule = {
  weekStart: 0,                                // 0 = 일요일 시작, 1 = 월요일 시작
  events: [
    { start: "2026-10-03", end: "2026-10-05", title: "PAL : 4D PES", kind: "beamtime", note: "Pohang Accelerator Laboratory" }
  ]
};
