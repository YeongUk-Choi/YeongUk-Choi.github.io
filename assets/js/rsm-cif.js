/* Strict CIF1 input for RSM Studio. No network, DOM, space-group guessing, or
   evaluated code. Coordinates and Biso are fractional and Å² respectively. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RsmCif = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LIMITS = Object.freeze({ bytes: 512 * 1024, sites: 512, symops: 192, expandedAtoms: 4096 });
  const PERIODIC_TOLERANCE = 1e-6;
  const SYMBOLS = new Set(("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og").split(" "));
  const SYM_TAGS = ["_space_group_symop_operation_xyz", "_symmetry_equiv_pos_as_xyz"];
  const missing = value => value == null || value === "." || value === "?";
  const wrap = value => { const v = value - Math.floor(value); return v < 1e-10 || 1 - v < 1e-10 ? 0 : v; };
  const nearPeriodic = (a, b, tolerance) => Math.abs(a - b - Math.round(a - b)) < tolerance;
  const fail = message => { throw new Error("CIF: " + message); };
  const notice = (warnings, message) => { if (!warnings.includes(message)) warnings.push(message); };

  function numeric(value, field) {
    // Retain the central value; accept the uncertainty before or after an
    // exponent, but never silently accept two uncertainties or trailing text.
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:(?:\(\d+\))([eE][+-]?\d+)?|([eE][+-]?\d+)(?:\(\d+\))?)?$/.exec(String(value));
    const result = match ? Number(match[1] + (match[2] || match[3] || "")) : NaN;
    if (!Number.isFinite(result)) fail(field + " must be a finite number; received " + JSON.stringify(value));
    return result;
  }

  function tokenize(input) {
    if (typeof input !== "string") fail("input must be text");
    const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(input).length : unescape(encodeURIComponent(input)).length;
    if (bytes > LIMITS.bytes) fail("file exceeds the 512 KiB limit");
    const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (/^#\\#CIF_2\.0(?:\s|$)/i.test(text)) fail("CIF2 is not supported; export a conventional CIF1 structure");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) fail("unsupported control character");
    const tokens = [];
    let i = 0, line = 1;
    while (i < text.length) {
      if (/\s/.test(text[i])) { if (text[i] === "\n") line++; i++; continue; }
      if (text[i] === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
      const startLine = line;
      if (text[i] === ";" && (i === 0 || text[i - 1] === "\n")) {
        const start = ++i;
        let end = -1;
        while (i < text.length) {
          if (text[i] === ";" && text[i - 1] === "\n") { end = i; break; }
          if (text[i] === "\n") line++;
          i++;
        }
        if (end < 0) fail("unterminated semicolon text at line " + startLine);
        const value = text.slice(start, end).replace(/\n$/, "");
        i++;
        if (i < text.length && !/\s/.test(text[i]) && text[i] !== "#") fail("text-field delimiter must end its token at line " + line);
        tokens.push({ value, quoted: true, line: startLine });
      } else if (text[i] === "'" || text[i] === '"') {
        const quote = text[i++], start = i;
        while (i < text.length && !(text[i] === quote && (i + 1 === text.length || /\s/.test(text[i + 1])))) {
          if (text[i] === "\n") fail("unterminated quoted value at line " + startLine);
          i++;
        }
        if (i === text.length) fail("unterminated quoted value at line " + startLine);
        tokens.push({ value: text.slice(start, i++), quoted: true, line: startLine });
      } else {
        const start = i;
        while (i < text.length && !/\s/.test(text[i])) i++;
        const value = text.slice(start, i);
        if (/^[\[\]{}]/.test(value)) fail("CIF2 lists/tables are not supported at line " + startLine);
        tokens.push({ value, quoted: false, line: startLine });
      }
    }
    return tokens;
  }

  const tagToken = token => token && !token.quoted && token.value.startsWith("_");
  const reserved = token => token && !token.quoted && (/^(?:data_|save_)/i.test(token.value) || /^(?:loop_|stop_|global_)$/i.test(token.value) || tagToken(token));

  function documentBlocks(text) {
    const tokens = tokenize(text), output = [];
    let i = 0, block = null;
    const seenBlocks = new Set();
    function register(name) {
      name = name.toLowerCase();
      if (block.fields.has(name)) fail("duplicate field " + name + " in data_" + block.name);
      block.fields.add(name);
      return name;
    }
    while (i < tokens.length) {
      const token = tokens[i++], lower = token.value.toLowerCase();
      if (!token.quoted && lower.startsWith("data_")) {
        const name = token.value.slice(5);
        if (!name) fail("data block has no name at line " + token.line);
        if (seenBlocks.has(name.toLowerCase())) fail("duplicate data block " + name);
        seenBlocks.add(name.toLowerCase());
        block = { name, tags: Object.create(null), loops: [], fields: new Set() };
        output.push(block);
      } else if (!block) fail("expected data_ block at line " + token.line);
      else if (!token.quoted && lower === "loop_") {
        const names = [];
        while (tagToken(tokens[i])) names.push(register(tokens[i++].value));
        if (!names.length) fail("loop has no fields at line " + token.line);
        const values = [];
        while (i < tokens.length && !reserved(tokens[i])) values.push(tokens[i++].value);
        if (!values.length || values.length % names.length) fail("incomplete loop row at line " + token.line + ": " + values.length + " values for " + names.length + " fields");
        const rows = [];
        for (let k = 0; k < values.length; k += names.length) rows.push(values.slice(k, k + names.length));
        block.loops.push({ names, rows });
      } else if (tagToken(token)) {
        const name = register(token.value);
        if (i === tokens.length || reserved(tokens[i])) fail("missing value for " + name + " at line " + token.line);
        block.tags[name] = tokens[i++].value;
      } else fail("unexpected token " + JSON.stringify(token.value) + " at line " + token.line + "; save frames/global blocks are unsupported");
    }
    if (!output.length) fail("no data blocks found");
    return output;
  }

  function blocks(text) { return documentBlocks(text).map(block => block.name); }

  function det(matrix) {
    const [a, b, c] = matrix;
    return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  const multiply = (a, b) => a.map(row => b[0].map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)));
  const isIdentity = matrix => matrix.every((row, i) => row.every((value, j) => value === (i === j ? 1 : 0)));

  function symmetryOperation(value) {
    const source = String(value).toLowerCase().replace(/\s+/g, "");
    if (source.length > 256) fail("symmetry operation is too long");
    const parts = source.split(",");
    if (parts.length !== 3) fail("symmetry operation must have three coordinates: " + value);
    const matrix = [], shift = [];
    for (const part of parts) {
      if (!part || /[+-]$|[+-]{2}/.test(part)) fail("malformed symmetry expression: " + value);
      const terms = part.match(/[+-]?[^+-]+/g) || [];
      if (terms.join("") !== part) fail("malformed symmetry expression: " + value);
      const row = [0, 0, 0];
      let offset = 0;
      for (const term of terms) {
        const match = /^([+-]?)(?:(\d+(?:\.\d*)?|\.\d+)(?:\/(\d+(?:\.\d*)?|\.\d+))?)?(\*?[xyz])?$/.exec(term);
        if (!match || (!match[2] && !match[4]) || (match[4] && match[4][0] === "*" && !match[2])) fail("unsupported symmetry term " + JSON.stringify(term));
        const denominator = match[3] ? Number(match[3]) : 1;
        if (!denominator) fail("division by zero in symmetry operation");
        const coefficient = (match[1] === "-" ? -1 : 1) * (match[2] ? Number(match[2]) : 1) / denominator;
        if (!Number.isFinite(coefficient) || Math.abs(coefficient) > 1e6) fail("invalid symmetry coefficient");
        if (match[4]) row["xyz".indexOf(match[4].slice(-1))] += coefficient;
        else offset += coefficient;
      }
      if (!row.every(Number.isInteger)) fail("symmetry rotation must have integer lattice coefficients");
      matrix.push(row); shift.push(wrap(offset));
    }
    if (Math.abs(det(matrix)) !== 1) fail("symmetry rotation determinant must be +1 or -1: " + value);
    let power = matrix, finite = isIdentity(power);
    for (let order = 2; order <= 6 && !finite; order++) { power = multiply(power, matrix); finite = isIdentity(power); }
    if (!finite) fail("symmetry rotation is not finite crystallographic symmetry: " + value);
    return { matrix, shift };
  }

  function validateGroup(operations) {
    const byMatrix = new Map();
    for (const op of operations) {
      const key = op.matrix.flat().join(",");
      if (!byMatrix.has(key)) byMatrix.set(key, []);
      byMatrix.get(key).push(op.shift);
    }
    const contains = (matrix, shift) => (byMatrix.get(matrix.flat().join(",")) || []).some(other => other.every((value, i) => nearPeriodic(value, shift[i], PERIODIC_TOLERANCE)));
    if (!operations.some(op => isIdentity(op.matrix) && op.shift.every(value => nearPeriodic(value, 0, PERIODIC_TOLERANCE)))) fail("explicit symmetry list must contain the identity operation x,y,z");
    for (const left of operations) for (const right of operations) {
      const matrix = multiply(left.matrix, right.matrix);
      const shift = left.matrix.map((row, i) => left.shift[i] + row.reduce((sum, value, j) => sum + value * right.shift[j], 0));
      if (!contains(matrix, shift)) fail("explicit symmetry list is incomplete (operations are not closed under composition)");
    }
  }

  function elementOf(value, fromLabel, warnings) {
    const text = String(value || "").trim();
    let candidate;
    if (fromLabel) {
      const letters = /^[A-Za-z]+/.exec(text);
      if (!letters) fail("cannot infer an element from atom label " + JSON.stringify(value));
      const prefix = letters[0];
      const two = prefix[0].toUpperCase() + (prefix[1] || "").toLowerCase();
      candidate = prefix.length >= 2 && SYMBOLS.has(two) ? two : prefix[0].toUpperCase();
    } else {
      const match = /^([A-Za-z]{1,2})(?:\d+[+-]|[+-]\d*|\d+)?$/.exec(text);
      if (!match) fail("unsupported atom type symbol " + JSON.stringify(value));
      candidate = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
    }
    if (candidate === "D" || candidate === "T") {
      notice(warnings, "D/T isotopes use the X-ray scattering factor of H.");
      return "H";
    }
    if (!SYMBOLS.has(candidate)) fail("unknown element " + JSON.stringify(value));
    return candidate;
  }

  function parse(text, blockName) {
    const parsed = documentBlocks(text);
    if (blockName == null && parsed.length > 1) fail("multiple data blocks; select a block explicitly with parse(text, blockName)");
    const requested = String(blockName).toLowerCase();
    const block = blockName == null ? parsed[0] : parsed.find(item => item.name.toLowerCase() === requested) || parsed.find(item => item.name.toLowerCase() === requested.replace(/^data_/, ""));
    if (!block) fail("data block not found: " + blockName);
    const tags = block.tags, warnings = [];
    for (const field of block.fields) {
      if (/(?:^_space_group_ssg|^_space_group_symop_ssg|^_cell_wave_vector|^_atom_site_.*(?:fourier|modulation|crenel))/i.test(field)) fail("modulated/superspace structures are not supported: " + field);
    }
    if (!missing(tags._cell_modulation_dimension) && numeric(tags._cell_modulation_dimension, "_cell_modulation_dimension") !== 0) fail("modulated structures are not supported");
    const cell = {};
    for (const axis of ["a", "b", "c"]) {
      cell[axis] = numeric(tags["_cell_length_" + axis], "_cell_length_" + axis);
      if (cell[axis] <= 0) fail("cell lengths must be positive");
    }
    for (const angle of ["alpha", "beta", "gamma"]) {
      cell[angle] = numeric(tags["_cell_angle_" + angle], "_cell_angle_" + angle);
      if (!(cell[angle] > 0 && cell[angle] < 180)) fail("cell angles must lie strictly between 0 and 180 degrees");
    }
    const [ca, cb, cg] = [cell.alpha, cell.beta, cell.gamma].map(value => Math.cos(value * Math.PI / 180));
    const determinant = 1 + 2 * ca * cb * cg - ca * ca - cb * cb - cg * cg;
    const volume = cell.a * cell.b * cell.c * Math.sqrt(determinant);
    if (!(determinant > 1e-12) || !Number.isFinite(volume) || !(volume > 0)) fail("cell metric is singular, impossible, or numerically unstable");

    const valueOf = names => names.map(name => tags[name]).find(value => !missing(value));
    const spaceGroup = valueOf(["_space_group_name_h-m_alt", "_symmetry_space_group_name_h-m"]) || "";
    const hallSymbol = valueOf(["_space_group_name_hall", "_symmetry_space_group_name_hall"]) || "";
    const groupNumberText = valueOf(["_space_group_it_number", "_symmetry_int_tables_number"]);
    const spaceGroupNumber = missing(groupNumberText) ? null : numeric(groupNumberText, "space group number");
    if (spaceGroupNumber != null && (!Number.isInteger(spaceGroupNumber) || spaceGroupNumber < 1 || spaceGroupNumber > 230)) fail("space group number must be an integer from 1 to 230");
    const symbolIsP1 = /^p(?:\s*1){1,3}$/i.test(spaceGroup.trim());
    const hallIsP1 = /^p\s*1$/i.test(hallSymbol.trim());
    const declaresP1 = symbolIsP1 || hallIsP1 || spaceGroupNumber === 1;
    const declaresNonP1 = spaceGroup && !symbolIsP1 || hallSymbol && !hallIsP1 || spaceGroupNumber != null && spaceGroupNumber !== 1;
    if (declaresP1 && declaresNonP1) fail("conflicting P1 space-group name and number");
    const symSources = [];
    for (const name of SYM_TAGS) {
      if (tags[name] != null) symSources.push([tags[name]]);
      for (const loop of block.loops) {
        const index = loop.names.indexOf(name);
        if (index >= 0) symSources.push(loop.rows.map(row => row[index]));
      }
    }
    if (symSources.length > 1) fail("multiple symmetry-operation lists are ambiguous; keep one explicit list");
    let symops = symSources[0] || [];
    if (!symops.length) {
      if (!declaresP1) fail("explicit symmetry operations are required unless the CIF unambiguously declares P1");
      symops = ["x,y,z"];
      notice(warnings, "P1 has no explicit symmetry list; the identity operation x,y,z was supplied.");
    }
    if (symops.length > LIMITS.symops) fail("more than 192 symmetry operations");
    const operations = symops.map(symmetryOperation);
    validateGroup(operations);
    const onlyIdentity = operations.every(op => isIdentity(op.matrix) && op.shift.every(value => nearPeriodic(value, 0, PERIODIC_TOLERANCE)));
    if (declaresP1 && !onlyIdentity) fail("P1 declaration conflicts with non-identity symmetry operations");
    if (declaresNonP1 && onlyIdentity) fail("non-P1 declaration conflicts with an identity-only symmetry list");
    if (!spaceGroup && !hallSymbol && spaceGroupNumber == null) notice(warnings, "No space-group label is supplied; the explicit symmetry operations define the structure.");

    const atomLoops = block.loops.filter(loop => loop.names.some(name => /^_atom_site_(?!aniso_)/.test(name)));
    const scalarAtomTags = Object.keys(tags).filter(name => /^_atom_site_(?!aniso_)/.test(name));
    if (scalarAtomTags.length) atomLoops.push({ names: scalarAtomTags, rows: [scalarAtomTags.map(name => tags[name])] });
    if (!atomLoops.length) fail("no fractional atom sites were found");
    const atoms = [];
    for (const loop of atomLoops) {
      for (const coord of ["x", "y", "z"]) if (!loop.names.includes("_atom_site_fract_" + coord)) fail("atom-site table is missing _atom_site_fract_" + coord + "; Cartesian-only or split site tables are unsupported");
      if (!loop.names.includes("_atom_site_label") && !loop.names.includes("_atom_site_type_symbol")) fail("atom sites need labels or type symbols");
      for (const row of loop.rows) {
        if (atoms.length >= LIMITS.sites) fail("more than 512 asymmetric atom sites");
        const get = name => { const index = loop.names.indexOf(name); return index < 0 ? undefined : row[index]; };
        const type = get("_atom_site_type_symbol"), labelValue = get("_atom_site_label");
        const label = missing(labelValue) ? (missing(type) ? "" : type) + (atoms.length + 1) : labelValue;
        if (missing(type) && missing(labelValue)) fail("atom site has neither a usable label nor type symbol");
        if (missing(type)) notice(warnings, "Some elements were inferred from atom labels because type symbols are absent.");
        if (/^(?:dum|dummy)$/i.test(get("_atom_site_calc_flag") || "")) fail("dummy atom site " + label + " cannot be used for scattering");
        const atom = { label, element: elementOf(missing(type) ? label : type, missing(type), warnings) };
        for (const coord of ["x", "y", "z"]) {
          atom[coord] = numeric(get("_atom_site_fract_" + coord), label + ": _atom_site_fract_" + coord);
          if (Math.abs(atom[coord]) > 1e6) fail(label + ": fractional coordinate is too large for reliable periodic reduction");
        }
        const occupancy = get("_atom_site_occupancy");
        atom.occupancy = occupancy == null ? 1 : numeric(occupancy, label + ": occupancy");
        if (atom.occupancy < 0 || atom.occupancy > 1) fail(label + ": occupancy must be between 0 and 1");
        if (occupancy == null) notice(warnings, "Missing site occupancies default to 1.");
        const bValue = get("_atom_site_b_iso_or_equiv"), uValue = get("_atom_site_u_iso_or_equiv");
        const b = missing(bValue) ? null : numeric(bValue, label + ": Biso");
        const u = missing(uValue) ? null : numeric(uValue, label + ": Uiso");
        if (b != null && b < 0 || u != null && u < 0) fail(label + ": displacement parameters must be nonnegative");
        if (b != null && u != null && Math.abs(b - 8 * Math.PI * Math.PI * u) > Math.max(0.01, 0.02 * b)) fail(label + ": Biso and Uiso values are inconsistent");
        atom.biso = b != null ? b : u != null ? 8 * Math.PI * Math.PI * u : 0;
        if (b == null && u == null) notice(warnings, "Missing isotropic displacement parameters use Biso = 0; thermal attenuation is omitted for those sites.");
        const adpType = get("_atom_site_adp_type") || get("_atom_site_thermal_displace_type") || "";
        if (/ani/i.test(adpType) && b == null && u == null) notice(warnings, "Anisotropic-only displacement parameters are unsupported; their attenuation is omitted (Biso = 0).");
        const disorder = get("_atom_site_disorder_group");
        if (!missing(disorder) && disorder !== "0") notice(warnings, "Disordered sites use the occupancy-averaged structure; diffuse scattering is not modeled.");
        atoms.push(atom);
      }
    }
    if ([...block.fields].some(name => /^_atom_site_aniso_/.test(name))) {
      notice(warnings, "Anisotropic displacement tensors are not used; available equivalent isotropic B/U values are used instead.");
      if (atoms.some(atom => atom.biso === 0)) notice(warnings, "Anisotropic-only displacement parameters may be present; sites without an isotropic equivalent use Biso = 0.");
    }
    const expandedAtoms = [];
    for (const atom of atoms) {
      const positions = [], coordinate = [atom.x, atom.y, atom.z];
      for (const op of operations) {
        const point = op.matrix.map((row, i) => wrap(op.shift[i] + row.reduce((sum, value, j) => sum + value * coordinate[j], 0)));
        // Deduplicate only symmetry images of this source site. Independent
        // co-occupying sites, even with the same element, remain independent.
        if (positions.some(other => other.every((value, i) => nearPeriodic(value, point[i], PERIODIC_TOLERANCE)))) continue;
        positions.push(point);
        if (expandedAtoms.length >= LIMITS.expandedAtoms) fail("symmetry expansion exceeds 4096 atoms");
        expandedAtoms.push({ ...atom, x: point[0], y: point[1], z: point[2] });
      }
    }
    return { cell, atoms, symops: symops.slice(), expandedAtoms, formula: valueOf(["_chemical_formula_sum", "_chemical_formula_structural"]) || "", spaceGroup, spaceGroupNumber, blockName: block.name, warnings };
  }

  return Object.freeze({ parse, blocks, limits: LIMITS });
});
