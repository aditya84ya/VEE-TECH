import React, { useState } from 'react';
import { X, ExternalLink, PhoneCall, Check, Clock, Newspaper, ShieldAlert, Search } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Article } from '../hooks/useWarRoom';
import { DetectionLatencyBadge } from './DetectionLatencyBadge';
import { ArticleLifecycleTimeline } from './ArticleLifecycleTimeline';
import { GoogleSearchModal } from './GoogleSearchModal';

interface ArticleModalProps {
  article: Article | null;
  onClose: () => void;
  onAcknowledge: (id: string) => void;
  onEscalateVoice: (article: Article) => void;
}

export const ArticleModal: React.FC<ArticleModalProps> = ({
  article,
  onClose,
  onAcknowledge,
  onEscalateVoice
}) => {
  const [isVerifyOpen, setIsVerifyOpen] = useState(false);
  if (!article) return null;

  const isCritical = article.risk_level === 'Critical' || (article as any).severity === 'CRITICAL' || (Number(article.risk_score || (article as any).score) >= 9.0);
  const isHigh = !isCritical && (article.risk_level === 'High' || (article as any).severity === 'HIGH' || (Number(article.risk_score || (article as any).score) >= 7.0));
  const isAcknowledged = article.status === 'ACKNOWLEDGED';

  let relativeTime = 'Just now';
  try {
    relativeTime = formatDistanceToNow(new Date(article.published_at || article.ingested_at), {
      addSuffix: true
    });
  } catch {
    relativeTime = 'Recent';
  }

  const scoreValue = article.risk_score
    ? article.risk_score > 10
      ? (article.risk_score / 10).toFixed(1)
      : article.risk_score.toFixed(1)
    : (article as any).score
    ? Number((article as any).score).toFixed(1)
    : isCritical
    ? '9.8'
    : isHigh
    ? '7.5'
    : '5.0';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full p-6 space-y-5 shadow-2xl relative max-h-[90vh] overflow-y-auto">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-700 p-1.5 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Top Badges */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`px-2.5 py-0.5 rounded text-xs font-bold font-mono tracking-wide ${
              isCritical
                ? 'bg-rose-50 text-rose-600 border border-rose-200'
                : isHigh
                ? 'bg-amber-50 text-amber-700 border border-amber-200'
                : 'bg-slate-100 text-slate-700 border border-slate-200'
            }`}
          >
            {(isCritical ? 'CRITICAL' : isHigh ? 'HIGH' : (article.risk_level?.toUpperCase() || 'MEDIUM'))} {scoreValue}/10
          </span>

          <span className="px-2.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-800 text-xs font-bold font-mono">
            Target: {article.entity_mentioned || 'Infosys'}
          </span>

          <span className="px-2.5 py-0.5 rounded bg-slate-50 border border-slate-200 text-slate-600 text-xs font-medium">
            Sentiment: <strong className="text-slate-900">{article.sentiment || 'Neutral'}</strong>
          </span>

          {isAcknowledged && (
            <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-50 border border-emerald-200 text-emerald-700 font-mono">
              ACKNOWLEDGED
            </span>
          )}
        </div>

        {/* Headline */}
        <div>
          <h2 className="text-xl font-bold text-slate-900 leading-snug font-sans">
            {article.title}
          </h2>
          <div className="flex items-center gap-3 text-xs text-slate-400 mt-2 flex-wrap">
            <span className="flex items-center gap-1 font-semibold text-slate-600">
              <Newspaper className="w-3.5 h-3.5" />
              {article.source_name || 'News Wire'}
            </span>
            <span className="px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500 text-[10px] uppercase font-bold tracking-wider border border-slate-200">
              via {article.api_source || 'Google RSS'}
            </span>
            {((article.api_source || '').toLowerCase().includes('manual')) && (
              <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 text-[10px] uppercase font-bold tracking-wider border border-purple-300 shadow-2xs">
                MANUAL UPLOAD
              </span>
            )}
            <span>•</span>
            <span className="flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" />
              {article.published_at ? relativeTime : 'Publish date unknown'}
            </span>
          </div>

          {/* Detection Latency Section */}
          <div className="pt-2">
            <DetectionLatencyBadge
              publishedAt={article.published_at}
              detectedAt={article.ingested_at}
              apiSource={article.api_source}
            />
          </div>
        </div>

        {/* 5-Bullet Intelligence Brief */}
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 font-mono">
            Executive 5-Bullet Intelligence Brief
          </h3>
          <ul className="space-y-1.5 text-sm text-slate-700 list-disc list-inside marker:text-rose-500 leading-relaxed">
            {Array.isArray(article.five_bullet_summary) && article.five_bullet_summary.length > 0 ? (
              article.five_bullet_summary.map((b, i) => (
                <li key={i} className="pl-1">
                  <span>{b}</span>
                </li>
              ))
            ) : (
              <li className="text-slate-500 italic">
                {article.raw_content || 'Real-time telemetry event processed by local Qwen 2.5 triage engine.'}
              </li>
            )}
          </ul>

          {/* Article Lifecycle Timeline */}
          <ArticleLifecycleTimeline
            publishedAt={article.published_at}
            detectedAt={article.ingested_at}
            triagedAt={article.triaged_at}
            dispatchedAt={article.dispatched_at || article.alerted_at}
          />
        </div>

        {/* Full Raw Content Extract */}
        {article.raw_content && (
          <div className="space-y-1.5">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 font-mono">
              Raw Feed Transcript
            </h4>
            <p className="text-xs text-slate-600 bg-slate-50 p-3.5 rounded-lg border border-slate-200 leading-relaxed max-h-36 overflow-y-auto">
              {article.raw_content}
            </p>
          </div>
        )}

        {/* Actions Bottom Row */}
        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div>
            {article.url ? (
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-rose-600 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                <span>Open Primary Source</span>
              </a>
            ) : (
              <span className="text-xs text-slate-400">No external source URL</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsVerifyOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 transition-all cursor-pointer"
              title="Corroborate article against Google Custom Search Engine"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Verify Threat (Google CSE)</span>
            </button>

            {!isAcknowledged ? (
              <button
                onClick={() => {
                  onAcknowledge(article.id);
                  onClose();
                }}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-700 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 shadow-2xs transition-all cursor-pointer"
              >
                <Check className="w-3.5 h-3.5 text-slate-500" />
                <span>Acknowledge</span>
              </button>
            ) : (
              <span className="flex items-center gap-1 text-xs text-emerald-600 font-semibold font-mono">
                <Check className="w-3.5 h-3.5" /> Resolved
              </span>
            )}

            <button
              onClick={() => {
                onClose();
                onEscalateVoice(article);
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 shadow-sm transition-all cursor-pointer"
            >
              <PhoneCall className="w-3.5 h-3.5" />
              <span>Escalate Voice Call</span>
            </button>
          </div>
        </div>
      </div>

      <GoogleSearchModal
        isOpen={isVerifyOpen}
        onClose={() => setIsVerifyOpen(false)}
        initialQuery={`${article.entity_mentioned || ''} ${article.title || ''}`}
      />
    </div>
  );
};
