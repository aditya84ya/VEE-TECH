import React from 'react';
import { Clock, ShieldCheck, AlertTriangle } from 'lucide-react';
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
  const latency: DetectionLatencyResult = calculateDetectionLatency(publishedAt, detectedAt, apiSource);

  // Status color mappings
  let valueColor = 'text-slate-900';
  let icon = <Clock className="w-3 h-3 text-slate-400" />;

  if (latency.status === 'WITHIN_TARGET') {
    valueColor = 'text-emerald-950';
    icon = <ShieldCheck className="w-3 h-3 text-emerald-600" />;
  } else if (latency.status === 'ABOVE_TARGET') {
    valueColor = 'text-amber-950';
    icon = <AlertTriangle className="w-3 h-3 text-amber-600" />;
  } else if (latency.status === 'ANOMALY') {
    valueColor = 'text-amber-900';
    icon = <AlertTriangle className="w-3 h-3 text-amber-600" />;
  }

  return (
    <div
      className={`relative inline-flex items-center select-none ${className}`}
      aria-label={`Detection latency: ${latency.formattedLatency}, Status: ${latency.statusText}`}
    >
      {variant === 'card' ? (
        <div className="flex flex-col bg-slate-50/90 border border-slate-200/90 rounded-lg px-2.5 py-1.5 shadow-2xs">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-500">
            {icon}
            <span>{latency.metricLabel}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className={`text-[15px] sm:text-[16px] font-bold font-mono tracking-tight leading-tight ${valueColor}`}>
              {latency.formattedLatency}
            </span>
          </div>
        </div>
      ) : (
        /* Inline compact version */
        <div className="inline-flex items-center gap-2 bg-slate-50 border border-slate-200/80 rounded-md px-2 py-1 text-xs shadow-2xs">
          <span className="text-[12px] font-semibold text-slate-500">Latency:</span>
          <span className={`text-[14px] font-bold font-mono ${valueColor}`}>
            {latency.formattedLatency}
          </span>
        </div>
      )}
    </div>
  );
};
