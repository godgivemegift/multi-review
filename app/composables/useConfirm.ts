import { reactive } from 'vue'

type ConfirmOpts = { title?: string; message: string; okText?: string; cancelText?: string; danger?: boolean }

// 全局单例确认弹窗状态（由 <AppConfirm/> 渲染，useConfirm() 触发）。替代原生 window.confirm。
export const confirmState = reactive({
  open: false,
  title: '确认',
  message: '',
  okText: '确定',
  cancelText: '取消',
  danger: false,
  _resolve: null as null | ((v: boolean) => void),
})

export function useConfirm() {
  return (opts: ConfirmOpts) =>
    new Promise<boolean>((resolve) => {
      confirmState.title = opts.title ?? '确认'
      confirmState.message = opts.message
      confirmState.okText = opts.okText ?? '确定'
      confirmState.cancelText = opts.cancelText ?? '取消'
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
