// 领域自检: 覆盖会诊链七条规则, 可用 node 运行(见 scripts/run-selftest.mjs),
// 也可在页面内点击"运行自检"查看。

import {
  backfillSlideVersion,
  mergeFieldConclusions,
  planDraftOpinion,
  planExpertAnnotation,
  planExternalChange,
  planLendSlide,
  planSignOpinion,
  planSlideEvent,
} from "./chain";
import { DEMO, seedLegacyRecords, seedState } from "./seed";
import { CommitResult, commit, createStore, Store } from "./store";
import { ChainEvent, ChainState, ConsultationBatch, Result } from "./types";

export interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

interface Ctx {
  store: Store;
}

const fresh = (): Ctx => ({ store: createStore(seedState()) });

const mustCommit = (ctx: Ctx, planned: Result<ConsultationBatch>): CommitResult => {
  if (!planned.ok) throw new Error(`规划失败: ${planned.error.code} ${planned.error.message}`);
  const res = commit(ctx.store, planned.value);
  if (!res.ok) throw new Error(`提交失败: ${res.note} ${res.conflict ?? ""}`);
  return res;
};

const commitEvent = (ctx: Ctx, event: ChainEvent): CommitResult => {
  const planned = planSlideEvent(state(ctx), event);
  if (!planned.ok) throw new Error(`事件规划失败: ${planned.error.code} ${planned.error.message}`);
  const res = commit(ctx.store, planned.value.batch);
  if (!res.ok) throw new Error(`事件提交失败: ${res.note} ${res.conflict ?? ""}`);
  return res;
};

const state = (ctx: Ctx): ChainState => ctx.store.state;

function lend(ctx: Ctx, at = "2026-10-01T09:00:00") {
  mustCommit(
    ctx,
    planLendSlide(state(ctx), {
      loanId: DEMO.loanId,
      consultationId: DEMO.consultationId,
      slideId: DEMO.slideId,
      borrower: DEMO.borrower,
      at,
    }),
  );
}

