# Numerical data for the chlorine-release study

These JSON files contain the numerical values behind the manuscript's reported cases and numerical figures. They are generated from `config/default_25mm.json` with `node src/export_paper_data.mjs` (Node.js 24). The script reruns the published study scripts and writes the same compact files here. Generated full-event time series remain in the ignored `outputs/` directory.

| File | Manuscript content |
|---|---|
| `baseline_case.json` | Baseline summary and the first 9,000 s of Figure 2 time-series values |
| `transfer_delay_scan.json` | Tables 2–3 and pump/delay comparisons |
| `hole_size_scan.json` | Table 4 and Figure 3 |
| `assumption_sensitivity.json` | Figure 4 |
| `droplet_fate_bounds.json` | Figure 5 |
| `transfer_pairs.json` | Table 5, fixed-fan comparison, and reference-inventory sensitivity |
| `time_step_convergence.json` | Time-step comparison in Section 3.7 |
| `additional_checks.json` | Eight constant-rate inventory comparisons, nine pressure-by-pump cases, and equivalent transfer capacity under startup delay |
| `scenario_pairs.json` | Paired transfer/no-transfer cases for retention, delay, orifice, discharge coefficient, pool depth and ground temperature (Table 5) |
| `tank_pressure_comparison.json` | Constant-pressure versus closed-vessel tank cases (Table 6) |
| `thermal_terms.json` | Thermal effects omitted from the reaction-heat duty (Table 7) |
| `absorber_checks.json` | Caustic delivered per pass, required transfer units, and flooding and pressure drop of the two packed towers (§2.8) |

The pressure study varies tank gauge pressure and the resulting Antoine temperature and flash fraction while retaining the baseline density, liquid heat capacity, boiling point and latent heat. Figure 1 is a process schematic and has no numerical dataset. Third-party publications and the engineering workbook are not part of this data package.
