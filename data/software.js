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
//     caveat:   "어디까지 검증했는지",                // 주황 줄로 받기 버튼 위에 뜬다
//     cite:     "YeongUk Choi, ... (2026)",        // 논문에 쓸 때 인용할 문장 (선택)
//     icon:     "assets/img/software/<slug>-icon.svg", // 앱 아이콘 (그림 위 왼쪽)
//     sub:      "Command line · powder XRD",        // 이름 아래 한 줄
//     image:    "assets/img/software/<slug>.jpg",   // 왼쪽 대표 그림 (프로그램 화면)
//     imageNote:"그림 아래 한 줄 설명",
//     features: [ "개조식 한 줄", "또 한 줄" ],      // 오른쪽 기능 목록
//     links:    [ { label: "Download (.zip)", href: "assets/dl/he-monitor-1.0.zip", primary: true } ] }
//   links 가 비어 있으면 받기 버튼은 아예 안 나온다.
//
// 파일을 사이트에 같이 올릴 때는 assets/dl/ 에 둔다. GitHub Pages 는 파일 하나당 100 MB 까지다.
// 2026-10-20 UK 지시로 받기 버튼을 내렸다 — 지금은 보여주기만 한다.
window.SITE = window.SITE || {};
window.SITE.software = {
  lede: "Programs I wrote for my own measurements. Each one is shown with its own screen and what it actually does.",
  items: [
    {
      name: "XRD Studio",
      tagline: "Simulate and fit a symmetric \u03b8\u20132\u03b8 scan of a perovskite film on its substrate \u2014 in a browser, with nothing to install.",
      kind: "web",
      sub: "Runs in your browser \u00b7 thin-film X-ray diffraction",
      icon: "assets/img/software/xrd-studio-icon.svg",
      launch: "xrd-studio.html",
      status: "released",
      version: "1.1", date: "2026-10-21", license: "",
      image: "assets/img/software/xrd-studio.jpg",
      imageAlt: "XRD Studio: a measured and a calculated diffraction pattern with the fit result card, " +
                "thickness 2.25 nm, film lattice 3.970 \u00c5, and the cautions the program raises about the fit",
      imageNote: "Fitting the bundled SRO/STO example. The program says plainly when a result needs review.",
      features: [
        "Thin film on a substrate, kinematic: Laue fringes, lattice gradient, instrumental broadening",
        "33 commercial wafers to pick from \u2014 perovskites, scandates, MgO, spinel, YSZ, sapphire, Si, GaAs, quartz \u2014 or type the lattice in",
        "Any reflection typed in: 110, 0 0 6, 1 -1 2, or four-index 0006 \u00b7 cubic, tetragonal and hexagonal",
        "Fits lattice constant, thickness, zero offset, instrumental width, substrate coherence and background within bounds you set",
        "Per-region residuals, so a good overall score cannot hide a wrong tail",
        "Tells you when a result needs review \u2014 a parameter on its bound, a large residual, a thickness that is a conversion rather than a fit",
        "Runs entirely in your browser; measurement files and fitting stay on your device"
      ],
      needs: "A current browser and the shared lab code \u00b7 Korean and English interface",
      caveat: "One-dimensional kinematic diffraction only \u2014 no dynamical diffraction, tilt, 3D strain, roughness, " +
              "absorption or K\u03b1 doublet. Five substrates are calculated with the full ABO\u2083 structure factor; " +
              "the rest put the peak and the fringe spacing in the right place but approximate the substrate peak height. " +
              "Check your reflection assignment before reading a fitted number as a measurement.",
      links: [{label: "Open in browser", href: "xrd-studio.html", primary: true, page: true}]
    },
    {
      name: "Crystal Phase Viewer",
      tagline: "Type a composition \u2014 and a space group number if you want one phase \u2014 and draw the structures the Crystallography Open Database has for it.",
      kind: "web",
      sub: "Runs in your browser \u00b7 unit cells and reciprocal lattices",
      icon: "assets/img/software/phase-viewer-icon.svg",
      launch: "phases.html",
      status: "released",
      version: "1.0", date: "2026-10-24", license: "",
      image: "assets/img/software/phase-viewer.jpg",
      imageAlt: "Crystal Phase Viewer: VO\u2082 grouped into seven candidates, three of them drawn side by side " +
                "as reciprocal lattices \u2014 rutile P4\u2082/mnm, monoclinic P2\u2081/c and P2/m",
      imageNote: "VO\u2082 as COD holds it: eleven records, grouped by lattice, three drawn together.",
      features: [
        "Groups COD records by lattice: one record is one publication, not one phase",
        "Space group number as a second input \u2014 the filter is applied to the records that come back, not only asked for",
        "Unit cell and reciprocal lattice, side by side for up to ten phases or overlaid for three",
        "Overlays search for the integer lattice relation themselves and print the transformation and the misfit",
        "A plane section (hk0, h0l, 0kl) read face on, the way a reciprocal space map is read",
        "PNG and SVG export, on a dark screen or a white page"
      ],
      needs: "A current browser and the shared lab code \u00b7 Korean interface",
      caveat: "Spot size is a structure factor from atomic numbers only \u2014 not a diffracted intensity: " +
              "no angle-dependent scattering factors, thermal motion, polarisation or absorption. " +
              "A matching lattice metric is evidence that two records are the same phase, not proof, and an " +
              "overlay proposes a geometric relation rather than deriving a group\u2013subgroup one.",
      links: [{label: "Open in browser", href: "phases.html", primary: true, page: true}]
    },
    {
      name: "Rietveld Auto",
      tagline: "A Rietveld refinement engine built to be driven \u2014 by you, or by an AI agent reading its diagnostics.",
      kind: "script",
      sub: "Command line \u00b7 powder X-ray diffraction",
      icon: "assets/img/software/rietveld-auto-icon.svg",
      status: "released",
      version: "0.1.0", date: "2026-10-20", license: "MIT",
      image: "assets/img/software/rietveld-auto.jpg",
      imageAlt: "Rietveld Auto: observed and calculated powder pattern with the difference curve, " +
                "COD candidates ranked by peak match, Rwp 13.58 and GOF 1.68 in the header",
      imageNote: "Refining the bundled VO\u2082 pattern. Blue observed, red calculated, green difference.",
      features: [
        "Indexes a powder pattern with no CIF in hand",
        "Ranks Crystallography Open Database candidates by peak match, with the match rate shown",
        "Refines in planned stages \u2014 snapshot before each one, automatic rollback when a step makes the fit worse",
        "Refuses parameters the crystal system does not allow; warns on correlated pairs before they absorb each other",
        "Le Bail intensity extraction, multiple phases, March\u2013Dollase preferred orientation, TCH profile with asymmetry",
        "Rwp / Rp / GOF, a parameter table with standard deviations, and a running log of every step",
        "Every command answers with one block of JSON, so a script or an AI agent can drive it and reproduce the result"
      ],
      needs: "Python 3.9 or newer \u00b7 gemmi, numpy, scipy \u00b7 internet only for the COD lookup",
      caveat: "Tested against a synthetic VO\u2082 M1 pattern, where it recovers the lattice to 0.003 % and " +
              "ranks the right COD entry first. It has not yet been checked against measured data previously " +
              "refined in FullProf or GSAS, and an unguided single run is a starting point, not a result.",
      links: []
    }
  ]
};
