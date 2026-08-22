export interface CreateResourceOptions {
  collectionId?: string | null
  parentDocumentId?: string | null
  /** ：挂到 ContextItem 知识库树 */
  parentItemId?: string | null
}

export type CreateResourceHandler = (options?: CreateResourceOptions) => void | Promise<void>
