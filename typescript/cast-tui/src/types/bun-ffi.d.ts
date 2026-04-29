declare module 'bun:ffi' {
  export type Pointer = number | object

  export function dlopen(path: string, symbols: object): any
  export function toArrayBuffer(ptr: Pointer, offset: number, length: number): ArrayBuffer
  export function ptr(view: ArrayBufferView): Pointer
  export function JSCallback(cb: (...args: any[]) => any, options: any): any
}
