// 运行领域自检: 先编译再执行
//   npx tsc --outDir .selftest-dist --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck src/domain/types.ts src/domain/chain.ts src/domain/store.ts src/domain/seed.ts src/domain/selftest.ts
//   node scripts/run-selftest.mjs
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { runSelfTest } = require("../.selftest-dist/selftest.js");

const results = runSelfTest();
let failed = 0;
for (const r of results) {
  const mark = r.pass ? "PASS" : "FAIL";
  if (!r.pass) failed += 1;
  console.log(`[${mark}] ${r.name}\n       ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
