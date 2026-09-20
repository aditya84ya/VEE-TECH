/**
 * Structured Diagnostic Trace Logger for Vee-Alert Pipeline
 * Emits uniform structured events with traceId, articleId, provider, timestamp, stage, and reason.
 */

export const STAGES = {
  // Granular Boundary Stages (Phases 1-3)
  ADAPTER_START: 'ADAPTER_START',
  CAN_FETCH: 'CAN_FETCH',
  EXECUTE_FETCH_ENTER: 'EXECUTE_FETCH_ENTER',
  EXECUTE_FETCH_ALLOWED: 'EXECUTE_FETCH_ALLOWED',
  CHILD_FETCH_ENTER: 'CHILD_FETCH_ENTER',
  HTTP_REQUEST_START: 'HTTP_REQUEST_START',
  HTTP_RESPONSE: 'HTTP_RESPONSE',
  HTTP_ERROR: 'HTTP_ERROR',
  CHILD_FETCH_EXIT: 'CHILD_FETCH_EXIT',
  EXECUTE_FETCH_EXIT: 'EXECUTE_FETCH_EXIT',
  PROVIDER_FETCH_RESULT: 'PROVIDER_FETCH_RESULT',

  // Skip States (Phase 2)
  PROVIDER_FETCH_SKIPPED_COOLDOWN: 'PROVIDER_FETCH_SKIPPED_COOLDOWN',
  PROVIDER_FETCH_SKIPPED_QUOTA: 'PROVIDER_FETCH_SKIPPED_QUOTA',
  PROVIDER_FETCH_SKIPPED_DISABLED: 'PROVIDER_FETCH_SKIPPED_DISABLED',
  PROVIDER_FETCH_SKIPPED_NOT_CONFIGURED: 'PROVIDER_FETCH_SKIPPED_NOT_CONFIGURED',

  // Provider Lifecycle Stages
  PROVIDER_FETCH_START: 'PROVIDER_FETCH_START',
  PROVIDER_FETCH_SUCCESS: 'PROVIDER_FETCH_SUCCESS',
  PROVIDER_FETCH_ERROR: 'PROVIDER_FETCH_ERROR',

  // Pipeline Stages
  NORMALIZED: 'NORMALIZED',
  VALIDATED: 'VALIDATED',
  DEDUP_ACCEPTED: 'DEDUP_ACCEPTED',
  DEDUP_REJECTED: 'DEDUP_REJECTED',
  DB_INSERT_START: 'DB_INSERT_START',
  DB_INSERT_SUCCESS: 'DB_INSERT_SUCCESS',
  DB_INSERT_ERROR: 'DB_INSERT_ERROR',
  AI_QUEUE: 'AI_QUEUE',
  AI_STARTED: 'AI_STARTED',
  AI_COMPLETED: 'AI_COMPLETED',
  REALTIME_BROADCAST: 'REALTIME_BROADCAST',
  REALTIME_ERROR: 'REALTIME_ERROR',
  FRONTEND_SUBSCRIBED: 'FRONTEND_SUBSCRIBED',
  FRONTEND_EVENT_RECEIVED: 'FRONTEND_EVENT_RECEIVED',
  FRONTEND_EVENT_IGNORED: 'FRONTEND_EVENT_IGNORED',
  WAR_ROOM_INSERTED: 'WAR_ROOM_INSERTED'
};

export function logTraceEvent({
  stage,
  traceId,
  articleId,
  provider,
  timestamp = new Date().toISOString(),
  status = null,
  reason = null,
  durationMs = null,
  extra = {}
}) {
  const payload = {
    tag: 'VEE_TRACE',
    stage,
    traceId: traceId || `tr_${Date.now()}`,
    articleId: articleId || null,
    provider: provider || 'system',
    timestamp,
    ...(status ? { status } : {}),
    ...(reason ? { reason } : {}),
    ...(durationMs != null ? { durationMs } : {}),
    ...extra
  };

  console.log(`[TRACE:${stage}] ${JSON.stringify(payload)}`);
  return payload;
}

/**
 * Utility to mask credentials in URLs for logging
 */
export function maskUrlCredentials(rawUrl) {
  if (!rawUrl) return '';
  return rawUrl.replace(/(apikey|apiKey|api-key|key|token)=([^&]+)/gi, '$1=REDACTED');
}
