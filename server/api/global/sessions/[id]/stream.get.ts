import { globalChan } from '~core/global/pipeline'

// SSE：全局会话实时进度（chat/tool/text/done/error）。频道=g:<sessionId>。
export default createSseHandler(globalChan)
