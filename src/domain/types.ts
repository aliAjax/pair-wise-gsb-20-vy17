// 病理外院会诊链：领域模型
// 一份借片单据 = 一条 Chain；玻片版本/染色批次在借出时冻结，全程只追加事件。

export type ActorKind = "home" | "external";

export interface Actor {
  id: string;
  name: string;
  kind: ActorKind;
  title: string;
}

export interface StainVersion {
  id: string; // 玻片染色版本号，如 HE-v3
  stain: string; // 染色方法，如 HE / IHC-Ki67
  batchNo: string; // 染色批次
  since: string; // 该版本制片/重染日期 ISO
}

export interface Slide {
  id: string; // 玻片号
  caseNo: string; // 病理号
  part: string; // 取材部位
  versions: StainVersion[]; // 按时间排列，末尾为当前版本
  damaged: boolean;
}

export interface FovCoord {
  slideId: string;
  x: number; // 镜下坐标，以玻片基准点为原点（0-1000）
  y: number;
  mag: number; // 放大倍数
  label?: string; // 视野名，如 A1
}

export type AnnotationBasis = "frozen" | "current";

export interface Annotation {
  id: string;
  authorId: string;
  authorName: string;
  authorKind: ActorKind;
  coord: FovCoord;
  text: string;
  at: string;
  offline: boolean;
  basis: AnnotationBasis; // 依据冻结版本 / 当前（重算后）版本
  versionId: string; // 依据的染色版本
  batchNo: string;
}

export type ConclusionState = "draft" | "invalidated" | "issued";

export interface Conclusion {
  id: string;
  coordKey: string;
  coord: FovCoord;
  text: string;
  authorIds: string[];
  authorNames: string[];
  versionId: string;
  batchNo: string;
  state: ConclusionState;
  createdAt: string;
  updatedAt: string;
  invalidateReason?: string;
  invalidatedAt?: string;
}

export type ChainStage =
  | "new" // 建链，尚未借出
  | "legacy" // 旧会诊（尚未接入冻结规则）
  | "loaned" // 已借出
  | "returned" // 已归还
  | "redyed" // 归还后重染/版本变化
  | "damaged"; // 原始玻片损坏

export interface LoanVoucher {
  loanId: string;
  loanedAt: string;
  toHospital: string;
  frozenVersionId: string; // 借出时冻结的玻片染色版本
  frozenBatchNo: string;
  returnedAt?: string;
  note?: string;
}

export interface Issuance {
  id: string;
  expertId: string;
  expertName: string;
  issuedAt: string;
  diagnosis: string;
  // 快照：签发时刻的结论、版本、批次，之后版本变化也不改动
  snapshot: {
    slideId: string;
    versionId: string;
    batchNo: string;
    conclusions: Array<{ coordLabel: string; coord: FovCoord; text: string; authorNames: string[] }>;
  };
  superseded?: boolean; // 并发竞争中落败
}

export interface Chain {
  id: string;
  caseNo: string;
  slideId: string;
  stage: ChainStage;
  loan?: LoanVoucher;
  annotations: Annotation[];
  conclusions: Conclusion[];
  issuances: Issuance[];
  backfilled?: { versionId: string; batchNo: string; at: string; source: string };
  updatedAt: string;
}

// ---- 事件（append-only）----

export type DomainEvent =
  | { type: "LoanCreated"; at: string; loan: LoanVoucher }
  | { type: "AnnotationAdded"; at: string; annotation: Annotation }
  | {
      type: "ConclusionsInvalidated";
      at: string;
      reason: string;
      conclusionIds: string[];
      newVersionId?: string;
    }
  | { type: "SlideReturned"; at: string }
  | { type: "StainVersionChanged"; at: string; newVersionId: string; newBatchNo: string }
  | { type: "SlideDamaged"; at: string; reason: string }
  | { type: "Issued"; at: string; issuance: Issuance }
  | {
      type: "VersionBackfilled";
      at: string;
      versionId: string;
      batchNo: string;
      source: string;
    };

export interface JournalBatch {
  id: string;
  chainId: string;
  label: string;
  at: string;
  events: DomainEvent[];
  committed: boolean;
  // 模拟“写入失败”：前 entryCount 条事件已落库，其余在崩溃中丢失，
  // 但完整批次仍保留在客户端，可从批次恢复重试。
  entryCount: number;
  failed?: boolean;
  failReason?: string;
  recoveredAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  tone: "ok" | "reject" | "warn" | "info";
  message: string;
  ephemeral?: boolean;
}

export interface OfflinePacket {
  id: string;
  chainId: string;
  authorId: string;
  preparedAt: string;
  annotations: Array<{ coord: FovCoord; text: string; at: string }>;
}

export interface AppState {
  actors: Actor[];
  slides: Slide[];
  chains: Chain[];
  batches: JournalBatch[];
  audit: AuditEntry[];
  offlineQueue: OfflinePacket[];
}

// 业务规则拒绝（不写入日志，单独审计）
export class PermissionError extends Error {}
export class ConflictError extends Error {}
export class RuleError extends Error {}
