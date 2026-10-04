// 会诊链核心逻辑: 全部为纯函数规划器。
// 每个环节只规划出一个完整批次(ConsultationBatch), 不直接落库;
// 落库统一走 store.commit, 从而支持 CAS 并发控制与失败后的整批重试。

import {
  Annotation,
  BatchOp,
  ChainEvent,
  ChainState,
  Consultation,
  ConsultationBatch,
  FieldConclusion,
  FieldCoord,
  FieldVersion,
  LegacyConsultationRecord,
  Opinion,
  OpinionSnapshot,
  Result,
  SlideLoan,
  err,
  ok,
} from "./types";

export function fieldKeyOf(f: FieldCoord): string {
  return `${f.slideId}|${f.x}:${f.y}|${f.magnification}x`;
}

const nextSeq = (state: ChainState): number =>
  Object.values(state.annotations).reduce((m, a) => Math.max(m, a.seq), 0) + 1;

const activeLoanOf = (state: ChainState, c: Consultation): SlideLoan | null => {
  if (!c.loanId) return null;
  const loan = state.loans[c.loanId];
  return loan && loan.returnedAt === null ? loan : null;
};

// ---------------------------------------------------------------------------
// 1. 借出: 冻结玻片版本与染色批次
// ---------------------------------------------------------------------------
export function planLendSlide(
  state: ChainState,
  input: { loanId: string; consultationId: string; slideId: string; borrower: string; at: string },
): Result<ConsultationBatch> {
  const slide = state.slides[input.slideId];
  if (!slide) return err("NOT_FOUND", `玻片 ${input.slideId} 不存在`);
  if (slide.status === "lent") return err("SLIDE_LENT", `玻片 ${slide.label} 已在借出中, 不可重复借出`);
  if (slide.status === "damaged") return err("SLIDE_DAMAGED", `玻片 ${slide.label} 已损坏, 不可借出`);
  const c = state.consultations[input.consultationId];
  if (!c) return err("NOT_FOUND", `会诊 ${input.consultationId} 不存在`);
  if (activeLoanOf(state, c)) return err("LOAN_ACTIVE", "该会诊已有在途借片单, 请先归还");

  const loan: SlideLoan = {
    id: input.loanId,
    consultationId: c.id,
    slideId: slide.id,
    borrower: input.borrower,
    lentAt: input.at,
    returnedAt: null,
    // 借出瞬间冻结: 之后重染/重切都不影响本次借出的依据
    frozenSlideVersion: slide.version,
    frozenStainingBatch: slide.stainingBatch,
  };
  const ops: BatchOp[] = [
    { op: "put_loan", value: loan },
    { op: "put_slide", value: { ...slide, status: "lent" } },
    {
      op: "put_consultation",
      value: { ...c, status: "lent", loanId: loan.id, version: c.version + 1 },
      expectedVersion: c.version,
    },
  ];
  return ok({
    id: `B-${loan.id}`,
    consultationId: c.id,
    label: `借出 ${slide.label} → ${input.borrower}, 冻结 v${loan.frozenSlideVersion} / ${loan.frozenStainingBatch}`,
    ops,
  });
}

// ---------------------------------------------------------------------------
// 2. 外院变更: 只允许补充标注, 其余一律拒绝
// ---------------------------------------------------------------------------
export type ExternalChange =
  | {
      kind: "add_annotation";
      id: string;
      consultationId: string;
      field: FieldCoord;
      author: string;
      text: string;
      origin: "online" | "offline";
    }
  | { kind: "modify_loan"; loanId: string }
  | { kind: "edit_local_annotation"; annotationId: string }
  | { kind: "sign_opinion"; opinionId: string };

const EXTERNAL_CHANGE_NAMES: Record<ExternalChange["kind"], string> = {
  add_annotation: "补充标注",
  modify_loan: "修改借片单",
  edit_local_annotation: "改动本院标注",
  sign_opinion: "签发会诊意见",
};

