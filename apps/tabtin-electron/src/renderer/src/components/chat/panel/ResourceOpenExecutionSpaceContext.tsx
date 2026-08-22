import { createContext, useContext } from 'react';

export const ResourceOpenExecutionSpaceContext = createContext<string | null>(
  null,
);

export function useResourceOpenExecutionSpaceId(): string | null {
  return useContext(ResourceOpenExecutionSpaceContext);
}
