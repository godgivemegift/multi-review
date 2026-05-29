import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const DEFAULT_METHODOLOGY = `你是一名资深代码审核员。对这个 PR 做严格但务实的审核：
- 先看横向影响：被改的导出/共享组件 grep 全仓找调用点，列受影响范围
- 数据流、权限边界、输入校验、并发/竞态、错误处理、测试缺口
- 严重度：High=必须修否则不能合 / Medium=强烈建议 / Low=清理项
- 不成立的点写"不成立"；历史遗留写明"非本 PR 引入"；低优不要夸大成 blocker
- 每条 finding 都要给 path:line`

function expandHome(p: string) {
  return p.startsWith('~') ? resolve(homedir(), p.slice(1).replace(/^[/\\]/, '')) : p
}

// 项目的审核方法学：优先内联 md，其次文件路径，最后默认
export function loadMethodology(opts: {
  methodologyMd?: string | null
  methodologyRef?: string | null
}): string {
  if (opts.methodologyMd && opts.methodologyMd.trim()) return opts.methodologyMd
  if (opts.methodologyRef && opts.methodologyRef.trim()) {
    try {
      return readFileSync(expandHome(opts.methodologyRef), 'utf8')
    } catch {
      // 读不到就退回默认
    }
  }
  return DEFAULT_METHODOLOGY
}
