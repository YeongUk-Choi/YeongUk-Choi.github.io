// Synthetic educational pair. These are not a measured specimen or COD records.
(function (root) {
  const make = (name, a) => `data_${name}
_chemical_formula_sum 'Sr Ti O3'
_space_group_name_H-M_alt 'P 1'
_space_group_IT_number 1
_cell_length_a ${a}
_cell_length_b ${a}
_cell_length_c ${a}
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
loop_
_space_group_symop_operation_xyz
'x,y,z'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
_atom_site_B_iso_or_equiv
Sr1 Sr 0 0 0 1 0.4
Ti1 Ti 0.5 0.5 0.5 1 0.4
O1 O 0.5 0.5 0 1 0.4
O2 O 0.5 0 0.5 1 0.4
O3 O 0 0.5 0.5 1 0.4
`;
  const examples = { substrate: make('STO_example',3.905), film: make('hypothetical_film',3.95) };
  if (typeof module === 'object' && module.exports) module.exports = examples;
  else root.RsmExamples = examples;
})(typeof self !== 'undefined' ? self : this);