export function planExternalChange(state: ChainState, change: ExternalChange): Result<ConsultationBatch> {
  if (change.kind !== "add_annotation") {
    return err(
      "PERMISSION_DENIED",
      `越权拒绝: 外院账号无权「${EXTERNAL_CHANGE_NAMES[change.kind]}」, 仅允许补充标注`,
    );
  }
  const c = state.consultations[change.consultationId];
  if (!c) return err("NOT_FOUND", `会诊 ${change.consultationId} 不存在`);
  const loan = activeLoanOf(state, c);
  if (!loan) return err("NO_ACTIVE_LOAN", "无在途借片单, 外院标注通道已关闭(玻片已归还)");
  if (loan.slideId !== change.field.slideId) {
    return err("SLIDE_MISMATCH", `标注视野不属于借出玻片 ${loan.slideId}, 已拒绝`);
  }
  const ann: Annotation = {
    id: change.id,
    consultationId: c.id,
    field: change.field,
    author: change.author,
    role: "external",
    text: change.text,
    // 外院看的是借走的那张片子, 标注恒落在冻结版本上
    slideVersion: loan.frozenSlideVersion,
    origin: change.origin,
    seq: nextSeq(state),
  };
  const ops: BatchOp[] = [
    { op: "put_annotation", value: ann },
    {
      op: "put_consultation",
      value: { ...c, status: "annotating", version: c.version + 1 },
      expectedVersion: c.version,
    },
  ];
  return ok({
    id: `B-${ann.id}`,
    consultationId: c.id,
    label: `外院标注 ${ann.author} @ ${fieldKeyOf(ann.field)} (冻结 v${ann.slideVersion})`,
    ops,
  });
}

// ---------------------------------------------------------------------------
// 3. 专家标注(可离线) + 回连按坐标合并
// ---------------------------------------------------------------------------
export function planExpertAnnotation(
  state: ChainState,
  input: {
    id: string;
    consultationId: string;
    field: FieldCoord;
    author: string;
    text: string;
    origin: "online" | "offline";
  },
): Result<ConsultationBatch> {
  const c = state.consultations[input.consultationId];
  if (!c) return err("NOT_FOUND", `会诊 ${input.consultationId} 不存在`);
  if (c.status === "closed") return err("CLOSED", "会诊已关闭, 不可再标注");
  const slide = state.slides[input.field.slideId];
  if (!slide) return err("NOT_FOUND", `玻片 ${input.field.slideId} 不存在`);
  const ann: Annotation = {
    id: input.id,
    consultationId: c.id,
    field: input.field,
    author: input.author,
    role: "expert",
    text: input.text,
    slideVersion: slide.version,
    origin: input.origin,
    seq: nextSeq(state),
  };
  const ops: BatchOp[] = [
    { op: "put_annotation", value: ann },
    {
      op: "put_consultation",
      value: { ...c, status: c.status === "signed" ? c.status : "annotating", version: c.version + 1 },
      expectedVersion: c.version,
    },
  ];
  return ok({
    id: `B-${ann.id}`,
    consultationId: c.id,
    label: `专家${input.origin === "offline" ? "离线" : "在线"}标注 ${ann.author} @ ${fieldKeyOf(ann.field)}`,
    ops,
  });
}

