import fs from "node:fs/promises";
import path from "node:path";

// Independent mechanical-ventilation washout data from Lambert et al. (2010),
// Annals of Occupational Hygiene 54(1), 88-99, Table 1.
// Kexp = tau_exp / tau_CMSTR; the present perfect-mixing model has Kmodel = 1.
const cases = [
  {ach:19, location:1, tauExpMin:4.119, kExp:1.307},
  {ach:19, location:2, tauExpMin:4.004, kExp:1.270},
  {ach:19, location:3, tauExpMin:4.105, kExp:1.302},
  {ach:19, location:4, tauExpMin:4.454, kExp:1.413},
  {ach:34, location:1, tauExpMin:2.225, kExp:1.288},
  {ach:34, location:2, tauExpMin:2.064, kExp:1.195},
  {ach:34, location:3, tauExpMin:2.147, kExp:1.243},
  {ach:34, location:4, tauExpMin:2.237, kExp:1.295}
].map(r => {
  const tauPerfectMixingMin = r.tauExpMin / r.kExp;
  return {...r,
    tauPerfectMixingMin,
    experimentalExcessOverPerfectMixingPct:(r.kExp-1)*100,
    perfectMixingErrorVsExperimentPct:(tauPerfectMixingMin/r.tauExpMin-1)*100,
    t95ExpMin:-Math.log(0.05)*r.tauExpMin,
    t95PerfectMixingMin:-Math.log(0.05)*tauPerfectMixingMin
  };
});

const mean = key => cases.reduce((s,r)=>s+r[key],0)/cases.length;
const min = key => Math.min(...cases.map(r=>r[key]));
const max = key => Math.max(...cases.map(r=>r[key]));

const result = {
  source:{
    citation:"Lambert, A.R., Lin, C.-L., Mardorf, E., O'Shaughnessy, P. (2010). CFD Simulation of Contaminant Decay for High Reynolds Flow in a Controlled Environment. Annals of Occupational Hygiene 54(1), 88-99.",
    doi:"10.1093/annhyg/mep057",
    table:"Table 1",
    experiment:"CO2 washout in a 3.40 m x 3.44 m x 2.29 m mechanically ventilated chamber; four measurement locations; 19 and 34 ACH"
  },
  modelBasis:"Perfectly mixed single-zone decay, C/C0 = exp[-(Q/V)t], equivalent to Kmodel = tau/tau_CMSTR = 1",
  cases,
  summary:{
    kExpMin:min("kExp"),kExpMax:max("kExp"),kExpMean:mean("kExp"),
    experimentalExcessOverPerfectMixingPctMin:min("experimentalExcessOverPerfectMixingPct"),
    experimentalExcessOverPerfectMixingPctMax:max("experimentalExcessOverPerfectMixingPct"),
    experimentalExcessOverPerfectMixingPctMean:mean("experimentalExcessOverPerfectMixingPct"),
    perfectMixingErrorVsExperimentPctMin:min("perfectMixingErrorVsExperimentPct"),
    perfectMixingErrorVsExperimentPctMax:max("perfectMixingErrorVsExperimentPct"),
    perfectMixingErrorVsExperimentPctMean:mean("perfectMixingErrorVsExperimentPct")
  },
  applicability:{
    supported:"The implemented exponential washout is the ideal fully mixed limit and gives the correct functional form and mass-conserving asymptote.",
    observedBias:"The ideal model clears the tracer faster than all eight measurements.",
    limitation:"The experiment used CO2 at 19-34 ACH, whereas the baseline chlorine case is a dense-gas, two-phase release at about 0.63 actual ACH. The benchmark quantifies direction and scale of ideal-mixing bias but is not a direct validation of the full chlorine system or a calibration factor."
  }
};

const outDir=path.resolve("outputs/research");
await fs.mkdir(outDir,{recursive:true});
await fs.writeFile(path.join(outDir,"ventilation_validation.json"),JSON.stringify(result,null,2));

const f=(x,d=2)=>x.toFixed(d);
const rows=cases.map(r=>`| ${r.ach} | ${r.location} | ${f(r.tauExpMin,3)} | ${f(r.kExp,3)} | ${f(r.tauPerfectMixingMin,3)} | ${f(r.experimentalExcessOverPerfectMixingPct,1)} | ${f(r.perfectMixingErrorVsExperimentPct,1)} |`).join("\n");
const md=`# 机械通风全混合子模型的独立实验对照

## 数据来源

Lambert, Lin, Mardorf and O'Shaughnessy (2010), *CFD Simulation of Contaminant Decay for High Reynolds Flow in a Controlled Environment*, *Annals of Occupational Hygiene*, 54(1), 88–99, Table 1, DOI: 10.1093/annhyg/mep057。

试验在3.40 m × 3.44 m × 2.29 m机械通风试验室内进行。CO₂先达到均匀稳态，停止供气后，在19 ACH和34 ACH下由四个测点记录浓度衰减。原文定义 $K_{\mathrm{exp}}=\tau_{\mathrm{exp}}/\tau_{\mathrm{CMSTR}}$。本项目全混合模型对应 $K_{\mathrm{model}}=1$。

## 复算结果

| ACH (h⁻¹) | 测点 | 实测τ (min) | 原文Kexp | 全混合τ (min) | 实测比全混合慢 (%) | 全混合相对实测误差 (%) |
|---:|---:|---:|---:|---:|---:|---:|
${rows}

八组实测 $K_{\mathrm{exp}}$ 为${f(result.summary.kExpMin,3)}–${f(result.summary.kExpMax,3)}，平均${f(result.summary.kExpMean,3)}。实测时间常数比理想全混合值长${f(result.summary.experimentalExcessOverPerfectMixingPctMin,1)}%–${f(result.summary.experimentalExcessOverPerfectMixingPctMax,1)}%，平均${f(result.summary.experimentalExcessOverPerfectMixingPctMean,1)}%；若以实测值为分母，理想全混合模型对时间常数的偏差为${f(result.summary.perfectMixingErrorVsExperimentPctMin,1)}%至${f(result.summary.perfectMixingErrorVsExperimentPctMax,1)}%，平均${f(result.summary.perfectMixingErrorVsExperimentPctMean,1)}%。

## 可支持的结论

1. 本项目采用的指数衰减是机械通风单区模型的理想完全混合极限，函数形式和最终质量清除方向正确。
2. 八个独立测点均显示真实冲洗慢于理想全混合预测，因此当前模型倾向于低估停源后的清除时间。
3. 该偏差不改变完整计算窗口内最终抽出质量，但可能改变峰值到达时间、短时出口负荷和尾段持续时间。

## 适用边界

该试验使用CO₂和19–34 ACH高雷诺数机械通风；本项目基准工况约为0.63次/h实际换气，且含重质氯气和悬浮液滴。因此这是一项与机械排风控制方程直接对应的子模型基准，不是整个液氯泄漏—吸收系统的实验验证，也不能把$K_{\mathrm{exp}}$直接作为本项目修正系数。对实际装置的最终确认仍需要厂房示踪气体试验或边界匹配的重气体机械排风数据。
`;
await fs.writeFile(path.join(outDir,"机械通风子模型实验对照.md"),md);
console.log(JSON.stringify({output:path.join(outDir,"ventilation_validation.json"),summary:result.summary},null,2));
