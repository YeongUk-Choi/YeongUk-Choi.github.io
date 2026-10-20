// 공개 소프트웨어 목록. 2026-10-20 UK 지시로 신설 — 외부 사람이 받아서 쓸 수 있게 하는 것이 목적.
// 아직 공개할 프로그램을 정하지 않아 목록은 비어 있고, 페이지는 "준비 중" 상태로 뜬다.
//
// 한 항목의 형식:
//   { name:     "He recondenser monitor",         // 화면에 크게 뜨는 이름
//     tagline:  "Reads the cold head and logs it", // 한 줄 설명
//     status:   "released" | "preparing",          // preparing 이면 받기 버튼 없이 "준비 중" 배지
//     kind:     "desktop" | "script" | "web",      // 배지 문구 (실행 방식)
//     what:     "두세 문장. 무엇을 해결하는 물건인지.",
//     needs:    "Windows 7+ · Python 3.8",         // 실행 조건
//     version:  "1.0", date: "2026-10-12",
//     license:  "MIT",                             // 없으면 생략 → "ask before reuse" 로 뜬다
//     cite:     "YeongUk Choi, ... (2026)",        // 논문에 쓸 때 인용할 문장 (선택)
//     links:    [ { label: "Download (.zip)", href: "assets/dl/he-monitor-1.0.zip", primary: true },
//                 { label: "Source", href: "https://github.com/..." } ] }
//
// 파일을 사이트에 같이 올릴 때는 assets/dl/ 에 둔다. GitHub Pages 는 파일 하나당 100 MB 까지다.
window.SITE = window.SITE || {};
window.SITE.software = {
  lede: "Programs I wrote for my own measurements and cleaned up so other people can run them. Free to use; tell me if one breaks.",
  items: []
};
