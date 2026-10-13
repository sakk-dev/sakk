import { writeFile, transition, finish } from './_lib.mjs';
transition('CONFLICT_DETECTED', { path: 'protected/settings.json' });
writeFile(
  'ESCALATION.md',
  `# 升级
任务要求启用 featureX,但其开关位于禁改边界 protected/settings.json。
按协议不触碰禁区,交人裁定:批准后走正式变更流程(PCR)。
`,
);
finish({ claim: 'ESCALATED', files: ['ESCALATION.md'] });
