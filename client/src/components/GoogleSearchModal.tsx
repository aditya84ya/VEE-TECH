import React, { useEffect } from 'react';
import { X, ExternalLink, ShieldCheck, Search, Globe } from 'lucide-react';

interface GoogleSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialQuery?: string;
}

export const GoogleSearchModal: React.FC<GoogleSearchModalProps> = ({
  isOpen,
  onClose,
  initialQuery = ''
}) => {
  const cxId = 'c7b914ef13847465b';
  const publicUrl = `https://cse.google.com/cse?cx=${cxId}${initialQuery ? `&q=${encodeURIComponent(initialQuery)}` : ''}`;

  useEffect(() => {
    if (isOpen) {
      // Re-initialize Google Custom Search Engine elements inside DOM
      const timer = setTimeout(() => {
        try {
          if ((window as any).google?.search?.cse?.element?.go) {
            (window as any).google.search.cse.element.go();
          }
        } catch (e) {
          console.error('Failed to initialize Google CSE element:', e);
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="bg-white border border-slate-200 rounded-2xl max-w-3xl w-full p-6 space-y-5 shadow-2xl relative max-h-[90vh] flex flex-col">
        {/* Modal Header */}
        <div className="flex items-start justify-between border-b border-slate-100 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600 shadow-2xs">
              <Search className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-slate-900">
                  Google Programmable Search Engine
                </h3>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-blue-50 text-blue-700 border border-blue-200">
                  ID: {cxId}
                </span>
              </div>
              <p className="text-xs text-slate-500">
                On-demand real-time crisis threat corroboration & deep web intelligence search.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <a
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 transition-colors"
              title="Open standalone Google CSE in new tab"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Public CSE URL</span>
            </a>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700 p-1.5 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Embedded Google Custom Search Engine Widget */}
        <div className="flex-1 overflow-y-auto min-h-[360px] p-2 bg-slate-50/60 rounded-xl border border-slate-200/80">
          {/* Exact element requested by user */}
          <div className="gcse-search"></div>
        </div>

        {/* Footer info banner */}
        <div className="flex items-center justify-between text-xs text-slate-500 border-t border-slate-100 pt-3">
          <span className="flex items-center gap-1.5 text-[11px]">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>Connected to Search Engine <code className="font-mono text-slate-700">{cxId}</code></span>
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
