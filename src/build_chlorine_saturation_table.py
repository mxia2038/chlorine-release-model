"""Generate the saturated-chlorine property table used by the closed-tank option.

Requires CoolProp 8.0.0 (not needed to run the model). Output:
config/chlorine_saturation_table.json (run: python src/build_chlorine_saturation_table.py)
"""
import json
import pathlib

import CoolProp
from CoolProp.CoolProp import PropsSI

FLUID = "HEOS::Chlorine"
T_MIN_C, T_MAX_C, STEP_C = -40.0, 10.0, 0.05

rows = []
n = round((T_MAX_C - T_MIN_C) / STEP_C)
for i in range(n + 1):
    t_c = round(T_MIN_C + i * STEP_C, 6)
    t_k = t_c + 273.15
    rows.append([
        t_c,
        PropsSI("P", "T", t_k, "Q", 0, FLUID),
        PropsSI("D", "T", t_k, "Q", 0, FLUID),
        PropsSI("D", "T", t_k, "Q", 1, FLUID),
        PropsSI("U", "T", t_k, "Q", 0, FLUID),
        PropsSI("U", "T", t_k, "Q", 1, FLUID),
        PropsSI("H", "T", t_k, "Q", 0, FLUID),
    ])

out = {
    "source": "Thol et al. (2021), AIChE Journal 67:e17326, DOI 10.1002/aic.17326; "
              f"evaluated with CoolProp {CoolProp.__version__} {FLUID}",
    "state": "saturation (Q=0 liquid, Q=1 vapor); energies relative to CoolProp default reference state",
    "columns": ["tempC", "pressurePa", "liquidDensityKgM3", "vaporDensityKgM3",
                "liquidInternalEnergyJkg", "vaporInternalEnergyJkg", "liquidEnthalpyJkg"],
    "tempStepC": STEP_C,
    "rows": rows,
}
path = pathlib.Path(__file__).resolve().parents[1] / "config" / "chlorine_saturation_table.json"
path.write_text(json.dumps(out, separators=(",", ":")))
print(path, len(rows))
print("Tsat(301325 Pa) =", PropsSI("T", "P", 301325, "Q", 0, FLUID) - 273.15, "C")
print("rho_l(301325 Pa) =", PropsSI("D", "P", 301325, "Q", 0, FLUID))
