// SSE：修复任务实时进度（stage / tool / text / status / done / error）。频道=裸 fixId。
export default createSseHandler((id) => id)
