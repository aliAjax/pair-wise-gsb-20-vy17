// 演示用种子数据: 一条可续作的会诊链 + 历史借片单 + 待回填的旧会诊记录

import { ChainState, LegacyConsultationRecord } from "./types";

export const DEMO = {
  consultationId: "C-2026-0417",
  slideId: "SP-2601",
  loanId: "L-2026-088",
  borrower: "市第二人民医院",
  externalDoctor: "陈医生(外院)",
  expertA: "王主任(本院)",
  expertB: "李教授(特邀)",
  fieldA: { slideId: "SP-2601", x: 120, y: 88, magnification: 400 },
  fieldB: { slideId: "SP-2601", x: 305, y: 142, magnification: 200 },
};

export function seedState(): ChainState {
  return {
    slides: {
      "SP-2601": {
        id: "SP-2601",
        label: "SP-2601 · 右肺上叶穿刺 1号片",
        staining: "HE",
        stainingBatch: "HE-2609-A",
        version: 3,
        status: "in_house",
      },
      "SP-2602": {
        id: "SP-2602",
        label: "SP-2602 · 右肺上叶穿刺 2号片",
        staining: "IHC-TTF1",
        stainingBatch: "IHC-2610-B",
        version: 1,
        status: "in_house",
      },
    },
    loans: {
      // 历史借片单(已归还), 供旧会诊按借片日期回填版本
      "L-2024-118": {
        id: "L-2024-118",
        consultationId: "C-2024-0118",
        slideId: "SP-2601",
        borrower: "市第二人民医院",
        lentAt: "2024-10-08T09:00:00",
        returnedAt: "2024-10-22T17:00:00",
        frozenSlideVersion: 1,
        frozenStainingBatch: "HE-2410-A",
      },
      "L-2025-046": {
        id: "L-2025-046",
        consultationId: "C-2025-0046",
        slideId: "SP-2601",
        borrower: "省肿瘤医院",
        lentAt: "2025-03-11T09:00:00",
        returnedAt: "2025-03-25T17:00:00",
        frozenSlideVersion: 2,
        frozenStainingBatch: "HE-2503-B",
      },
    },
    consultations: {
      "C-2026-0417": {
        id: "C-2026-0417",
        patientRef: "P-88012 · 男 · 62岁 · 右肺上叶占位",
        requester: "市第二人民医院",
        status: "open",
        version: 1,
        loanId: null,
        signedOpinionId: null,
        createdAt: "2026-09-28T09:00:00",
      },
    },
    annotations: {},
    opinions: {
      "O-0417-1": {
        id: "O-0417-1",
        consultationId: "C-2026-0417",
        author: "王主任(本院)",
        content: "本院初诊: 倾向肺腺癌, 建议借片外院会诊并结合免疫组化确认",
        status: "draft",
        basedOnSlideVersion: 3,
        basedOnStainingBatch: "HE-2609-A",
        snapshot: null,
        invalidatedReason: null,
        supersededBy: null,
        staleReason: null,
      },
    },
  };
}

/** 旧会诊记录: 有的缺玻片版本, 有的日期不在任何借片区间内 */
export function seedLegacyRecords(): LegacyConsultationRecord[] {
  return [
    {
      id: "LC-1998-006",
      slideId: "SP-2601",
      consultDate: "2024-10-15T10:00:00",
      slideVersion: null,
      stainingBatch: null,
    },
    {
      id: "LC-2001-013",
      slideId: "SP-2601",
      consultDate: "2025-03-18T11:00:00",
      slideVersion: null,
      stainingBatch: null,
    },
    {
      id: "LC-1999-002",
      slideId: "SP-2601",
      consultDate: "2024-10-16T14:00:00",
      slideVersion: 1,
      stainingBatch: "HE-2410-A",
    },
    {
      id: "LC-2003-007",
      slideId: "SP-2601",
      consultDate: "2023-06-01T09:00:00",
      slideVersion: null,
      stainingBatch: null,
    },
  ];
}
