/**
 * Isolated module for the raw WarRoom React context instance and shared types.
 * Kept in a .ts (non-JSX) file so Vite Fast Refresh treats WarRoomContext.tsx
 * as a pure-component file (WarRoomProvider only), eliminating the
 * "export is incompatible" HMR warning.
 */
import { createContext } from 'react';

export interface Article {
  id: string;
  correlation_id?: string;
  api_source?: string;
  source_name: string;
  title: string;
  url: string | null;
  image_url?: string | null;
  raw_content: string;
  entity_mentioned: string;
  sentiment: 'Positive' | 'Neutral' | 'Negative';
  risk_score: number;
  risk_level: 'Low' | 'Medium' | 'High' | 'Critical';
  five_bullet_summary: string[];
  status: 'ACTIVE' | 'ACKNOWLEDGED';
  published_at: string;
  ingested_at: string;
  triaged_at?: string;
  briefed_at?: string;
  alerted_at?: string;
  dispatched_at?: string;
}

export interface WarRoomContextValue {
  articles: Article[];
  loading: boolean;
  error: string | null;
  isRealtimeActive: boolean;
  isSimulating: boolean;
  isFetchingLive: boolean;
  fetchArticles: (isInitial?: boolean) => Promise<void>;
  acknowledgeArticle: (id: string) => Promise<void>;
  fetchLiveNews: () => Promise<void>;
  simulateCrisis: () => Promise<void>;
  triggerVoiceCallAlert: (article: Article) => Promise<void>;
}

export const WarRoomContext = createContext<WarRoomContextValue | null>(null);
