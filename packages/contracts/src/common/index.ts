export type TabTinContractVersion = '0.1.0';

export interface OperationResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: Record<string, unknown>;
}
