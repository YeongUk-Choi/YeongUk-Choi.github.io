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
  photo: "assets/img/portrait-cutout.png",    // 첫 사진(배경 제거판). 흰 배경 원본 정방형: portrait.jpg, 원본 비율: portrait-full.jpg
  photos: [                                    // 첫 화면에서 번갈아 보일 사진들 (UK 지시 2026-09-24). 한 장이면 고정. 정방형 권장
    "assets/img/portrait-cutout.png",
    "assets/img/photo-otter.jpg",             // UK 제공 2026-09-24 (스크린샷 → 정방형 중앙 크롭 1000px)
    "assets/img/photo-street.jpg"
  ],
  photoInterval: 5000,                         // 사진 교대 간격 (ms)
  bookingUrl: "",                              // Google 예약 페이지 / Calendly 링크 (비면 비활성 버튼) — E-18 대기
  calendarEmbedUrl: "",                        // Google Calendar 공개(바쁨/가능) 임베드 URL — E-19 대기
  orcid: "",                                   // 없음. 논문은 Google Scholar 기준 (scripts/fetch_scholar.py)
  scholarUrl: "https://scholar.google.com/citations?user=GAX2tHgAAAAJ&hl=en",
  scholarUser: "GAX2tHgAAAAJ",
  // 주간 요일표(availability)는 2026-09-24 월간 달력(data/schedule.js)으로 대체됨
  siteUrl: ""                                  // 배포 후 최종 주소 (QR에 들어갈 값)
};
