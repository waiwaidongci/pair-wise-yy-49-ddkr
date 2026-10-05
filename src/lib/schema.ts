import { z } from 'zod'

export const revisionSchema = z.object({
  courseId: z.string().min(1, '请选择课程'),
  requirementId: z.string().min(1, '请选择毕业要求'),
  evidence: z.string().min(12, '证据说明至少需要 12 个字符'),
  revisionNote: z.string().min(8, '修订说明至少需要 8 个字符'),
  submitter: z.string().min(2, '请填写提交人'),
})

export const mappingSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  relation: z.enum(['支撑', '前置', '考核', '教学']),
  weight: z.number().min(0).max(1),
})

export const edgeInputSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  relation: z.enum(['支撑', '前置', '考核', '教学']),
  weight: z.number().min(0).max(1),
})

/** 带图谱基线号的连边批次提交 */
export const commitBatchSchema = z.object({
  batchId: z.string().min(1),
  baseVersion: z.number().int().min(0),
  edges: z.array(edgeInputSchema).min(1, '批次至少包含一条边'),
  failAfter: z.number().int().min(0).optional(),
})

export const adjudicateSchema = z.object({
  id: z.string().min(1),
  resolution: z.enum(['采用新边', '保留现有']),
})

export type RevisionInput = z.infer<typeof revisionSchema>
