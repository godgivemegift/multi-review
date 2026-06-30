import { featureChan } from '~core/feature/pipeline'

// SSE：feature 任务实时进度（stage/tool/text/chat/error）。频道=f:<taskId>。
export default createSseHandler(featureChan)
