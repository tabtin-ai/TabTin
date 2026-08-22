/** 云盘「文件」类：普通云文件。不含本机 tabfolder。 */
export const CLOUD_FILE_RESOURCE_TYPES = new Set(['file', 'tabfiles'])

export function isCloudFileResourceType(type: string): boolean {
  return CLOUD_FILE_RESOURCE_TYPES.has(type)
}
