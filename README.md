# Chlorine-release mitigation model

Computational model for liquid-chlorine leakage with concurrent inventory transfer, building ventilation and two-stage caustic scrubbing.

## Environment

The JavaScript calculations and SVG plotting scripts use only Node.js built-in modules; no npm dependencies are needed. Node.js 24 is used in CI.

The chlorine property values are stored in `config/default_25mm.json`, together with their state basis and source. Running the model does not require CoolProp: the stored properties were evaluated separately using CoolProp 8.0.0 and the Thol et al. chlorine equation of state.

## Run the model

```sh
npm test
node src/calc.mjs config/default_25mm.json
node src/design_basis.mjs config/default_25mm.json
```

The calculation writes release and ventilation time series to `outputs/data/`, and the design-basis step writes the downstream design quantities. The optional `python run_model.py` wrapper runs both steps and requires Python 3 and Node.js on PATH. Result files are generated locally and are not distributed with this repository.

## Study scripts

| Study | Script |
|---|---|
| Pump-capacity and response-time scan | `src/research_scan.mjs` |
| Orifice-size scan | `src/research_hole_scan.mjs` |
| Single-factor assumption sensitivity | `src/research_assumption_sensitivity.mjs` |
| Droplet-fate sensitivity | `src/research_droplet_bounds.mjs` |
| Time-step convergence | `src/research_convergence.mjs` |
| Reaction-heat comparison | `src/research_heat_reference.mjs` |
| External ventilation comparison | `src/research_ventilation_validation.mjs` |

Each script writes its results to `outputs/research/`. The published external measurements used in the ventilation comparison are transcribed in the script with their source; the original experimental dataset was not collected by this project.

## Plotting

```sh
node src/plot_baseline_dynamics.mjs
node src/plot_hole_scan.mjs
node src/plot_assumption_sensitivity.mjs
node src/plot_droplet_bounds.mjs
```

The plotting scripts read the JSON results produced by the calculation and study scripts, so run those first. They create SVG files directly.

## Model notes

Each scenario is independently resized. Main capture is a specified fraction, and the tail outlet concentration is a design target. No packed-column performance validation is claimed. The baseline retains suspended droplets, fixed tank pressure and perfectly mixed room transport. The model retains the historical pool heat-transfer area and uses step-mean and step-end conventions.

The tests verify implementation behavior, not physical model validity.

## Sources and license

The source-term equations follow GB/T 37243-2019, informative Annex D. Obtain the standard separately; third-party publications are not distributed here. See `LICENSE` for the project license.
