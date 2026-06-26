// SSE：实时推送某 review 的进度事件（stage / tool / status / done / error）。频道=裸 reviewId。
// createSseHandler 由 Nitro 自动从 server/utils 导入。
export default createSseHandler((id) => id)
