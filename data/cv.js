// CV 전용 자료 — 학력과 수상. UK 확정 2026-10-14.
// 논문·측정·물질·Focus는 각각 data/publications.js, measurements.js, materials.js, focus.js에서 가져다 씁니다.
// 여기 고치고 `node scripts/make_cv.mjs` 를 돌리면 PDF(assets/cv/YeongUk-Choi-CV.pdf)가 다시 만들어집니다.
window.SITE = window.SITE || {};
window.SITE.cv = {
  photo: "assets/img/portrait.jpg",  // CV 머리 사진. false면 글자만. true면 사이트 첫 사진을 씁니다.
  updated: "2026-10",                // 머리말의 "Updated" 표기

  education: [
    { from: "2024.03", to: "present",
      degree: "Integrated M.S.–Ph.D. Program, Physics",
      org: "Inha University, Incheon, Republic of Korea",
      note: "Quantum Functional Materials Lab (QFML) · Nano Materials Physics Lab (NMPL)" },
    { from: "2018.03", to: "2024.03",
      degree: "B.S. in Physics",
      org: "Inha University, Incheon, Republic of Korea",
      note: "" }
  ],

  // 수상. detail = 수상 대상이 된 발표 제목.
  awards: [
    { date: "2025.04", year: 2025,
      name: "Outstanding Presentation Award — Poster Session",
      org: "The Korean Physical Society (KPS)",
      note: "2025 KPS Spring Meeting",
      detail: "Investigation of phase transition in self-flux grown VO₂ single crystals" }
  ]
};
