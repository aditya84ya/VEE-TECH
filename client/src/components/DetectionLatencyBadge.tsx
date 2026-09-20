import React, { useState } from 'react';
import { Clock, Info, ShieldCheck, AlertTriangle } from 'lucide-react';
import { calculateDetectionLatency, DetectionLatencyResult } from '../utils/detectionLatency';

interface DetectionLatencyBadgeProps {
  publishedAt?: string | null;
  detectedAt?: string | null;
  apiSource?: string | null;
  className?: string;
  variant?: 'card' | 'inline';
}

export const DetectionLatencyBadge: React.FC<DetectionLatencyBadgeProps> = ({
  publishedAt,
  detectedAt,
  apiSource,
  className = '',
  variant = 'card'
}) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const latency: DetectionLatencyResult = calculateDetectionLatency(publishedAt, detectedAt, apiSource);

  // Status color mappings
  let statusBadgeStyle = 'bg-slate-100 text-slate-600 border-slate-200';
  let valueColor = 'text-slate-900';
  let icon = <Clock className="w-3 h-3 text-slate-400" />;

  if (latency.status === 'WITHIN_TARGET') {
    statusBadgeStyle = 'bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold';
    valueColor = 'text-emerald-950';
    icon = <ShieldCheck className="w-3 h-3 text-emerald-600" />;
  } else if (latency.status === 'ABOVE_TARGET') {
    statusBadgeStyle = 'bg-amber-50 text-amber-700 border-amber-200 font-semibold';
    valueColor = 'text-amber-950';
    icon = <AlertTriangle className="w-3 h-3 text-amber-600" />;
  } else if (latency.status === 'ANOMALY') {
    statusBadgeStyle = 'bg-amber-50 text-amber-800 border-amber-300 font-semibold';
    valueColor = 'text-amber-900';
    icon = <AlertTriangle className="w-3 h-3 text-amber-600" />;
  }

  return (
    <div
      className={`relative inline-flex items-center cursor-pointer select-none group ${className}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onClick={() => setShowTooltip((prev) => !prev)}
      role="button"
      tabIndex={0}
      aria-label={`Detection latency: ${latency.formattedLatency}, Status: ${latency.statusText}`}
    >
      {variant === 'card' ? (
        <div className="flex flex-col bg-slate-50/90 hover:bg-slate-100/80 transition-colors border border-slate-200/90 rounded-lg px-2.5 py-1.5 shadow-2xs">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-500">
            {icon}
            <span>{latency.metricLabel}</span>
            <Info className="w-3 h-3 text-slate-400 opacity-60 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className={`text-[15px] sm:text-[16px] font-bold font-mono tracking-tight leading-tight ${valueColor}`}>
              {latency.formattedLatency}
            </span>
            <span className={`text-[10px] font-mono tracking-wide px-1.5 py-0.5 rounded border ${statusBadgeStyle}`}>
              {latency.statusBadgeText}
            </span>
          </div>
        </div>
      ) : (
        /* Inline compact version */
        <div className="inline-flex items-center gap-2 bg-slate-50 hover:bg-slate-100/90 transition-colors border border-slate-200/80 rounded-md px-2 py-1 text-xs shadow-2xs">
          <span className="text-[12px] font-semibold text-slate-500">Latency:</span>
          <span className={`text-[14px] font-bold font-mono ${valueColor}`}>
            {latency.formattedLatency}
          </span>
          <span className={`text-[10px] font-mono tracking-wide px-1.5 py-0.5 rounded border ${statusBadgeStyle}`}>
            {latency.statusBadgeText}
          </span>
        </div>
      )}

      {/* Audit Tooltip Popover */}
      {showTooltip && (
        <div
          className="absolute bottom-full left-0 mb-2 z-50 w-72 p-3 bg-slate-900 text-white rounded-xl shadow-xl border border-slate-700 text-xs font-sans space-y-2 pointer-events-none animate-in fade-in zoom-in-95 duration-150"
          style={{ minWidth: '260px' }}
        >
          <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
            <span className="font-semibold text-slate-300 flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-rose-400" />
              Timing Audit Log
            </span>
            <span className="text-[10px] font-mono text-slate-400">UTC TIMESTAMPS</span>
          </div>

          <div className="space-y-1.5 pt-0.5 text-[11px]">
            <div>
              <div className="text-slate-400 text-[10px] font-medium uppercase tracking-wider">Published</div>
              <div className="font-mono text-slate-200 font-semibold">{latency.publishedUtc || 'Unavailable'}</div>
            </div>

            {latency.providerAvailableUtc && (
              <div>
                <div className="text-slate-400 text-[10px] font-medium uppercase tracking-wider">Provider Available</div>
                <div className="font-mono text-slate-200 font-semibold">{latency.providerAvailableUtc}</div>
              </div>
            )}

            <div>
              <div className="text-slate-400 text-[10px] font-medium uppercase tracking-wider">Detected by VEE-ALERT</div>
              <div className="font-mono text-slate-200 font-semibold">{latency.detectedUtc || 'Unavailable'}</div>
            </div>

            <div className="pt-1 border-t border-slate-800 grid grid-cols-2 gap-2">
              <div>
                <div className="text-slate-400 text-[10px] font-medium uppercase tracking-wider">{latency.metricLabel}</div>
                <div className="font-mono text-slate-100 font-bold text-[13px]">{latency.formattedLatency}</div>
              </div>
              <div>
                <div className="text-slate-400 text-[10px] font-medium uppercase tracking-wider">Target</div>
                <div className="font-mono text-slate-300 font-bold text-[13px]">{latency.targetText}</div>
              </div>
            </div>

            <div className="pt-1 border-t border-slate-800 flex items-center justify-between">
              <span className="text-slate-400 text-[10px] uppercase font-medium">Status</span>
              <span
                className={`font-mono text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                  latency.status === 'WITHIN_TARGET'
                    ? 'bg-emerald-950/80 text-emerald-400 border-emerald-700'
                    : latency.status === 'ABOVE_TARGET'
                    ? 'bg-amber-950/80 text-amber-400 border-amber-700'
                    : 'bg-slate-800 text-slate-300 border-slate-600'
                }`}
              >
                {latency.statusText}
              </span>
            </div>
          </div>

          <div className="text-[9px] text-slate-400 pt-1 border-t border-slate-800/80 text-center font-mono">
            Calculated from immutable origin timestamps
          </div>
        </div>
      )}
    </div>
  );
};
