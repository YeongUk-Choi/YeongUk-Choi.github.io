# RSM Studio calculation model

RSM Studio calculates reciprocal-lattice positions and an approximate relative-intensity map from separate substrate and film CIFs. The map uses Gaussian peaks. A separate analytical thickness profile shows ideal slab interference. The implementation is in [rsm-core.js](../assets/js/rsm-core.js), with [CIF validation](../assets/js/rsm-cif.js) and [atomic form factors](../assets/js/rsm-factors.js).

## Coordinates and orientation

**RSM-01.** All calculations use **q = 1/d in Å⁻¹, without 2π**. For direct basis vectors a, b, c and cell volume V:

```text
a* = (b × c)/V, with cyclic expressions for b* and c*
g(hkl) = h a* + k b* + l c*
|g| = 1/d(hkl)
```

The general metric supports oblique cells. For a different convention Q = 2π/d, multiply every q component by 2π. See [IUCr, The reciprocal lattice, §2.1–2.2](https://www.iucr.org/what-we-do/education/pamphlets/reciprocal-lattice).

Each layer has its own surface `(h k l)` and direct-lattice reference `[u v w]`. The surface normal uses the reciprocal basis; the reference direction uses the direct basis and is projected onto that surface to define x. Then y = z × x. Nearly collinear input directions are rejected. CIF cell parameters alone do not establish the film–substrate orientation relationship; this follows from the separate metric and rotation parts of the [IUCr orientation matrix](https://dictionary.iucr.org/Orientation_matrix).

Layer tilt rotates about sample y, followed by azimuth about sample z. Each domain applies another such rotation. **These rotations move both the reciprocal lattice and the finite-coherence axes.** Crystallites tilted independently inside a flat slab would require a separate shape orientation and are not this model. Editing the cell retains the expanded fractional atomic coordinates; the imported space-group label need not describe the deformed cell.

## Structure factors and intensity scale

**RSM-02.** With symmetry-expanded sites j, occupancy o, fractional position r and isotropic displacement parameter B:

```text
s = |g|/2
f0_j(s) = Σ(i=1…4) a_ij exp(−b_ij s²) + c_j
F(hkl) = Σ_j o_j f0_j(s) exp(−B_j s²) exp[2πi(hx_j + ky_j + lz_j)]
```

The coefficients are neutral-atom IT92 values exported from Gemmi 0.7.5, for H–Cf and D. The valid range is s < 2 Å⁻¹, hence |q| < 4 Å⁻¹. Unsupported elements and out-of-range arguments fail explicitly. Missing isotropic displacement values use B = 0 with a warning. Sources: [Gemmi X-ray form-factor documentation](https://gemmi.readthedocs.io/en/stable/scattering.html#x-ray-form-factors), [versioned coefficient source and ordering](https://github.com/project-gemmi/gemmi/blob/v0.7.5/include/gemmi/it92.hpp), and [IUCr International Tables C §6.1.1.7, structure factor](https://onlinelibrary.wiley.com/iucr/itc/Cb/ch6o1v0001/sec6o1o1o7/).

**RSM-03.** A reflection's map weight is:

```text
W = user_layer_scale × domain_fraction × |F/Vcell|²
I3D(q) = Σ_reflections W × normalized_3D_Gaussian(q − g, covariance)
```

Domain fractions sum to one within each layer. Substrate, film and domain **intensities** add; interfacial coherent amplitude interference is omitted. Dividing F by Vcell makes equivalent primitive/conventional/supercell descriptions give the same map weight. The table retains the raw |F|², which can differ between such descriptions.

Layer scales are arbitrary. At fixed cell and scale, changing thickness or coherence length changes peak width while keeping its integrated three-dimensional weight fixed. This does **not** predict the absolute t² peak-height increase of a growing film at fixed illuminated area. Finite views, slice offsets and accessibility masks can further reduce the displayed integral. The browser UI does not apply polarization correction or expose a control for it. Only the core API accepts `state.polarization = true`, applying `(1 + cos²(2θ))/2` in the xz cut at qy = 0 where a scattering angle exists. There is no powder multiplicity or powder Lorentz factor.

## Gaussian map and conditional slices

**RSM-04.** Write κ = 2√(2 ln 2), so Gaussian FWHM = κσ. For film thickness t and lateral coherence L, in Å:

```text
σnormal = 0.886/(κt)
σlateral = 0.886/(κL)
Σsize = σlateral²(ex exᵀ + ey eyᵀ) + σnormal² ez ezᵀ
```

This matches the central slab peak's approximate FWHM; it does not reproduce sidelobes. Substrate size broadening instead uses the user-specified isotropic effective Gaussian FWHM, without identifying it as a Darwin width.

With n = g/|g|, mosaic FWHM m in radians and fractional microstrain FWHM ε, the implemented small-spread approximation is:

```text
Σ = Σsize
  + (|g|m/κ)² (I − nnᵀ)             # transverse mosaic spread
  + (|g|ε/κ)² nnᵀ                    # radial microstrain
  + diag(σinstrument,x², σinstrument,y², σinstrument,z²)
```

**RSM-05.** The plotted image is a cut through that three-dimensional distribution. It is not a projection of every reciprocal point onto two axes. Let P denote the two plotted coordinates, w the omitted coordinate and δ = slice − g_w:

```text
conditional centre = g_P + Σ_Pw δ/Σ_ww
conditional covariance = Σ_PP − Σ_Pw Σ_wP/Σ_ww
slice density = exp(−δ²/(2Σ_ww)) / sqrt(2πΣ_ww)
```

The normalized two-dimensional Gaussian is multiplied by `W × slice density`. This also handles the shifted intersection of a tilted ellipsoid with the slice. Peaks beyond five standard deviations in the omitted coordinate are skipped. These equations are implemented in `peakCovariance` and `sliceProfile` and independently checked in the [analytic core tests](../scripts/test_rsm_core.cjs).

For rendering, a Gaussian approximation to the pixel aperture adds Δqx²/12 and Δqvertical²/12 to the two diagonal variances. A Poisson-summation correction normalizes the sampled integral as peaks move between pixels; rendering truncates the Gaussian at six standard deviations. This sampling term is excluded from physical covariance. Under-resolved peaks produce a warning: zoom before interpreting widths.

## Separate thickness profile

**RSM-06.** `thicknessLine` plots the continuous, uniform slab formula:

```text
I(Δqnormal)/I(0) = sinc²(πt Δqnormal),  sinc(x) = sin(x)/x
```

Its first zeros lie at ±1/t; for 50 nm, they are ±0.002 Å⁻¹. It has no instrument broadening and is neither an atomically discrete Laue function nor the map's Gaussian profile. The single-peak slab approximation becomes less reliable for very small numbers of planes. Source: Thomas and Noyan, *J. Appl. Cryst.* **56**, 128–134 (2023), [§2.1, equations (5)–(9)](https://journals.iucr.org/j/issues/2023/01/00/xx5007/index.html), DOI 10.1107/S160057672201069X; the expression above converts their convention to q = 1/d.

## Optional elastic relaxation

**RSM-07.** The shortcut is restricted to cubic reference cells with aligned `(001)/[100]` cube-on-cube orientation. It assumes isotropic biaxial plane stress, giving:

```text
a_parallel = a_substrate + R(a_film,0 − a_substrate)
εparallel = (a_parallel − a_film,0)/a_film,0
εnormal = −2ν/(1 − ν) × εparallel
c = c_film,0(1 + εnormal)
```

Here R = 0 clamps the in-plane cell to the substrate; R = 1 returns the film reference cell. The out-of-plane expression follows from isotropic Hooke's law with equal in-plane strains and zero normal stress. The UI enforces orientation restrictions before calling `elastic`. This is a prescribed model, not a relaxation value or Poisson ratio inferred from CIFs or a single matching reflection.

## Accessibility and verification scope

**RSM-08.** The optional geometry mask applies only to **xz at qy = 0**, with incident and outgoing beams above a flat reference surface. For k = 1/λ and incidence/exit angles αi, αf:

```text
qx = k(cos αf − cos αi)
qz = k(sin αf + sin αi)
θ = asin(λ hypot(qx,qz)/2),  φ = atan2(qx,qz)
αi = θ + φ,  αf = θ − φ
```

The mask checks the elastic-scattering limit, the surface horizon and selected maximum 2θ. Wavelength changes these limits and angles while leaving reciprocal lattice positions fixed. This derivation agrees with the outer circle and horizon circles in [xrayutilities' reciprocal-plane visualization](https://xrayutilities.sourceforge.io/_modules/xrayutilities/materials/plot.html). It does not model refraction, footprint or instrument collisions. The xy image is a fixed-qz reciprocal-space cut; no grazing-incidence accessibility calculation is applied. A nonzero-qy xz cut requires the mask to be disabled.

**RSM-09.** Verification uses analytical and synthetic references: generic reciprocal duality, cubic/tetragonal positions, BCC/FCC extinctions, occupancy and B attenuation, angular round trips, covariance directions, conditional slices, slab zeros, domain sums, equivalent supercells and raster-integral conservation. See [core tests](../scripts/test_rsm_core.cjs), [CIF tests](../scripts/test_rsm_cif.cjs), and the [factor generator's reproducibility check](../scripts/generate_rsm_factors.py). This is not validation against measured RSM data or a fitted instrument response.

Enumeration is limited by both the chosen Miller-index cube and q range; it does not promise every reflection in the q sphere. The warning uses the farthest view corner (including the slice offset) as its radial reach. When the coplanar xz mask is active, this reach is capped at the detector limit `2 sin(2θmax/2)/λ` from RSM-08. If that reach exceeds qmax, a warning reports both limits and explains that reflection centers beyond qmax are omitted. The full view reach applies when the mask is off and for all xy cuts. This is still a conservative upper bound: it does not solve the horizon/view intersection or guarantee that an omitted reciprocal-lattice point exists. It never increases qmax automatically and concerns reflection centers, not completeness of Gaussian tails entering from outside the enumeration sphere or masked region. Display-threshold hiding is distinct from numerical zero intensity. Explicit work caps bound calculation cost. Dynamical diffraction, absorption, anomalous scattering, Kα₂, defect/disorder models and measured-data fitting are outside this implementation.
