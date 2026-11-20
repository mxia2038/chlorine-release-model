# Chlorine-release mitigation model

Computational model for liquid-chlorine leakage from a storage tank with concurrent emergency transfer, building ventilation and two-stage caustic scrubbing. It accompanies the manuscript *Effects of emergency transfer from a leaking liquid chlorine tank on ventilation and scrubbing requirements* and contains the model, the study scripts, and the numerical data behind the reported tables and figures.

## Repository layout

| Path | Content |
|---|---|
| `config/default_25mm.json` | Baseline case: tank, chlorine properties, building, ventilation and absorber inputs, with their sources |
| `config/chlorine_saturation_table.json` | Saturated-chlorine property table used by the closed-vessel tank option |
| `src/calc.mjs` | Release and building model: tank inventory, orifice discharge, flash, droplets, pool evaporation, ventilation |
| `src/design_basis.mjs`, `src/tank_thermal.mjs`, `src/outlet_target.mjs` | Scrubbing system: caustic inventory, circulation tanks, tower diameters, cooling duties, outlet target |
| `src/research_*.mjs` | Study scripts for the cases reported in the manuscript |
| `src/plot_*.mjs`, `src/paper_line_figure.mjs` | Figure scripts and their shared drawing helper |
| `src/export_paper_data.mjs` | Reruns the studies and writes the compact dataset in `data/paper/` |
| `data/paper/` | Numerical data behind the manuscript's tables and figures |
| `test/` | Unit tests of the implementation |

## Requirements

Node.js 24 or later. The calculations and the SVG figure scripts use only Node.js built-in modules, so there are no npm dependencies to install.

Running the model does not require CoolProp. The chlorine properties in `config/` were evaluated beforehand with CoolProp 8.0.0 and the Thol et al. equation of state; `src/build_chlorine_saturation_table.py` is needed only to regenerate the saturation table.

## Run the model

```sh
npm test            # unit tests
npm run calc        # node src/calc.mjs config/default_25mm.json
npm run design      # node src/design_basis.mjs config/default_25mm.json
```

`calc` writes the release and ventilation time series to `outputs/data/`, and `design` writes the scrubbing-system quantities derived from them. The optional wrapper `python run_model.py` runs both steps and prints a summary. The `outputs/` directory holds full result files and is not tracked.

## Reproduce the manuscript data

```sh
npm run paper-data  # node src/export_paper_data.mjs
```

This reruns the study scripts and rewrites `data/paper/`. Each study can also be run on its own and writes its full results to `outputs/research/`.

| Manuscript item | Study script | Data file in `data/paper/` |
|---|---|---|
| Baseline case, Figure 2 | `src/export_paper_data.mjs` | `baseline_case.json` |
| Tables 2 and 3: pump capacity and startup delay | `src/research_scan.mjs` | `transfer_delay_scan.json` |
| Table 4, Figure 3: orifice sizes | `src/research_hole_scan.mjs` | `hole_size_scan.json` |
| Figure 4: single-factor sensitivity | `src/research_assumption_sensitivity.mjs` | `assumption_sensitivity.json` |
| Figure 5: droplet fate | `src/research_droplet_bounds.mjs` | `droplet_fate_bounds.json` |
| Table 5: paired transfer and no-transfer cases | `src/research_transfer_pairs.mjs`, `src/research_revision_pairs.mjs` | `transfer_pairs.json`, `scenario_pairs.json` |
| Table 6: constant-pressure and closed-vessel tank | `src/research_tank_pressure.mjs` | `tank_pressure_comparison.json` |
| Table 7: thermal effects omitted from the reaction-heat duty | `src/research_thermal_terms.mjs` | `thermal_terms.json` |
| Section 2.8: caustic per pass, transfer units, flooding and pressure drop | `src/research_absorber_checks.mjs` | `absorber_checks.json` |
| Section 3.7: time-step comparison | `src/research_convergence.mjs` | `time_step_convergence.json` |
| Constant-rate inventory estimate, pressure-by-pump cases, equivalent capacity under delay | `src/export_paper_data.mjs` | `additional_checks.json` |

`data/paper/README.md` describes the content of each file.

## Figures

```sh
node src/plot_baseline_dynamics.mjs       # Figure 2
node src/plot_hole_scan.mjs               # Figure 3
node src/plot_assumption_sensitivity.mjs  # Figure 4
node src/plot_droplet_bounds.mjs          # Figure 5
```

The figure scripts read the JSON results in `outputs/research/` and `outputs/data/`, so run the model and the corresponding study first. They write SVG files to `outputs/research/`. Figure 1 is a process schematic and has no script.

## Model notes

- The source-term relations follow GB/T 37243-2019, informative Annex D, embedded in time-stepped tank and building balances.
- Each scenario is sized independently: fan flow, tower diameters, caustic inventory, tank volumes and cooling duties are recalculated for every case.
- The baseline uses constant tank pressure, suspended droplets and a perfectly mixed building. Setting `tank.pressureModel` to `closedSaturated` replaces constant pressure with a closed saturated-chlorine vessel balance.
- The main-stage capture fraction is a specified design value and the tail outlet concentration is a design target. The absorber checks give the transfer units, caustic supply, flooding load and pressure drop that these values imply; they are not a prediction of packed-column performance.
- The two main circulation tanks are used in sequence. The first is switched at `absorption.process.mainSwitchNaohMassFraction`, and the second tank and the tail tank are used down to `absorption.finalNaohMassFraction`.

The tests verify the implementation (balances, limiting cases and input validation), not the physical validity of the model.

## Sources and license

The standard GB/T 37243-2019 and the third-party publications cited in the manuscript are not distributed here and must be obtained separately. The code and data are released under the MIT License (see `LICENSE`).
