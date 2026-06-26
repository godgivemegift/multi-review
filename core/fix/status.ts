// 修复任务「下一个状态」的判定：有未上传改动(本地脏 or 领先远端)→ ready；否则保持 pushed、或回落 open。
// 这条规则原本在 core/fix/pipeline.ts 和 server/api/fixes/[id].get.ts 各写了一份，极易漂移——抽出来单一来源。
export function computeFixNextStatus(args: {
  dirty: boolean
  ahead: boolean
  currentStatus?: string | null
}): 'ready' | 'pushed' | 'open' {
  if (args.dirty || args.ahead) return 'ready'
  return args.currentStatus === 'pushed' ? 'pushed' : 'open'
}
