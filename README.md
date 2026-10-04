# hxwl-06 病理会诊链

借片—标注—签发 一体化会诊链: 把借片单据、玻片染色版本、视野标注、会诊签发串成一条可续作的链, 避免玻片归还后旧意见被当成新结论。

## 技术栈

React + Vite + TypeScript + CSS

## 本地运行

```bash
npm install
npm run dev
```

开发端口: 5106

## 会诊链规则(领域层 `src/domain/`)

1. **借出冻结** — 办理借出时把玻片版本与染色批次冻结进借片单, 之后重染/重切不影响本次借出依据 (`planLendSlide`)
2. **外院权限** — 外院账号只能补充标注, 修改借片单/改动本院标注/签发一律 `PERMISSION_DENIED` (`planExternalChange`)
3. **离线合并** — 专家离线标注回连后按视野坐标归组; 同一视野结论不同保留多版并标记冲突 (`mergeFieldConclusions`)
4. **失效重算** — 玻片归还 / 染色批次变更 / 原始玻片损坏后, 未签发结论立即失效并基于当前标注重算新草稿; 已签发意见保留签发快照, 仅标记基底变化 (`planSlideEvent`)
5. **并发签发** — 签发按会诊乐观锁版本做 CAS, 两名专家同时提交只允许一份生效, 另一份冲突作废 (`planSignOpinion` + `commit`)
6. **失败恢复** — 所有写入以完整会诊批次为单位提交; 写失败整体回滚后用同一批次重试, 批次号幂等 (`store.commit`)
7. **版本回填** — 旧会诊缺玻片版本时, 按借片日期找到覆盖该区间的借片单, 回填其冻结版本与批次 (`backfillSlideVersion`)

## 自检

```bash
npx tsc --outDir .selftest-dist --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict src/domain/types.ts src/domain/chain.ts src/domain/store.ts src/domain/seed.ts src/domain/selftest.ts
node scripts/run-selftest.mjs
```

10 项规则全部通过; 页面内「领域自检」按钮可就地重跑。
