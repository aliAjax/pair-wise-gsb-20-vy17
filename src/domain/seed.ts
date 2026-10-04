// 演示初始数据：四类会诊链
//  C-01 旧会诊（缺玻片版本，待按借片日期回填）
//  C-02 借出中（冻结版本；同视野两版分歧；外院可补标注）
//  C-03 已归还（未签发结论已失效；已签发意见保留快照）
//  C-04 新建待借出

import type { AppState, Chain, Slide } from "./types";

export function buildSeed(): AppState {
  const slides: Slide[] = [
    {
      id: "S-101",
      caseNo: "P-2025-1042",
      part: "胃窦黏膜活检",
      versions: [
        { id: "HE-v1", stain: "HE", batchNo: "B23101", since: "2025-11-20T09:00:00.000Z" },
        { id: "HE-v2", stain: "HE", batchNo: "B24031", since: "2026-01-15T09:00:00.000Z" },
      ],
      damaged: false,
    },
    {
      id: "S-205",
      caseNo: "P-2026-0217",
      part: "甲状腺左叶结节",
      versions: [
        { id: "HE-v1", stain: "HE", batchNo: "B26015", since: "2026-02-20T09:00:00.000Z" },
      ],
      damaged: false,
    },
    {
      id: "S-188",
      caseNo: "P-2026-0188",
      part: "乳腺外上象限穿刺",
      versions: [
        { id: "HE-v1", stain: "HE", batchNo: "B25260", since: "2025-12-28T09:00:00.000Z" },
      ],
      damaged: false,
    },
    {
      id: "S-301",
      caseNo: "P-2026-0301",
      part: "结肠息肉咬检",
      versions: [
        { id: "HE-v1", stain: "HE", batchNo: "B26088", since: "2026-09-10T09:00:00.000Z" },
      ],
      damaged: false,
    },
  ];

  const c01: Chain = {
    id: "C-01",
    caseNo: "P-2025-1042",
    slideId: "S-101",
    stage: "legacy",
    // 历史系统只登记了借片日期，未冻结玻片版本 / 染色批次
    loan: {
      loanId: "loan-old-01",
      loanedAt: "2025-12-03T10:00:00.000Z",
      toHospital: "市第一人民医院",
      frozenVersionId: "",
      frozenBatchNo: "",
      note: "旧系统迁移：缺玻片版本",
    },
    annotations: [
      {
        id: "ann-old-1",
        authorId: "u3",
        authorName: "赵一凡（外院）",
        authorKind: "external",
        coord: { slideId: "S-101", x: 210, y: 96, mag: 200, label: "A1" },
        text: "慢性轻度萎缩性胃炎，活动Ⅰ级",
        at: "2025-12-05T14:00:00.000Z",
        offline: false,
        basis: "frozen",
        versionId: "",
        batchNo: "",
      },
    ],
    conclusions: [
      {
        id: "con-old-draft",
        coordKey: "S-101@210,96/200x",
        coord: { slideId: "S-101", x: 210, y: 96, mag: 200, label: "A1" },
        text: "慢性轻度萎缩性胃炎，活动Ⅰ级",
        authorIds: ["u3"],
        authorNames: ["赵一凡（外院）"],
        versionId: "",
        batchNo: "",
        state: "draft",
        createdAt: "2025-12-05T14:00:00.000Z",
        updatedAt: "2025-12-05T14:00:00.000Z",
      },
      {
        id: "con-old-issued",
        coordKey: "S-101@405,260/400x",
        coord: { slideId: "S-101", x: 405, y: 260, mag: 400, label: "B2" },
        text: "未见肠上皮化生及异型增生（历史意见）",
        authorIds: ["u1"],
        authorNames: ["王德明"],
        versionId: "",
        batchNo: "",
        state: "issued",
        createdAt: "2025-12-08T11:00:00.000Z",
        updatedAt: "2025-12-08T11:00:00.000Z",
      },
    ],
    issuances: [
      {
        id: "iss-old-1",
        expertId: "u1",
        expertName: "王德明",
        issuedAt: "2025-12-08T11:00:00.000Z",
        diagnosis: "慢性轻度萎缩性胃炎（历史签发，版本未登记，快照留存）",
        snapshot: {
          slideId: "S-101",
          versionId: "",
          batchNo: "",
          conclusions: [
            {
              coordLabel: "B2",
              coord: { slideId: "S-101", x: 405, y: 260, mag: 400, label: "B2" },
              text: "未见肠上皮化生及异型增生（历史意见）",
              authorNames: ["王德明"],
            },
          ],
        },
      },
    ],
    updatedAt: "2025-12-08T11:00:00.000Z",
  };

  const c02: Chain = {
    id: "C-02",
    caseNo: "P-2026-0217",
    slideId: "S-205",
    stage: "loaned",
    loan: {
      loanId: "loan-2026-02",
      loanedAt: "2026-09-28T09:30:00.000Z",
      toHospital: "省肿瘤医院",
      frozenVersionId: "HE-v1",
      frozenBatchNo: "B26015",
    },
    annotations: [
      {
        id: "ann-2-1",
        authorId: "u1",
        authorName: "王德明",
        authorKind: "home",
        coord: { slideId: "S-205", x: 132, y: 88, mag: 400, label: "A1" },
        text: "甲状腺乳头状微小癌，直径约 0.4 cm",
        at: "2026-09-28T08:00:00.000Z",
        offline: false,
        basis: "frozen",
        versionId: "HE-v1",
        batchNo: "B26015",
      },
      {
        id: "ann-2-2",
        authorId: "u3",
        authorName: "赵一凡（外院）",
        authorKind: "external",
        coord: { slideId: "S-205", x: 132, y: 88, mag: 400, label: "A1" },
        text: "倾向结节性甲状腺肿伴乳头状增生，未见明确包膜侵犯",
        at: "2026-10-01T15:20:00.000Z",
        offline: false,
        basis: "frozen",
        versionId: "HE-v1",
        batchNo: "B26015",
      },
    ],
    conclusions: [
      {
        id: "con-2-1",
        coordKey: "S-205@132,88/400x",
        coord: { slideId: "S-205", x: 132, y: 88, mag: 400, label: "A1" },
        text: "甲状腺乳头状微小癌，直径约 0.4 cm",
        authorIds: ["u1"],
        authorNames: ["王德明"],
        versionId: "HE-v1",
        batchNo: "B26015",
        state: "draft",
        createdAt: "2026-09-28T08:00:00.000Z",
        updatedAt: "2026-09-28T08:00:00.000Z",
      },
      {
        id: "con-2-2",
        coordKey: "S-205@132,88/400x",
        coord: { slideId: "S-205", x: 132, y: 88, mag: 400, label: "A1" },
        text: "倾向结节性甲状腺肿伴乳头状增生，未见明确包膜侵犯",
        authorIds: ["u3"],
        authorNames: ["赵一凡（外院）"],
        versionId: "HE-v1",
        batchNo: "B26015",
        state: "draft",
        createdAt: "2026-10-01T15:20:00.000Z",
        updatedAt: "2026-10-01T15:20:00.000Z",
      },
    ],
    issuances: [],
    updatedAt: "2026-10-01T15:20:00.000Z",
  };

  const c03: Chain = {
    id: "C-03",
    caseNo: "P-2026-0188",
    slideId: "S-188",
    stage: "returned",
    loan: {
      loanId: "loan-2026-0188",
      loanedAt: "2026-08-11T09:00:00.000Z",
      toHospital: "省肿瘤医院",
      frozenVersionId: "HE-v1",
      frozenBatchNo: "B25260",
      returnedAt: "2026-09-20T16:40:00.000Z",
    },
    annotations: [
      {
        id: "ann-3-1",
        authorId: "u1",
        authorName: "王德明",
        authorKind: "home",
        coord: { slideId: "S-188", x: 300, y: 150, mag: 100, label: "C1" },
        text: "浸润性导管癌，组织学Ⅱ级（签发所据）",
        at: "2026-08-20T10:00:00.000Z",
        offline: false,
        basis: "frozen",
        versionId: "HE-v1",
        batchNo: "B25260",
      },
      {
        id: "ann-3-2",
        authorId: "u3",
        authorName: "赵一凡（外院）",
        authorKind: "external",
        coord: { slideId: "S-188", x: 512, y: 77, mag: 400, label: "C2" },
        text: "局部见脉管内癌栓待免疫组化确认（未签发草稿）",
        at: "2026-09-15T13:00:00.000Z",
        offline: false,
        basis: "frozen",
        versionId: "HE-v1",
        batchNo: "B25260",
      },
    ],
    conclusions: [
      {
        id: "con-3-1",
        coordKey: "S-188@300,150/100x",
        coord: { slideId: "S-188", x: 300, y: 150, mag: 100, label: "C1" },
        text: "浸润性导管癌，组织学Ⅱ级（签发所据）",
        authorIds: ["u1"],
        authorNames: ["王德明"],
        versionId: "HE-v1",
        batchNo: "B25260",
        state: "issued",
        createdAt: "2026-08-20T10:00:00.000Z",
        updatedAt: "2026-08-25T09:00:00.000Z",
      },
      {
        id: "con-3-2",
        coordKey: "S-188@512,77/400x",
        coord: { slideId: "S-188", x: 512, y: 77, mag: 400, label: "C2" },
        text: "局部见脉管内癌栓待免疫组化确认（未签发草稿）",
        authorIds: ["u3"],
        authorNames: ["赵一凡（外院）"],
        versionId: "HE-v1",
        batchNo: "B25260",
        state: "invalidated",
        createdAt: "2026-09-15T13:00:00.000Z",
        updatedAt: "2026-09-20T16:40:00.000Z",
        invalidateReason: "玻片已归还：未签发结论立即失效，需在本院版本上重算",
        invalidatedAt: "2026-09-20T16:40:00.000Z",
      },
    ],
    issuances: [
      {
        id: "iss-3-1",
        expertId: "u1",
        expertName: "王德明",
        issuedAt: "2026-08-25T09:00:00.000Z",
        diagnosis: "（右乳）浸润性导管癌，组织学Ⅱ级，建议加做免疫组化",
        snapshot: {
          slideId: "S-188",
          versionId: "HE-v1",
          batchNo: "B25260",
          conclusions: [
            {
              coordLabel: "C1",
              coord: { slideId: "S-188", x: 300, y: 150, mag: 100, label: "C1" },
              text: "浸润性导管癌，组织学Ⅱ级（签发所据）",
              authorNames: ["王德明"],
            },
          ],
        },
      },
    ],
    updatedAt: "2026-09-20T16:40:00.000Z",
  };

  const c04: Chain = {
    id: "C-04",
    caseNo: "P-2026-0301",
    slideId: "S-301",
    stage: "new",
    annotations: [],
    conclusions: [],
    issuances: [],
    updatedAt: "2026-09-10T09:00:00.000Z",
  };

  return {
    actors: [
      { id: "u1", name: "王德明", kind: "home", title: "本院病理主任医师" },
      { id: "u2", name: "李素华", kind: "home", title: "本院病理副主任医师" },
      { id: "u4", name: "孙颖", kind: "home", title: "病理资料管理员" },
      { id: "u3", name: "赵一凡", kind: "external", title: "省肿瘤医院 / 市第一医院 会诊专家" },
    ],
    slides,
    chains: [c01, c02, c03, c04],
    batches: [],
    audit: [
      {
        id: "audit-seed",
        at: "2026-09-20T16:40:00.000Z",
        tone: "info",
        message: "C-03 玻片归还登记：1 条未签发结论已失效，已签发意见保留快照",
      },
    ],
    offlineQueue: [],
  };
}
