/**
 * 统一的 Schema 标准格式
 *
 * 用于规范化不同来源的 Schema 格式差异
 */

import type { PaginationMethod } from './pagination';

export type FieldType = 'text' | 'attribute' | 'html' | 'regex';

export interface FieldConfig {
  name: string;
  selector: string;
  type: FieldType;
  attribute?: string;
  regex?: string;
  required?: boolean;
  description?: string;
  defaultValue?: string;
  transform?: string;
  preAction?: any;
}

export interface PaginationConfig {
  method: PaginationMethod;
  enabled?: boolean;
  nextSelector?: string;
  urlPattern?: string;
  maxPages?: number;
  waitTime?: number;
  scrollTimes?: number;
  scrollDistance?: number;
  stopWhenNoNewData?: boolean;
  stopSelector?: string;
  consecutiveDuplicates?: number;
  confidence?: number;
  reason?: string;
}

export interface StandardSchema {
  version: string;
  listSelector: string;
  fields: FieldConfig[];
  pagination?: PaginationConfig;
  metadata?: {
    name?: string;
    description?: string;
    source?: 'ai' | 'user' | 'backend';
    createdAt?: number;
    schemaId?: string;
    site?: {
      name?: string;
      domain?: string;
      baseUrl?: string;
    };
  };
}

export interface RawSchema {
  listSelector?: string;
  fields?: any[];
  pagination?: any;

  list_selector?: string;

  extraction?: {
    list_selector?: string;
    listSelector?: string;
    fields?: any[];
    pagination?: any;
  };

  version?: string;
  name?: string;
  description?: string;
  url?: string;
  metadata?: any;
  site?: any;
  [key: string]: any;
}
