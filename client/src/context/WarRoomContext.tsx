/// <reference types="vite/client" />
/**
 * WarRoomContext.tsx — exports ONLY the WarRoomProvider component.
 *
 * Non-component exports (WarRoomContext object, Article, WarRoomContextValue)
 * are re-exported here from warRoomContextInstance.ts so downstream imports
 * require no changes, while Vite Fast Refresh sees this file as a
 * pure-component module (no mixed component/non-component exports).
 */
import React, { useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import axios from 'axios';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

// Re-export types & context object from the isolated instance file
// so all existing consumers (useWarRoom.ts, App.tsx, etc.) keep working unchanged.
export type { Article, WarRoomContextValue } from './warRoomContextInstance';
export { WarRoomContext } from './warRoomContextInstance';
import { WarRoomContext } from './warRoomContextInstance';
import type { Article, WarRoomContextValue } from './warRoomContextInstance';

const getApiBaseUrl = () => {
  const globalObj = typeof globalThis !== 'undefined' ? (globalThis as any) : null;
  if (globalObj?.process?.env?.NEXT_PUBLIC_API_BASE_URL) {
    return globalObj.process.env.NEXT_PUBLIC_API_BASE_URL;
  }
  if (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL) {
    return (import.meta as any).env.VITE_API_BASE_URL;
  }
  return 'http://localhost:5000';
};

const API_BASE_URL = getApiBaseUrl();

/**
 * Exponential backoff retry wrapper to handle transient Supabase network blips (ERR_CONNECTION_RESET)
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 400,
  factor = 2
): Promise<T> {
  let attempt = 0;
  let currentDelay = delayMs;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      if (attempt >= retries) throw err;
      console.warn(`[Supabase Retry] Attempt ${attempt} failed (${err.message}). Retrying in ${currentDelay}ms...`);
      await new Promise((res) => setTimeout(res, currentDelay));
      currentDelay *= factor;
    }
  }
  throw new Error('All retry attempts failed');
}

export const WarRoomProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isRealtimeActive, setIsRealtimeActive] = useState<boolean>(false);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [isFetchingLive, setIsFetchingLive] = useState<boolean>(false);

  const newestCursorRef = useRef<string>('');

  // 1. Fetch initial load of articles with exponential backoff
  const fetchArticles = useCallback(async (isInitial = false) => {
    try {
      if (isInitial) setLoading(true);
      setError(null);

      if (isSupabaseConfigured && supabase) {
        let simFailureCount = 0;
        const data = await retryWithBackoff(async () => {
          // Test hook for Bug 5 verification: if triggered, simulate a network reset on attempt 1 then recover
          if (typeof window !== 'undefined' && (window as any).__simulateSupabaseFailOnce && simFailureCount === 0) {
            simFailureCount++;
            throw new Error('TypeError: Failed to fetch (net::ERR_CONNECTION_RESET)');
          }
          const { data: resData, error: sbError } = await supabase!
            .from('articles')
            .select('*')
            .order('ingested_at', { ascending: false, nullsFirst: false });

          if (sbError) throw sbError;
          return resData;
        }, 3, 400);

        if (data && data.length > 0) {
          setArticles(data as Article[]);
          if (data[0]?.ingested_at) {
            newestCursorRef.current = data[0].ingested_at;
          }
          if (isInitial) setLoading(false);
          return;
        }
      }

      // Backend API fallback
      const resp = await axios.get(`${API_BASE_URL}/api/articles`);
      if (resp.data && Array.isArray(resp.data.articles)) {
        setArticles(resp.data.articles);
        if (resp.data.articles[0]?.ingested_at) {
          newestCursorRef.current = resp.data.articles[0].ingested_at;
        }
      }
    } catch (err: any) {
      console.warn('[WarRoomProvider] Fetch notice:', err.message);
      setError(err.message);
    } finally {
      if (isInitial) setLoading(false);
    }
  }, []);

  // 2. Singleton Supabase Realtime Subscription
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).simulateSupabaseRetry = async () => {
        (window as any).__simulateSupabaseFailOnce = true;
        console.log('[Test Harness] Triggering simulated Supabase network failure to test retryWithBackoff...');
        await fetchArticles(false);
        (window as any).__simulateSupabaseFailOnce = false;
      };

      const params = new URLSearchParams(window.location.search);
      if (params.get('simulateRetry') === 'true') {
        setTimeout(() => {
          (window as any).simulateSupabaseRetry();
        }, 100);
      }
    }

    fetchArticles(true);

    // Function to perform cursor-based reconnect recovery without full-table reload
    const performReconnectRecovery = async (cursor: string) => {
      if (!cursor || !isSupabaseConfigured || !supabase) return;
      try {
        console.log('[WarRoom] Recovery started');
        const { data: missingArticles, error: recErr } = await supabase
          .from('articles')
          .select('*')
          .gt('ingested_at', cursor)
          .order('ingested_at', { ascending: false });

        if (recErr) {
          console.warn('[WarRoom] Recovery query notice:', recErr.message);
          return;
        }

        const count = missingArticles?.length || 0;
        console.log(`[WarRoom] Recovery fetched ${count} articles`);

        if (count > 0) {
          setArticles((prev) => {
            const existingIds = new Set(prev.map((a) => a.id));
            const newUnique = (missingArticles as Article[]).filter((a) => !existingIds.has(a.id));
            if (newUnique.length === 0) return prev;
            // Update cursor with the newest item
            if (newUnique[0]?.ingested_at && newUnique[0].ingested_at > newestCursorRef.current) {
              newestCursorRef.current = newUnique[0].ingested_at;
            }
            return [...newUnique, ...prev];
          });
        }
        console.log('[WarRoom] Recovery completed');
      } catch (e: any) {
        console.warn('[WarRoom] Recovery exception:', e.message);
      }
    };

    let channel: any = null;
    let hasConnectedOnce = false;

    if (isSupabaseConfigured && supabase) {
      try {
        // Connect to singleton Realtime channel for Postgres changes
        channel = supabase
          .channel('public:articles')
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'articles'
            },
            (payload) => {
              const newArt = payload.new as Article;
              if (!newArt || !newArt.id) return;

              console.log('[WarRoom] Realtime INSERT', newArt.id, newArt.title);

              // Update newest cursor
              if (newArt.ingested_at && newArt.ingested_at > newestCursorRef.current) {
                newestCursorRef.current = newArt.ingested_at;
              }

              setArticles((currentArticles) => {
                // Stable identity deduplication by article.id
                if (currentArticles.some((article) => article.id === newArt.id)) {
                  return currentArticles;
                }
                return [newArt, ...currentArticles];
              });
            }
          )
          .on(
            'postgres_changes',
            {
              event: 'UPDATE',
              schema: 'public',
              table: 'articles'
            },
            (payload) => {
              const updated = payload.new as Article;
              if (!updated || !updated.id) return;

              console.log('[WarRoom] Realtime UPDATE', updated.id, updated.status, updated.risk_level || '');

              setArticles((prev) =>
                prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item))
              );
            }
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              console.log('[WarRoom] Realtime SUBSCRIBED');
              setIsRealtimeActive(true);

              // If this is a re-connection after a drop, execute cursor recovery
              if (hasConnectedOnce && newestCursorRef.current) {
                performReconnectRecovery(newestCursorRef.current);
              }
              hasConnectedOnce = true;
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              console.warn('[WarRoom] Realtime DISCONNECTED', status);
              setIsRealtimeActive(false);
            }
          });
      } catch (channelErr: any) {
        console.warn('[WarRoomProvider] Realtime channel init notice:', channelErr.message);
      }
    }

    return () => {
      if (channel && supabase) {
        supabase.removeChannel(channel);
      }
    };
  }, [fetchArticles]);

  // 3. Acknowledge Article
  const acknowledgeArticle = useCallback(
    async (id: string) => {
      setArticles((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: 'ACKNOWLEDGED' as const } : a))
      );

      try {
        if (isSupabaseConfigured && supabase) {
          const { error: sbErr } = await supabase
            .from('articles')
            .update({ status: 'ACKNOWLEDGED' })
            .eq('id', id);
          if (sbErr) throw sbErr;
        } else {
          await axios.patch(`${API_BASE_URL}/api/articles/${id}/acknowledge`);
        }
      } catch (err: any) {
        console.error('[WarRoomProvider] Failed to acknowledge article:', err);
        fetchArticles(false);
      }
    },
    [fetchArticles]
  );

  // 4. Fetch Live Authentic News
  const fetchLiveNews = useCallback(async () => {
    setIsFetchingLive(true);
    try {
      const resp = await axios.post(`${API_BASE_URL}/api/fetch-live`);
      console.log('[WarRoomProvider] Live authentic news fetched:', resp.data);
      await fetchArticles(false);
    } catch (err: any) {
      console.error('[WarRoomProvider] Fetch live news failed:', err.message);
    } finally {
      setIsFetchingLive(false);
    }
  }, [fetchArticles]);

  // 5. Simulate Crisis Ingestion Trigger
  const simulateCrisis = useCallback(async () => {
    setIsSimulating(true);
    try {
      await fetchLiveNews();
    } catch (err: any) {
      console.error('[WarRoomProvider] Ingestion trigger failed:', err.message);
    } finally {
      setIsSimulating(false);
    }
  }, [fetchLiveNews]);

  // 6. Voice Call Telephony Trigger
  const triggerVoiceCallAlert = useCallback(async (article: Article) => {
    try {
      console.log('🚨 Dispatching emergency voice alert for article:', article.id);
      await axios.post(`${API_BASE_URL}/api/simulate-voice-call`, {
        articleId: article.id,
        title: article.title,
        bullets: article.five_bullet_summary
      });
    } catch (err) {
      console.error('[WarRoomProvider] Voice call dispatch notice:', err);
    }
  }, []);

  return (
    <WarRoomContext.Provider
      value={{
        articles,
        loading,
        error,
        isRealtimeActive,
        isSimulating,
        isFetchingLive,
        fetchArticles,
        acknowledgeArticle,
        fetchLiveNews,
        simulateCrisis,
        triggerVoiceCallAlert
      }}
    >
      {children}
    </WarRoomContext.Provider>
  );
};
