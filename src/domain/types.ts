// 病理会诊链 · 领域模型
// 借片单、玻片版本、视野标注、会诊意见全部挂在同一条会诊链上,
// 每个环节只产生批次(Batch), 由存储层统一提交, 保证可续作、可恢复。

export type ISODateTime = string;

export type SlideStatus = "in_house" | "lent" | "damaged";

/** 玻片: version 在重染/重切时递增, stainingBatch 随染色批次变化 */
export interface Slide {
  id: string;
  label: string;
  staining: string;
  stainingBatch: string;
  version: number;
  status: SlideStatus;
}

/** 借片单: 借出瞬间冻结玻片版本与染色批次, 之后玻片怎么变都不影响本次借出 */
export interface SlideLoan {
  id: string;
  consultationId: string;
  slideId: string;
  borrower: string;
  lentAt: ISODateTime;
  returnedAt: ISODateTime | null;
  frozenSlideVersion: number;
  frozenStainingBatch: string;
}

export type Role = "local" | "external" | "expert";

/** 视野坐标: 合并标注的定位键 */
export interface FieldCoord {
  slideId: string;
  x: number;
  y: number;
  magnification: number;
}

export interface Annotation {
  id: string;
  consultationId: string;
  field: FieldCoord;
  author: string;
  role: Role;
  text: string;
  /** 标注所基于的玻片版本(外院标注恒为借出冻结版本) */
  slideVersion: number;
  origin: "online" | "offline";
  seq: number;
}

/** 同一视野下某一位标注者的一版结论 */
export interface FieldVersion {
  author: string;
  text: string;
  annotationId: string;
  origin: Annotation["origin"];
}

/** 按坐标合并后的视野结论: 结论不一致时多版共存 */
export interface FieldConclusion {
  key: string;
  field: FieldCoord;
  versions: FieldVersion[];
  conflict: boolean;
}

/** 签发瞬间写入的快照, 之后任何失效事件都只标记、不改动 */
export interface OpinionSnapshot {
  content: string;
  signer: string;
  signedAt: ISODateTime;
  slideVersion: number;
  stainingBatch: string;
}

export type OpinionStatus = "draft" | "signed" | "invalidated";

export interface Opinion {
  id: string;
  consultationId: string;
  author: string;
  content: string;
  status: OpinionStatus;
  basedOnSlideVersion: number;
  basedOnStainingBatch: string;
  snapshot: OpinionSnapshot | null;
  invalidatedReason: string | null;
  /** 失效后被哪一份重算草稿接替 */
  supersededBy: string | null;
  /** 已签发意见在基底变化后仅打标记, 快照保持原样 */
  staleReason: string | null;
}

export type ConsultationStatus = "open" | "lent" | "annotating" | "signed" | "closed";

export interface Consultation {
  id: string;
  patientRef: string;
  requester: string;
  status: ConsultationStatus;
  /** 乐观锁: 签发等关键写按此版本做 CAS */
  version: number;
  loanId: string | null;
  signedOpinionId: string | null;
  createdAt: ISODateTime;
}

export interface ChainState {
  slides: Record<string, Slide>;
  loans: Record<string, SlideLoan>;
  consultations: Record<string, Consultation>;
  annotations: Record<string, Annotation>;
  opinions: Record<string, Opinion>;
}

/** 触发"未签发失效重算"的三类玻片事件 */
export type ChainEvent =
  | { type: "slide_returned"; loanId: string; at: ISODateTime }
  | { type: "staining_changed"; slideId: string; newBatch: string; at: ISODateTime }
  | { type: "slide_damaged"; slideId: string; at: ISODateTime };

export interface ChainError {
  code: string;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ChainError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T>(code: string, message: string): Result<T> => ({
  ok: false,
  error: { code, message },
});

/** 会诊批次: 一次链上操作的完整写入集合, 也是写失败后的恢复单元 */
export type BatchOp =
  | { op: "put_slide"; value: Slide }
  | { op: "put_loan"; value: SlideLoan }
  | { op: "put_consultation"; value: Consultation; expectedVersion: number }
  | { op: "put_annotation"; value: Annotation }
  | { op: "put_opinion"; value: Opinion };

export interface ConsultationBatch {
  id: string;
  consultationId: string;
  label: string;
  ops: BatchOp[];
}

/** 旧会诊记录: 可能缺失玻片版本, 需要按借片日期回填 */
export interface LegacyConsultationRecord {
  id: string;
  slideId: string;
  consultDate: ISODateTime;
  slideVersion: number | null;
  stainingBatch: string | null;
}
