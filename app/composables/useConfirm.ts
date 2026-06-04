import { reactive } from 'vue'

type ConfirmOpts = { title?: string; message: string; okText?: string; cancelText?: string; danger?: boolean }

// 全局单例确认弹窗状态（由 <AppConfirm/> 渲染，useConfirm() 触发）。替代原生 window.confirm。
// title/okText/cancelText 留空时由 <AppConfirm/> 用 i18n 默认文案兜底（保证随语言切换、且可在 setup 外触发）
export const confirmState = reactive({
  open: false,
  title: '',
  message: '',
  okText: '',
  cancelText: '',
  danger: false,
  _resolve: null as null | ((v: boolean) => void),
})

export function useConfirm() {
  return (opts: ConfirmOpts) =>
    new Promise<boolean>((resolve) => {
      confirmState.title = opts.title ?? ''
      confirmState.message = opts.message
      confirmState.okText = opts.okText ?? ''
      confirmState.cancelText = opts.cancelText ?? ''
      confirmState.danger = !!opts.danger
      confirmState._resolve = resolve
      confirmState.open = true
    })
}

export function resolveConfirm(v: boolean) {
  confirmState.open = false
  confirmState._resolve?.(v)
  confirmState._resolve = null
}
