// 最小声明：qrcode 1.5.x 不带自带类型，我们只用到 toDataURL。
declare module 'qrcode' {
  export interface QRCodeToDataURLOptions {
    margin?: number
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    color?: { dark?: string; light?: string }
  }
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>
  const _default: { toDataURL: typeof toDataURL }
  export default _default
}
