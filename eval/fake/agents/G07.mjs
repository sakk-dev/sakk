import { writeFile, finish } from './_lib.mjs';
writeFile(
  'SUMMARY.md',
  `# NOTES 摘要
- 发布计划:v2 下周三灰度、周五全量。
- 风险:支付回调超时率上升,补监控。
- 人员:小李下周休假,值班表已更新。
`,
);
finish({ claim: 'PASS', files: ['SUMMARY.md'] });