export function runSelfTest(): TestResult[] {
  const results: TestResult[] = [];
  const test = (name: string, fn: () => string) => {
    try {
      results.push({ name, pass: true, detail: fn() });
    } catch (e) {
      results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
    }
  };
  const assert: (cond: unknown, msg: string) => asserts cond = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  test("1. 借出时冻结玻片版本与染色批次", () => {
    const ctx = fresh();
    lend(ctx);
    const loan = state(ctx).loans[DEMO.loanId];
    assert(loan.frozenSlideVersion === 3, `冻结版本应为 3, 实际 ${loan.frozenSlideVersion}`);
    assert(loan.frozenStainingBatch === "HE-2609-A", `冻结批次应为 HE-2609-A, 实际 ${loan.frozenStainingBatch}`);
    assert(state(ctx).slides[DEMO.slideId].status === "lent", "玻片应处于借出状态");
    // 借出后本院重染, 冻结值不变
    commitEvent(ctx, { type: "staining_changed", slideId: DEMO.slideId, newBatch: "HE-2610-C", at: "2026-10-02T09:00:00" });
    const loanAfter = state(ctx).loans[DEMO.loanId];
    assert(loanAfter.frozenSlideVersion === 3 && loanAfter.frozenStainingBatch === "HE-2609-A", "重染后借片单冻结值被改动");
    return `冻结 v${loan.frozenSlideVersion}/${loan.frozenStainingBatch}, 重染后仍不变`;
  });

  test("2. 外院越权改动本院记录被拒绝", () => {
    const ctx = fresh();
    lend(ctx);
    const r1 = planExternalChange(state(ctx), { kind: "modify_loan", loanId: DEMO.loanId });
    const r2 = planExternalChange(state(ctx), { kind: "edit_local_annotation", annotationId: "A-1" });
    const r3 = planExternalChange(state(ctx), { kind: "sign_opinion", opinionId: "O-0417-1" });
    for (const [i, r] of [r1, r2, r3].entries()) {
      assert(!r.ok && r.error.code === "PERMISSION_DENIED", `第 ${i + 1} 个越权操作未被拒绝`);
    }
    return "修改借片单 / 改动本院标注 / 签发意见 均被 PERMISSION_DENIED 拒绝";
  });

  test("3. 外院补标注恒落在借出冻结版本上", () => {
    const ctx = fresh();
    lend(ctx);
    mustCommit(ctx, planExternalChange(state(ctx), {
      kind: "add_annotation", id: "A-E1", consultationId: DEMO.consultationId,
      field: DEMO.fieldA, author: DEMO.externalDoctor, text: "可见异型腺体", origin: "online",
    }));
    assert(state(ctx).annotations["A-E1"].slideVersion === 3, "外院标注未落在冻结版本 v3 上");
    // 重染后再标注, 仍然是冻结的 v3
    commitEvent(ctx, { type: "staining_changed", slideId: DEMO.slideId, newBatch: "HE-2610-C", at: "2026-10-02T09:00:00" });
    mustCommit(ctx, planExternalChange(state(ctx), {
      kind: "add_annotation", id: "A-E2", consultationId: DEMO.consultationId,
      field: DEMO.fieldB, author: DEMO.externalDoctor, text: "灶状坏死", origin: "offline",
    }));
    assert(state(ctx).annotations["A-E2"].slideVersion === 3, "重染后外院标注未保持冻结版本 v3");
    return "两条外院标注均绑定冻结 v3, 不受后续重染影响";
  });

  test("4. 离线标注回连按坐标合并, 同视野不同结论保留两版", () => {
    const ctx = fresh();
    lend(ctx);
    mustCommit(ctx, planExpertAnnotation(state(ctx), { id: "A-X1", consultationId: DEMO.consultationId, field: DEMO.fieldA, author: DEMO.expertA, text: "贴壁型腺癌", origin: "offline" }));
    mustCommit(ctx, planExpertAnnotation(state(ctx), { id: "A-X2", consultationId: DEMO.consultationId, field: DEMO.fieldA, author: DEMO.expertB, text: "浸润性鳞癌", origin: "offline" }));
    // 同一人同一结论重复上报, 应去重
    mustCommit(ctx, planExpertAnnotation(state(ctx), { id: "A-X1b", consultationId: DEMO.consultationId, field: DEMO.fieldA, author: DEMO.expertA, text: "贴壁型腺癌", origin: "offline" }));
    const merged = mergeFieldConclusions(Object.values(state(ctx).annotations));
    const fa = merged.find((m) => m.field.x === DEMO.fieldA.x && m.field.y === DEMO.fieldA.y);
    assert(!!fa, "未找到目标视野的合并结论");
    assert(fa.conflict, "两人结论不同应标记冲突");
    assert(fa.versions.length === 2, `应保留两版, 实际 ${fa.versions.length} 版`);
    return `视野 (${DEMO.fieldA.x},${DEMO.fieldA.y}) 保留「${fa.versions.map((v) => v.text).join(" / ")}」两版, 冲突标记=是`;
  });

  test("5. 两名专家同时签发, 只允许一份生效", () => {
    const ctx = fresh();
    lend(ctx);
    mustCommit(ctx, planDraftOpinion(state(ctx), { id: "O-A", consultationId: DEMO.consultationId, author: DEMO.expertA }));
    mustCommit(ctx, planDraftOpinion(state(ctx), { id: "O-B", consultationId: DEMO.consultationId, author: DEMO.expertB }));
    // 两人基于同一版本同时规划签发
    const snapshotState = state(ctx);
    const p1 = planSignOpinion(snapshotState, { opinionId: "O-A", signer: DEMO.expertA, at: "2026-10-03T10:00:00" });
    const p2 = planSignOpinion(snapshotState, { opinionId: "O-B", signer: DEMO.expertB, at: "2026-10-03T10:00:00" });
    assert(p1.ok && p2.ok, "两份签发规划都应合法");
    const c1 = commit(ctx.store, p1.value);
    const c2 = commit(ctx.store, p2.value);
    assert(c1.ok, "先提交者应生效");
    assert(!c2.ok && !!c2.conflict, "后提交者应因 CAS 冲突被拒");
    const c = state(ctx).consultations[DEMO.consultationId];
    assert(c.signedOpinionId === "O-A", `生效签发应为 O-A, 实际 ${c.signedOpinionId}`);
    assert(state(ctx).opinions["O-B"].status === "draft", "被拒签发的意见应回滚为草稿");
    return `O-A 生效, O-B 提交被拒(${c2.conflict})`;
  });

  test("6. 玻片事件: 未签发失效重算, 已签发保留快照", () => {
    const ctx = fresh();
    lend(ctx);
    mustCommit(ctx, planExpertAnnotation(state(ctx), { id: "A-X1", consultationId: DEMO.consultationId, field: DEMO.fieldA, author: DEMO.expertA, text: "贴壁型腺癌", origin: "online" }));
    mustCommit(ctx, planSignOpinion(state(ctx), { opinionId: "O-0417-1", signer: DEMO.expertA, at: "2026-10-03T10:00:00" }));
    mustCommit(ctx, planDraftOpinion(state(ctx), { id: "O-B", consultationId: DEMO.consultationId, author: DEMO.expertB }));
    const planned = planSlideEvent(state(ctx), { type: "staining_changed", slideId: DEMO.slideId, newBatch: "HE-2610-C", at: "2026-10-04T09:00:00" });
    assert(planned.ok, "事件规划失败");
    assert(planned.value.effects.invalidated.includes("O-B"), "草稿 O-B 应被失效");
    assert(planned.value.effects.staleSigned.includes("O-0417-1"), "已签发 O-0417-1 应被标记快照保留");
    const res = commit(ctx.store, planned.value.batch);
    assert(res.ok, `事件批次提交失败: ${res.note}`);
    const st = state(ctx);
    const ob = st.opinions["O-B"];
    assert(ob.status === "invalidated" && !!ob.invalidatedReason, "O-B 未失效");
    const recomputed = st.opinions[ob.supersededBy ?? ""];
    assert(!!recomputed && recomputed.status === "draft", "未生成重算草稿");
    assert(recomputed.basedOnSlideVersion === 4 && recomputed.basedOnStainingBatch === "HE-2610-C", "重算草稿未绑定新版本/批次");
    const signed = st.opinions["O-0417-1"];
    assert(signed.status === "signed" && signed.snapshot !== null, "已签发意见快照丢失");
    assert(signed.snapshot.content === "本院初诊: 倾向肺腺癌, 建议借片外院会诊并结合免疫组化确认", "快照内容被改动");
    assert(!!signed.staleReason, "已签发意见应标记基底变化");
    return `O-B 失效→重算为 ${recomputed.id}(v4/HE-2610-C); O-0417-1 快照保留并标记 stale`;
  });

  test("7. 玻片归还后外院标注通道关闭", () => {
    const ctx = fresh();
    lend(ctx);
    commitEvent(ctx, { type: "slide_returned", loanId: DEMO.loanId, at: "2026-10-05T17:00:00" });
    const r = planExternalChange(state(ctx), {
      kind: "add_annotation", id: "A-E9", consultationId: DEMO.consultationId,
      field: DEMO.fieldA, author: DEMO.externalDoctor, text: "补充: 未见脉管侵犯", origin: "online",
    });
    assert(!r.ok && r.error.code === "NO_ACTIVE_LOAN", "归还后外院标注未被拒绝");
    assert(state(ctx).slides[DEMO.slideId].status === "in_house", "归还后玻片应回库");
    return "归还后外院补标注被 NO_ACTIVE_LOAN 拒绝";
  });

  test("8. 原始玻片损坏: 草稿失效重算且不可再借出", () => {
    const ctx = fresh();
    lend(ctx);
    commitEvent(ctx, { type: "slide_damaged", slideId: DEMO.slideId, at: "2026-10-06T09:00:00" });
    const st = state(ctx);
    assert(st.slides[DEMO.slideId].status === "damaged", "玻片应登记为损坏");
    assert(st.opinions["O-0417-1"].status === "invalidated", "未签发的初诊意见应失效");
    const again = planLendSlide(st, { loanId: "L-X", consultationId: DEMO.consultationId, slideId: DEMO.slideId, borrower: "某院", at: "2026-10-07T09:00:00" });
    assert(!again.ok && again.error.code === "SLIDE_DAMAGED", "损坏玻片不应可借出");
    return "损坏登记完成, 初诊草稿失效重算, 再次借出被 SLIDE_DAMAGED 拒绝";
  });

  test("9. 写入失败后从完整会诊批次恢复重试", () => {
    const ctx = fresh();
    ctx.store.failNextWrites = 2; // 注入两次写失败
    const planned = planLendSlide(state(ctx), {
      loanId: DEMO.loanId, consultationId: DEMO.consultationId, slideId: DEMO.slideId, borrower: DEMO.borrower, at: "2026-10-01T09:00:00",
    });
    assert(planned.ok, "规划失败");
    const res = commit(ctx.store, planned.value);
    assert(res.ok && res.attempts === 3, `应第 3 次尝试成功, 实际 attempts=${res.attempts}`);
    assert(state(ctx).loans[DEMO.loanId].frozenSlideVersion === 3, "重试后批次内容不完整");
    const again = commit(ctx.store, planned.value); // 幂等
    assert(again.ok && again.attempts === 0, "已应用批次应幂等跳过");
    const loanCount = Object.keys(state(ctx).loans).filter((id) => id === DEMO.loanId).length;
    assert(loanCount === 1, "批次被重复应用");
    return `注入 2 次失败, 第 3 次尝试整体重放成功; 重复提交幂等跳过`;
  });

  test("10. 旧会诊缺玻片版本时按借片日期回填", () => {
    const loans = Object.values(seedState().loans);
    const [r1, r2, r3, r4] = seedLegacyRecords().map((rec) => backfillSlideVersion(rec, loans));
    assert(r1.ok && r1.value.slideVersion === 1 && r1.value.stainingBatch === "HE-2410-A", "2024-10-15 应回填 v1/HE-2410-A");
    assert(r2.ok && r2.value.slideVersion === 2 && r2.value.stainingBatch === "HE-2503-B", "2025-03-18 应回填 v2/HE-2503-B");
    assert(r3.ok && r3.value.slideVersion === 1, "已有版本的记录不应被改动");
    assert(!r4.ok && r4.error.code === "NO_LOAN_COVER", "无借片区间覆盖的日期应报 NO_LOAN_COVER");
    return "LC-1998-006→v1, LC-2001-013→v2, 已有版本不动, 无覆盖区间报错";
  });

  return results;
}
