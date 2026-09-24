// 측정·역량 목록. UK 확정 2026-09-22 (B-7 ~ B-11). 구조는 gpt 제안(5묶음)을 따랐습니다.
// featured: true  → 첫 화면 타일과 명함 뒷면 3줄.
// service:  true  → 외부 의뢰 가능 ("Available on request" 배지). UK: PPMS 측정, COMSOL, Rietveld.
// kind: "measurement" | "synthesis" | "analysis"  (COMSOL·Rietveld는 측정이 아니라 분석으로 분리)
window.SITE = window.SITE || {};
window.SITE.measurements = [
  { featured: true, service: true, kind: "measurement",
    name: "PPMS — transport, magnetism, heat capacity",
    cond: "1.8 – 400 K · ±9 T",
    detail: "R(T) · R(H) · Hall effect · VSM magnetometry · Heat capacity · Angle-dependent transport (rotator)",
    sample: "thin film, single crystal, bulk" },
  { featured: true, service: false, kind: "synthesis",
    name: "Pulsed-laser deposition (PLD)",
    cond: "Nd:YAG · 266 nm",
    detail: "Epitaxial oxide, chalcogenide and intermetallic films — the 14 materials on the periodic-table page",
    sample: "SrTiO₃ · TiO₂ · Al₂O₃ · Si substrates" },
  { featured: true, service: true, kind: "analysis",
    name: "Modeling & analysis",
    cond: "COMSOL · Rietveld",
    detail: "COMSOL Multiphysics simulation · Rietveld refinement of diffraction data",
    sample: "your data or mine" },
  { featured: false, service: false, kind: "measurement",
    name: "Synchrotron methods",
    cond: "beamline",
    detail: "X-ray diffraction (XRD) · X-ray photoelectron spectroscopy (XPS) · X-ray absorption spectroscopy (XAS)",
    sample: "thin film, powder" },
  { featured: false, service: false, kind: "measurement",
    name: "Specialized transport",
    cond: "low T",
    detail: "Andreev spectroscopy · Gate-dependent transport",
    sample: "thin film, device" }
];
