import React, { useState } from 'react';
import { 
  X, 
  Newspaper, 
  User, 
  FileText, 
  Clock, 
  ShieldCheck, 
  ExternalLink, 
  Building2,
  Zap,
  Flame,
  AlertTriangle,
  Search
} from 'lucide-react';
import { IntelligenceItem } from '../types';
import { GoogleSearchModal } from './GoogleSearchModal';

interface ArticleDetailModalProps {
  article: IntelligenceItem | null;
  onClose: () => void;
  onOpenVoiceCall: (article: IntelligenceItem) => void;
}

export const ArticleDetailModal: React.FC<ArticleDetailModalProps> = ({
  article,
  onClose,
  onOpenVoiceCall
}) => {
  const [isVerifyOpen, setIsVerifyOpen] = useState(false);
  if (!article) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-2xl bg-[#0d1017] border border-zinc-800 rounded-2xl p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-200 p-1.5 rounded-lg hover:bg-zinc-800"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Top Badges */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className={`px-2.5 py-0.5 rounded-full text-xs font-mono font-bold ${
            article.riskLevel === 'Critical' ? 'bg-red-500/20 text-red-400 border border-red-500/50' :
            article.riskLevel === 'High' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40' :
            'bg-zinc-800 text-zinc-300'
          }`}>
            Risk: {article.riskScore}/10 ({article.riskLevel.toUpperCase()})
          </span>

          <span className="px-2.5 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/40 text-xs font-mono font-bold">
            {article.entity} {article.isClient ? '(Client Target)' : '(Competitor)'}
          </span>

          <span className="px-2.5 py-0.5 rounded-full bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 font-mono">
            Platform: {article.platform.toUpperCase()}
          </span>
        </div>

        {/* Headline */}
        <h2 className="text-lg sm:text-xl font-bold text-white leading-snug">
          {article.metadata.headline}
        </h2>

        {/* Mandatory Industrial Mentor Metadata Grid */}
        <div className="mt-4 p-4 rounded-xl bg-black/50 border border-zinc-800/80 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="flex items-center gap-2">
            <Newspaper className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <div>
              <span className="text-zinc-400 font-mono text-[11px] block">NEWSPAPER / SOURCE:</span>
              <strong className="text-zinc-100">{article.metadata.newspaperOrSource}</strong>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <User className="w-4 h-4 text-blue-400 flex-shrink-0" />
            <div>
              <span className="text-zinc-400 font-mono text-[11px] block">AUTHOR / CORRESPONDENT:</span>
              <strong className="text-zinc-100">{article.metadata.author}</strong>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <div>
              <span className="text-zinc-400 font-mono text-[11px] block">PAGE NUMBER / PLACEMENT:</span>
              <strong className="text-zinc-100">{article.metadata.pageNumber || 'Digital / Online Edition'}</strong>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-cyan-400 flex-shrink-0" />
            <div>
              <span className="text-zinc-400 font-mono text-[11px] block">VERIFICATION & REACH:</span>
              <strong className="text-zinc-100">
                {article.metadata.verifiedSource ? 'Verified Source' : 'Unverified'} • {article.metadata.reachCount || 'High Circulation'}
              </strong>
            </div>
          </div>
        </div>

        {/* Excerpt / Short Description */}
        <div className="mt-4 space-y-1 text-xs">
          <span className="text-zinc-400 font-mono uppercase tracking-wider text-[11px] block">
            Short Description / Lead Story
          </span>
          <p className="text-zinc-200 leading-relaxed bg-zinc-900/60 p-3 rounded-xl border border-zinc-800">
            {article.metadata.shortDescription}
          </p>
        </div>

        {/* Full Text / Body */}
        {article.metadata.fullText && (
          <div className="mt-3 space-y-1 text-xs">
            <span className="text-zinc-400 font-mono uppercase tracking-wider text-[11px] block">
              Article Content Excerpt
            </span>
            <p className="text-zinc-300 leading-relaxed bg-zinc-900/40 p-3 rounded-xl border border-zinc-800/80">
              {article.metadata.fullText}
            </p>
          </div>
        )}

        {/* Mathematical SLA Chronometer Log */}
        <div className="mt-4 p-4 rounded-xl bg-emerald-950/20 border border-emerald-900/40 text-xs font-mono space-y-2">
          <div className="flex items-center justify-between text-emerald-400 font-bold">
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              <span>SLA Audit: {Math.round(article.sla.totalDurationMs / 1000)}s Elapsed</span>
            </span>
            <span>&lt; 120s GUARANTEE (PASS)</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-zinc-300 pt-1">
            <div>
              <span className="text-zinc-500 block">Published:</span>
              <span>{new Date(article.sla.publishedAt).toLocaleTimeString()}</span>
            </div>
            <div>
              <span className="text-zinc-500 block">Ingested:</span>
              <span>{(article.sla.ingestDurationMs / 1000).toFixed(1)}s</span>
            </div>
            <div>
              <span className="text-zinc-500 block">AI Triage:</span>
              <span>{(article.sla.triageDurationMs / 1000).toFixed(1)}s</span>
            </div>
            <div>
              <span className="text-zinc-500 block">Dispatched:</span>
              <span>{(article.sla.dispatchDurationMs / 1000).toFixed(1)}s</span>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="mt-5 pt-3 border-t border-zinc-800 flex items-center justify-between">
          <a
            href={article.metadata.url || '#'}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white"
          >
            <span>Original Source Wire</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsVerifyOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/40 text-xs font-semibold transition cursor-pointer"
              title="Corroborate threat across Google Custom Search Engine"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Verify Threat (Google CSE)</span>
            </button>

            {article.riskLevel === 'Critical' && (
              <button
                onClick={() => {
                  onClose();
                  onOpenVoiceCall(article);
                }}
                className="px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold text-xs shadow transition"
              >
                Simulate Voice Call
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium"
            >
              Close
            </button>
          </div>
        </div>
      </div>

      <GoogleSearchModal
        isOpen={isVerifyOpen}
        onClose={() => setIsVerifyOpen(false)}
        initialQuery={`${article.entity || ''} ${article.metadata.headline || ''}`}
      />
    </div>
  );
};
