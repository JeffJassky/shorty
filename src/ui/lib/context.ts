import React from 'react';
import type { ShortyClient } from '../../../types/client';
import type { UiRuntimeConfig } from '../../../types/index';

export interface AppContextValue {
  config: UiRuntimeConfig;
  client: ShortyClient;
  /** Bumped after any write so the list can refetch. */
  linksVersion: number;
  bumpLinks: () => void;
}

export const AppContext = React.createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = React.useContext(AppContext);
  if (!v) throw new Error('shorty: AppContext missing');
  return v;
}
