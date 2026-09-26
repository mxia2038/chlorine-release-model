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
| `ventilation_validation.json` | Published chamber measurements transcribed from Lambert et al. (2010) and the Section 3.7 comparison |
| `additional_checks.json` | Six constant-rate inventory comparisons and nine pressure-by-pump cases |

The pressure study varies tank gauge pressure and the resulting Antoine temperature and flash fraction while retaining the baseline density, liquid heat capacity, boiling point and latent heat. Figure 1 is a process schematic and has no numerical dataset. Third-party publications and the engineering workbook are not part of this data package.
