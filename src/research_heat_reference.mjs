import fs from 'node:fs/promises';
const input=JSON.parse(await fs.readFile(new URL('../config/default_25mm.json',import.meta.url),'utf8'));
// CI Pamphlet 89, edition 3 (2006), section 2.5, printed pages 5–6.
// Compare published heat magnitudes, not a measured system response.
const conversion=2.326; // Btu_IT/lb to kJ/kg, rounded consistently with project inputs.
const rows=[
  {phase:'气态氯',referenceBtuLb:626,modelKJkg:input.absorption.thermal.gasNetHeatKJkg},
  {phase:'液氯',referenceBtuLb:526,modelKJkg:input.absorption.thermal.dropletNetHeatKJkg}
].map(x=>({...x,referenceKJkg:x.referenceBtuLb*conversion,
  differencePct:100*(x.modelKJkg/(x.referenceBtuLb*conversion)-1)}));
const source='https://files.dep.state.pa.us/water/bpnpsm/WastewaterOperations_Assistance/WastewaterOperatorResources/CourseMaterials/RespCWProf_7122/Resources/Chlorine/Pamphlet89Ed3-Aug06.pdf';
let md='# 反应热参考值对照\n\n';
md+=`依据：[Chlorine Institute Pamphlet 89，第3版（2006）](${source})，§2.5，印刷页5–6。采用放热量的正值大小，与配置文件中的热量系数对比；换算采用1 Btu/lb ≈ 2.326 kJ/kg。\n\n`;
md+='|相态|指南 Btu/lb|换算 kJ/kg|现有模型 kJ/kg|模型相对指南 %|\n|---|---:|---:|---:|---:|\n';
for(const x of rows) md+=`|${x.phase}|${x.referenceBtuLb}|${x.referenceKJkg.toFixed(3)}|${x.modelKJkg.toFixed(3)}|${x.differencePct.toFixed(3)}|\n`;
md+='\n指南给出25℃气态氯反应热，并对直接投入液氯作汽化热修正。两套参考取值量级接近，但参考状态与近似方式需分别保留，不能为消除差异而直接更改模型参数。\n\n';
md+='这是外部文献参考值的一致性对照，不是独立实验验证。两个来源也可能使用共同的热化学基础数据，不能视为两组独立试验。该对照不能证明混合气液入口的实际净热负荷、吸收效率、厂房排风曲线或冷却器性能。\n\n';
md+='在固定各相质量负荷且仅替换热量系数时，峰值热负荷也会受系数差异影响；不能据这些差异消除液滴行为、温度参考状态及其他热效应的不确定性。该比较不修改默认配置。\n\n复现：`node src/research_heat_reference.mjs`。\n';
await fs.writeFile(new URL('../outputs/research/反应热参考值对照.md',import.meta.url),md);
console.log(JSON.stringify(rows,null,2));