/** 回连合并: 按视野坐标归组; 同一视野结论不同 → 多版共存并标记冲突 */
export function mergeFieldConclusions(annotations: Annotation[]): FieldConclusion[] {
  const groups = new Map<string, Annotation[]>();
  for (const a of annotations) {
    const key = fieldKeyOf(a.field);
    const list = groups.get(key);
    if (list) list.push(a);
    else groups.set(key, [a]);
  }
  const out: FieldConclusion[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => a.seq - b.seq);
    const versions: FieldVersion[] = [];
    const seen = new Set<string>();
    for (const a of sorted) {
      const sig = `${a.author}::${a.text}`;
      if (seen.has(sig)) continue; // 同人同结论重复上报, 去重
      seen.add(sig);
      versions.push({ author: a.author, text: a.text, annotationId: a.id, origin: a.origin });
    }
    const distinctTexts = new Set(versions.map((v) => v.text));
    out.push({ key, field: sorted[0].field, versions, conflict: distinctTexts.size > 1 });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// 4. 玻片事件: 未签发结论立即失效并重算, 已签发意见保留快照
// ---------------------------------------------------------------------------
export interface SlideEventEffects {
  invalidated: string[];
  recomputed: string[];
  staleSigned: string[];
}

/** 由当前已合并的视野结论重算草稿内容 */
export function recomputeDraftContent(state: ChainState, consultationId: string, basis: string): string {
  const anns = Object.values(state.annotations).filter((a) => a.consultationId === consultationId);
  const merged = mergeFieldConclusions(anns);
  const conflicts = merged.filter((m) => m.conflict);
  if (merged.length === 0) return `自动重算草稿(${basis})· 暂无有效视野标注, 待专家重新阅片`;
  const parts = merged.map((m) => {
    const coord = `${m.field.slideId} (${m.field.x}, ${m.field.y}) ${m.field.magnification}x`;
    return m.conflict
      ? `${coord}: ${m.versions.length} 种结论并存(${m.versions.map((v) => `${v.author}「${v.text}」`).join(" / ")})`
      : `${coord}: ${m.versions[0].text}`;
  });
  return `自动重算草稿(${basis})· 依据 ${merged.length} 个视野${
    conflicts.length ? `, 其中 ${conflicts.length} 处结论冲突保留多版` : ""
  }: ${parts.join("; ")}`;
}

export function planSlideEvent(
  state: ChainState,
  event: ChainEvent,
): Result<{ batch: ConsultationBatch; effects: SlideEventEffects }> {
  const ops: BatchOp[] = [];
  let slideId: string;
  let reason: string;
  let consultationId = "";

  if (event.type === "slide_returned") {
    const loan = state.loans[event.loanId];
    if (!loan) return err("NOT_FOUND", `借片单 ${event.loanId} 不存在`);
    if (loan.returnedAt) return err("ALREADY_RETURNED", "该借片单已归还, 请勿重复操作");
    slideId = loan.slideId;
    consultationId = loan.consultationId;
    reason = "玻片已归还, 借出冻结版本不再可用";
    ops.push({ op: "put_loan", value: { ...loan, returnedAt: event.at } });
    const slide = state.slides[slideId];
    // 借出期间已损坏的玻片, 归还后仍保持损坏登记
    ops.push({ op: "put_slide", value: { ...slide, status: slide.status === "damaged" ? "damaged" : "in_house" } });
  } else if (event.type === "staining_changed") {
    const slide = state.slides[event.slideId];
    if (!slide) return err("NOT_FOUND", `玻片 ${event.slideId} 不存在`);
    slideId = slide.id;
    reason = `染色批次变更 ${slide.stainingBatch} → ${event.newBatch}, 玻片版本升至 v${slide.version + 1}`;
    ops.push({
      op: "put_slide",
      value: { ...slide, stainingBatch: event.newBatch, version: slide.version + 1 },
    });
  } else {
    const slide = state.slides[event.slideId];
    if (!slide) return err("NOT_FOUND", `玻片 ${event.slideId} 不存在`);
    if (slide.status === "damaged") return err("ALREADY_DAMAGED", "玻片已登记损坏");
    slideId = slide.id;
    reason = "原始玻片损坏, 基于该片的结论依据失效";
    ops.push({ op: "put_slide", value: { ...slide, status: "damaged" } });
  }

  // 找到所有借过这张片的会诊, 逐一处理其意见
  const affectedIds = new Set(
    Object.values(state.loans)
      .filter((l) => l.slideId === slideId)
      .map((l) => l.consultationId),
  );
  if (consultationId) affectedIds.add(consultationId);

  const effects: SlideEventEffects = { invalidated: [], recomputed: [], staleSigned: [] };
  // 事件后的玻片基底(重算草稿要绑定到新基底上)
  const slideAfter =
    event.type === "staining_changed"
      ? { version: state.slides[slideId].version + 1, batch: event.newBatch }
      : { version: state.slides[slideId].version, batch: state.slides[slideId].stainingBatch };

  for (const cid of affectedIds) {
    const c = state.consultations[cid];
    if (!c) continue;
    const opinions = Object.values(state.opinions).filter((o) => o.consultationId === cid);
    let recomputeNo = opinions.length;
    for (const opinion of opinions) {
      if (opinion.status === "draft") {
        // 未签发 → 立即失效, 并基于当前标注重算一份新草稿
        recomputeNo += 1;
        const newId = `${opinion.id}-r${recomputeNo}`;
        const invalidated: Opinion = {
          ...opinion,
          status: "invalidated",
          invalidatedReason: reason,
          supersededBy: newId,
        };
        const recomputed: Opinion = {
          id: newId,
          consultationId: cid,
          author: opinion.author,
          content: recomputeDraftContent(state, cid, reason),
          status: "draft",
          basedOnSlideVersion: slideAfter.version,
          basedOnStainingBatch: slideAfter.batch,
          snapshot: null,
          invalidatedReason: null,
          supersededBy: null,
          staleReason: null,
        };
        ops.push({ op: "put_opinion", value: invalidated }, { op: "put_opinion", value: recomputed });
        effects.invalidated.push(opinion.id);
        effects.recomputed.push(newId);
      } else if (opinion.status === "signed") {
        // 已签发 → 快照原样保留, 仅标记基底已变化
        ops.push({
          op: "put_opinion",
          value: { ...opinion, staleReason: `${reason}; 签发快照(v${opinion.basedOnSlideVersion})继续有效` },
        });
        effects.staleSigned.push(opinion.id);
      }
    }
    ops.push({
      op: "put_consultation",
      value: { ...c, version: c.version + 1 },
      expectedVersion: c.version,
    });
  }

  return ok({
    batch: {
      id: `B-EVT-${event.type}-${Date.parse(event.at) || 0}`,
      consultationId: consultationId || [...affectedIds][0] || "",
      label: `玻片事件: ${reason}`,
      ops,
    },
    effects,
  });
}

// ---------------------------------------------------------------------------
// 5. 签发: 乐观锁 CAS, 两人同时提交只允许一份生效
// ---------------------------------------------------------------------------
export function planSignOpinion(
  state: ChainState,
  input: { opinionId: string; signer: string; at: string },
): Result<ConsultationBatch> {
  const opinion = state.opinions[input.opinionId];
  if (!opinion) return err("NOT_FOUND", `意见 ${input.opinionId} 不存在`);
  if (opinion.status === "invalidated") {
    return err("INVALIDATED", `意见 ${opinion.id} 已失效(${opinion.invalidatedReason ?? "基底变化"}), 请签发重算后的草稿`);
  }
  if (opinion.status !== "draft") return err("NOT_DRAFT", `意见 ${opinion.id} 当前状态 ${opinion.status}, 不可签发`);
  const c = state.consultations[opinion.consultationId];
  if (!c) return err("NOT_FOUND", "会诊不存在");
  if (c.signedOpinionId) return err("ALREADY_SIGNED", `会诊已有签发意见 ${c.signedOpinionId}, 不可重复签发`);

  const snapshot: OpinionSnapshot = {
    content: opinion.content,
    signer: input.signer,
    signedAt: input.at,
    slideVersion: opinion.basedOnSlideVersion,
    stainingBatch: opinion.basedOnStainingBatch,
  };
  const ops: BatchOp[] = [
    { op: "put_opinion", value: { ...opinion, status: "signed", snapshot } },
    {
      op: "put_consultation",
      // CAS 关键: expectedVersion 锁定的是规划时读到的版本,
      // 两人同时签发时, 后提交者版本对不上即被拒绝
      value: { ...c, status: "signed", signedOpinionId: opinion.id, version: c.version + 1 },
      expectedVersion: c.version,
    },
  ];
  return ok({
    id: `B-SIGN-${opinion.id}`,
    consultationId: c.id,
    label: `签发 ${opinion.id} (${input.signer}) @ v${opinion.basedOnSlideVersion}`,
    ops,
  });
}

// ---------------------------------------------------------------------------
// 6. 生成会诊草稿(从当前合并结论起草, 供签发)
// ---------------------------------------------------------------------------
export function planDraftOpinion(
  state: ChainState,
  input: { id: string; consultationId: string; author: string },
): Result<ConsultationBatch> {
  const c = state.consultations[input.consultationId];
  if (!c) return err("NOT_FOUND", `会诊 ${input.consultationId} 不存在`);
  const loan = c.loanId ? state.loans[c.loanId] : null;
  const slideId = loan?.slideId ?? Object.values(state.loans).find((l) => l.consultationId === c.id)?.slideId;
  const slide = slideId ? state.slides[slideId] : null;
  if (!slide) return err("NO_SLIDE", "该会诊尚未关联任何玻片, 无法起草");
  const basisVersion = loan && loan.returnedAt === null ? loan.frozenSlideVersion : slide.version;
  const basisBatch = loan && loan.returnedAt === null ? loan.frozenStainingBatch : slide.stainingBatch;
  const opinion: Opinion = {
    id: input.id,
    consultationId: c.id,
    author: input.author,
    content: recomputeDraftContent(state, c.id, `v${basisVersion} / ${basisBatch}`),
    status: "draft",
    basedOnSlideVersion: basisVersion,
    basedOnStainingBatch: basisBatch,
    snapshot: null,
    invalidatedReason: null,
    supersededBy: null,
    staleReason: null,
  };
  const ops: BatchOp[] = [
    { op: "put_opinion", value: opinion },
    {
      op: "put_consultation",
      value: { ...c, version: c.version + 1 },
      expectedVersion: c.version,
    },
  ];
  return ok({
    id: `B-${opinion.id}`,
    consultationId: c.id,
    label: `起草会诊意见 ${opinion.id} (${opinion.author}) 基于 v${basisVersion} / ${basisBatch}`,
    ops,
  });
}

// ---------------------------------------------------------------------------
// 7. 旧会诊回填: 缺玻片版本时, 按借片日期找到覆盖该日期的借片单
// ---------------------------------------------------------------------------
export function backfillSlideVersion(
  rec: LegacyConsultationRecord,
  loans: SlideLoan[],
): Result<LegacyConsultationRecord> {
  if (rec.slideVersion !== null && rec.stainingBatch !== null) return ok(rec);
  const t = Date.parse(rec.consultDate);
  if (Number.isNaN(t)) return err("BAD_DATE", `会诊日期无法解析: ${rec.consultDate}`);
  const covering = loans
    .filter((l) => l.slideId === rec.slideId)
    .filter((l) => Date.parse(l.lentAt) <= t && (l.returnedAt === null || t <= Date.parse(l.returnedAt)))
    .sort((a, b) => Date.parse(b.lentAt) - Date.parse(a.lentAt));
  const loan = covering[0];
  if (!loan) {
    return err("NO_LOAN_COVER", `借片日期 ${rec.consultDate} 不在 ${rec.slideId} 任何借片单的覆盖区间内, 无法回填`);
  }
  return ok({
    ...rec,
    slideVersion: loan.frozenSlideVersion,
    stainingBatch: loan.frozenStainingBatch,
  });
}
