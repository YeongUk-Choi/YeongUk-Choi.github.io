// 사이트 전체에서 쓰는 기본 정보. 이 파일만 고치면 모든 페이지에 반영됩니다.
// 2026-09-22 UK 확정: 이름·직함·소속·이메일·사진·Scholar 링크. 영문만 사용(한글 병기 없음).
window.SITE = window.SITE || {};
window.SITE.profile = {
  name: "YeongUk Choi",
  nameKo: "",                                  // 영문만 사용 (UK 지시 2026-09-22)
  title: "M.S. & Ph.D. Candidate",
  affiliation: "Department of Physics, Inha University",
  labs: "QFML & NMPL",                         // 연구실 (소속 뒤에 붙여 표시)
  hero: "Grow new materials — measure what emerges.",
  heroPoints: [                                // 첫 화면 개조식 요약 (UK 지시 2026-09-24). k = 라벨, v = 문자열 또는 줄 배열
    { k: "Grow",        v: ["Single crystal · FeSe, NbSe₂, FeSb", "Thin film · VO₂, LSMO, YBCO"] },
    { k: "PPMS",        v: ["1.8–400 K · ±9 T", "R(T) · R(H) · Hall effect · VSM · heat capacity · angle-dependent"] },
    { k: "Synchrotron", v: "XRD · XPS · XAS" },
    { k: "Software",    v: "COMSOL Multiphysics · VESTA · FullProf (Rietveld refinement)" }
  ],
  now: "Now · in the lab",                     // 첫 화면 상태 배지
  nowAvailable: true,                          // true = 초록 점
  email: "aowlr8945@gmail.com",
  photo: "assets/img/portrait-cutout.png",    // 배경 제거판(투명 PNG). 흰 배경 원본 정방형: portrait.jpg, 원본 비율: portrait-full.jpg
  bookingUrl: "",                              // Google 예약 페이지 / Calendly 링크 (비면 비활성 버튼) — E-18 대기
  calendarEmbedUrl: "",                        // Google Calendar 공개(바쁨/가능) 임베드 URL — E-19 대기
  orcid: "",                                   // 없음. 논문은 Google Scholar 기준 (scripts/fetch_scholar.py)
  scholarUrl: "https://scholar.google.com/citations?user=GAX2tHgAAAAJ&hl=en",
  scholarUser: "GAX2tHgAAAAJ",
  availability: {                              // 주간 가능 요일 (임시) — E-20 대기
    Mon: "busy", Tue: "open", Wed: "busy", Thu: "open", Fri: "lab"
  },
  siteUrl: ""                                  // 배포 후 최종 주소 (QR에 들어갈 값)
};
