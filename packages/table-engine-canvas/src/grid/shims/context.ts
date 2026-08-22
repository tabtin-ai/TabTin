/**
 * grid stub（补齐宿主未提供的 SDK 类型）：context types，供 grid 组件引用。
 * These will be replaced when we rewrite the grid with our own implementation.
 */

export interface IUser {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  avatar?: string | null;
}
