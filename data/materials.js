// 주기율표에 표시할 물질 목록 (UK 선정 14개, 2026-09-21; LCMO 해석·기본 VO₂ 확정 2026-09-22).
// 한 물질 = 한 항목. 새 물질은 항목 하나 추가하면 주기율표·칩·상세가 자동 생성됩니다.
// family: oxides | chalcogenides | metals
// elements: 선으로 이을 원소 순서.  dopants: 점선으로 붙이는 도펀트.
// now: true 면 기본 선택.  blurb: 상세 패널 문장 (교과서 수준 설명, UK가 자유롭게 교체).
window.SITE = window.SITE || {};
window.SITE.families = [
  { id: "all",            label: "All" },
  { id: "oxides",         label: "Oxides" },
  { id: "chalcogenides",  label: "Chalcogenides" },
  { id: "metals",         label: "Metals & intermetallics" }
];
window.SITE.materials = [
  // ---- Oxides (8)
  { id: "CrO2",   label: "CrO₂",   formula: "CrO₂",   family: "oxides", elements: ["Cr","O"],
    blurb: "Rutile chromium dioxide, a half-metallic ferromagnet." },
  { id: "LaNiO3", label: "LaNiO₃", formula: "LaNiO₃", family: "oxides", elements: ["La","Ni","O"],
    blurb: "Perovskite nickelate; metallic parent phase of the nickelate family." },
  { id: "RuO2",   label: "RuO₂",   formula: "RuO₂",   family: "oxides", elements: ["Ru","O"],
    blurb: "Rutile ruthenium dioxide, a conducting oxide." },
  { id: "SrFeO3", label: "SrFeO₃", formula: "SrFeO₃", family: "oxides", elements: ["Sr","Fe","O"],
    blurb: "Perovskite ferrate with Fe in an unusually high oxidation state." },
  { id: "VO2",    label: "VO₂",    formula: "VO₂",    family: "oxides", elements: ["V","O"], now: true,
    blurb: "Vanadium dioxide, a metal–insulator transition oxide near room temperature." },
  { id: "W-VO2",  label: "W:VO₂",  formula: "W:VO₂",  family: "oxides", elements: ["V","O"], dopants: ["W"],
    blurb: "Tungsten-doped VO₂; doping shifts the transition temperature." },
  // LSMO·LCMO: UK 지시(2026-09-22) — 조성 x 대신 약어로만 표기. 일반식은 상세 패널에만 작게.
  { id: "LSMO",   label: "LSMO",   formula: "La₁₋ₓSrₓMnO₃", family: "oxides", elements: ["La","Sr","Mn","O"], abbr: true, chipFormula: false,
    blurb: "Strontium-doped lanthanum manganite, a ferromagnetic oxide." },
  { id: "LCMO",   label: "LCMO",   formula: "La₁₋ₓCaₓMnO₃", family: "oxides", elements: ["La","Ca","Mn","O"], abbr: true, chipFormula: false,
    blurb: "Calcium-doped lanthanum manganite." },
  // ---- Chalcogenides (3)
  { id: "Cu2S",   label: "Cu₂S",   formula: "Cu₂S",   family: "chalcogenides", elements: ["Cu","S"],
    blurb: "Copper(I) sulfide." },
  { id: "FeSe",   label: "FeSe",   formula: "FeSe",   family: "chalcogenides", elements: ["Fe","Se"],
    blurb: "Iron selenide, an iron-based superconductor." },
  { id: "NbSe2",  label: "NbSe₂",  formula: "NbSe₂",  family: "chalcogenides", elements: ["Nb","Se"],
    blurb: "Layered niobium diselenide, a van der Waals superconductor." },
  // ---- Metals & intermetallics (3)
  { id: "Nb3Sn",  label: "Nb₃Sn",  formula: "Nb₃Sn",  family: "metals", elements: ["Nb","Sn"],
    blurb: "A15 intermetallic superconductor used in high-field magnets." },
  { id: "Ni80Fe20", label: "Ni₀.₈Fe₀.₂", formula: "Ni₀.₈Fe₀.₂", family: "metals", elements: ["Ni","Fe"],
    blurb: "Permalloy, a soft ferromagnetic alloy." },
  { id: "NiMnSb", label: "NiMnSb", formula: "NiMnSb", family: "metals", elements: ["Ni","Mn","Sb"],
    blurb: "Half-Heusler compound predicted to be half-metallic." }
];
