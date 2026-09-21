import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  UploadCloud,
  FileText,
  Image as ImageIcon,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Calendar,
  Building2,
  Hash,
  ArrowRight,
  Clock,
  Sparkles,
  ShieldAlert,
  Copy,
  Check,
  ExternalLink,
  RotateCcw,
  X,
  FileUp,
  Info
} from 'lucide-react';
import { Article } from '../hooks/useWarRoom';
import { useWarRoom } from '../hooks/useWarRoom';

interface OcrUploadResult {
  article: Article;
  ocr: {
    extractedText: string;
    confidence: number;
    characterCount: number;
  };
  triage: {
    entity: string;
    sentiment: string;
    risk_score: number;
    risk_level: string;
    five_bullet_summary: string[];
    theme: string;
  };
  historical: boolean;
}

type Stage = 'idle' | 'uploading' | 'ocr' | 'triage' | 'completed' | 'error';

export const ManualUploadView: React.FC = () => {
  const navigate = useNavigate();
  const { fetchArticles } = useWarRoom();

  const [dragActive, setDragActive] = useState<boolean>(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Form inputs
  const [publicationName, setPublicationName] = useState<string>('');
  const [pageNumber, setPageNumber] = useState<string>('');
  const [publishDate, setPublishDate] = useState<string>('');
  const [isHistorical, setIsHistorical] = useState<boolean>(true);

  // Stage & Progress
  const [stage, setStage] = useState<Stage>('idle');
  const [stageMessage, setStageMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<OcrUploadResult | null>(null);

  // Headline & summary inline expanders
  const [isHeadlineExpanded, setIsHeadlineExpanded] = useState<boolean>(false);
  const [isSummaryExpanded, setIsSummaryExpanded] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isTakingLonger, setIsTakingLonger] = useState<boolean>(false);
  const ocrTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const clearAllTimers = () => {
    if (ocrTimerRef.current) {
      clearTimeout(ocrTimerRef.current);
      ocrTimerRef.current = null;
    }
    if (triageTimerRef.current) {
      clearTimeout(triageTimerRef.current);
      triageTimerRef.current = null;
    }
    if (timeoutTimerRef.current) {
      clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearAllTimers();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const handleFileSelect = (file: File) => {
    // Validate file type
    const validTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/bmp',
      'application/pdf'
    ];
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name);

    if (!isPdf && !isImage && !validTypes.includes(file.type)) {
      setErrorMessage('Unsupported file format. Please upload a JPG, PNG, WEBP image or a PDF document.');
      return;
    }

    // Size limit: 25MB
    const maxSize = 25 * 1024 * 1024;
    if (file.size > maxSize) {
      setErrorMessage(`File exceeds 25MB limit (${(file.size / (1024 * 1024)).toFixed(1)}MB). Please choose a smaller file.`);
      return;
    }

    clearAllTimers();
    setSelectedFile(file);
    setErrorMessage(null);
    setUploadResult(null);
    setStage('idle');
    setIsTakingLonger(false);

    if (isImage) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
    } else {
      setPreviewUrl(null);
    }
  };

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  }, []);

  const handleReset = () => {
    clearAllTimers();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsTakingLonger(false);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setSelectedFile(null);
    setPreviewUrl(null);
    setPublicationName('');
    setPageNumber('');
    setPublishDate('');
    setIsHistorical(true);
    setStage('idle');
    setStageMessage('');
    setErrorMessage(null);
    setUploadResult(null);
    setIsHeadlineExpanded(false);
    setIsSummaryExpanded(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleCancelProcessing = () => {
    clearAllTimers();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setStage('idle');
    setStageMessage('');
    setIsTakingLonger(false);
    setErrorMessage('Processing was canceled by user.');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setErrorMessage('Please select or drop an image or PDF file to proceed.');
      return;
    }

    clearAllTimers();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setErrorMessage(null);
    setUploadResult(null);
    setIsTakingLonger(false);

    // 1. Uploading stage
    setStage('uploading');
    setStageMessage('Uploading document buffer to secure memory...');

    const formData = new FormData();
    formData.append('file', selectedFile);
    if (publicationName.trim()) {
      formData.append('publication_name', publicationName.trim());
    }
    if (pageNumber.trim()) {
      formData.append('page_number', pageNumber.trim());
    }
    if (publishDate.trim()) {
      formData.append('published_at', publishDate.trim());
    }
    formData.append('is_historical', isHistorical ? 'true' : 'false');

    // Progress indicators while request is in flight
    ocrTimerRef.current = setTimeout(() => {
      setStage((prev) => (prev === 'uploading' ? 'ocr' : prev));
      setStageMessage('Extracting text via Tesseract OCR engine...');
    }, 800);

    triageTimerRef.current = setTimeout(() => {
      setStage((prev) => (prev === 'ocr' || prev === 'uploading' ? 'triage' : prev));
      setStageMessage('Analyzing corporate impact & running local AI triage...');
    }, 3500);

    // Alert if processing exceeds 45 seconds
    timeoutTimerRef.current = setTimeout(() => {
      setIsTakingLonger(true);
    }, 45000);

    try {
      const response = await axios.post('/api/manual-upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        },
        timeout: 90000,
        signal: controller.signal
      });

      clearAllTimers();
      setIsTakingLonger(false);

      if (response.data && response.data.success) {
        setStage('completed');
        setStageMessage('Done. Intelligence triaged and committed.');
        setUploadResult(response.data);

        // Immediately trigger global articles refresh so other views update
        try {
          fetchArticles(false);
        } catch (_) {}
      } else {
        setStage('error');
        setErrorMessage(response.data?.error || 'Failed to process document');
      }
    } catch (err: any) {
      clearAllTimers();
      setIsTakingLonger(false);
      setStage('error');

      if (axios.isCancel(err) || err.name === 'CanceledError') {
        setErrorMessage('Processing was canceled.');
      } else if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        setErrorMessage('Processing timed out after 90 seconds. The document may be too large or the AI engine took too long to respond.');
      } else {
        const apiError = err.response?.data?.error || err.message;
        setErrorMessage(apiError || 'An unexpected error occurred during processing.');
      }
    } finally {
      clearAllTimers();
    }
  };



  const isProcessing = stage === 'uploading' || stage === 'ocr' || stage === 'triage';

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      {/* Header Banner */}
      <div className="bg-white rounded-2xl border border-slate-200/90 p-6 sm:p-8 shadow-2xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-xl bg-purple-50 border border-purple-200 flex items-center justify-center text-purple-600 shadow-2xs">
                <FileUp className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
                  Manual Intel Upload
                </h1>
                <p className="text-xs sm:text-sm text-slate-500">
                  Scanned newspaper clippings, e-paper pages & screenshots → Instant OCR → AI Triage → DB.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/crisis')}
              className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 flex items-center gap-1.5 shadow-2xs transition-colors cursor-pointer"
            >
              <span>Back to Crisis Feed</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Upload Form Container */}
      {!uploadResult && (
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-slate-200/90 p-6 sm:p-8 shadow-2xs space-y-6">
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Document Upload &amp; Metadata
              </h2>
              <p className="text-xs text-slate-500">
                Original media files are processed in memory and deleted immediately. Only extracted structured intelligence is stored.
              </p>
            </div>

            {/* Dropzone Container */}
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-6 sm:p-8 text-center transition-all cursor-pointer select-none ${
                dragActive
                  ? 'border-purple-500 bg-purple-50/50'
                  : selectedFile
                  ? 'border-emerald-300 bg-emerald-50/30'
                  : 'border-slate-300 hover:border-purple-400 bg-slate-50/50 hover:bg-purple-50/20'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,image/bmp,application/pdf"
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handleFileSelect(e.target.files[0]);
                  }
                }}
                className="hidden"
              />

              {selectedFile ? (
                <div className="flex flex-col items-center gap-3">
                  {previewUrl ? (
                    <div className="relative group/thumb">
                      <img
                        src={previewUrl}
                        alt="Preview"
                        className="max-h-48 max-w-xs object-contain rounded-xl shadow-md border border-slate-200"
                      />
                      <span className="absolute -top-2 -right-2 bg-slate-900 text-white p-1 rounded-full text-xs shadow">
                        <ImageIcon className="w-3.5 h-3.5" />
                      </span>
                    </div>
                  ) : (
                    <div className="w-20 h-20 rounded-2xl bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-600 shadow-sm">
                      <FileText className="w-10 h-10" />
                    </div>
                  )}

                  <div className="space-y-1">
                    <p className="text-sm font-bold text-slate-900 flex items-center justify-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      {selectedFile.name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB • {selectedFile.type || 'Document'}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReset();
                    }}
                    className="mt-2 text-xs font-semibold text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 px-3 py-1 rounded-md transition-colors"
                  >
                    Change file
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-14 h-14 rounded-2xl bg-purple-50 border border-purple-100 flex items-center justify-center text-purple-600 group-hover:scale-110 transition-transform">
                    <UploadCloud className="w-7 h-7" />
                  </div>
                  <div>
                    <p className="text-sm sm:text-base font-bold text-slate-800">
                      Drop an e-paper page, screenshot, or scanned article here
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      or click to browse from your computer (JPG, PNG, WEBP, PDF up to 25MB)
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Optional Metadata Fields Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
              {/* Publication Name */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-slate-400" />
                  Publication name (optional)
                </label>
                <input
                  type="text"
                  value={publicationName}
                  onChange={(e) => setPublicationName(e.target.value)}
                  placeholder="e.g. The Economic Times, Mint"
                  className="w-full h-9 px-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-purple-400 focus:border-purple-400"
                />
              </div>

              {/* Page Number */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <Hash className="w-3.5 h-3.5 text-slate-400" />
                  Page number (optional)
                </label>
                <input
                  type="text"
                  value={pageNumber}
                  onChange={(e) => setPageNumber(e.target.value)}
                  placeholder="e.g. Page 1, Front Page, B4"
                  className="w-full h-9 px-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-purple-400 focus:border-purple-400"
                />
              </div>

              {/* Publish Date */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-slate-400" />
                  Publish date (optional)
                </label>
                <input
                  type="date"
                  value={publishDate}
                  onChange={(e) => setPublishDate(e.target.value)}
                  className="w-full h-9 px-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-purple-400 focus:border-purple-400"
                />
                <p className="text-[10px] text-slate-400">
                  Leave blank if unknown (will show as &ldquo;Publish date unknown&rdquo;)
                </p>
              </div>
            </div>

            {/* Historical Research Toggle */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 flex items-start gap-3">
              <input
                id="historical-toggle"
                type="checkbox"
                checked={isHistorical}
                onChange={(e) => setIsHistorical(e.target.checked)}
                className="mt-0.5 w-4 h-4 text-purple-600 rounded border-slate-300 focus:ring-purple-500 cursor-pointer"
              />
              <div className="space-y-0.5">
                <label htmlFor="historical-toggle" className="text-xs font-bold text-slate-900 cursor-pointer">
                  This is historical research, not a live alert
                </label>
                <p className="text-[11px] text-slate-500">
                  When enabled, skips automated crisis telephony calls, Slack, or WhatsApp dispatch as if it were breaking news. Recommended for newspaper archive backfills.
                </p>
              </div>
            </div>

            {/* Taking Longer Banner */}
            {isTakingLonger && isProcessing && (
              <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-amber-900 animate-in fade-in">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-amber-600 shrink-0" />
                  <span className="font-semibold">
                    This is taking longer than expected (large document or AI model under load)...
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={(e) => handleSubmit(e)}
                    className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-bold text-[11px] transition-colors cursor-pointer"
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelProcessing}
                    className="px-2.5 py-1 rounded bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 font-bold text-[11px] transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Error / Guardrail Message Alert */}
            {errorMessage && (
              <div
                className={`p-4 rounded-xl border flex items-start gap-3 text-xs animate-in fade-in ${
                  errorMessage.toLowerCase().includes('no tracked company')
                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                    : 'bg-rose-50 border-rose-200 text-rose-800'
                }`}
              >
                <AlertTriangle
                  className={`w-4 h-4 shrink-0 mt-0.5 ${
                    errorMessage.toLowerCase().includes('no tracked company') ? 'text-amber-600' : 'text-rose-600'
                  }`}
                />
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="font-bold">
                      {errorMessage.toLowerCase().includes('no tracked company')
                        ? 'Extraction / Guardrail Notice'
                        : 'Processing Notice'}
                    </p>
                    <span className="px-1.5 py-0.2 rounded bg-amber-200/80 text-amber-900 text-[10px] font-mono font-bold">
                      TERMINATED
                    </span>
                  </div>
                  <p className="font-medium leading-relaxed">{errorMessage}</p>
                  {errorMessage.toLowerCase().includes('no tracked company') && (
                    <p className="text-[11px] text-amber-700 pt-0.5">
                      Text extraction completed. Because no monitored corporate entities (Infosys, TCS, Wipro, Accenture) were identified, AI triage (Stage 3 &amp; 4) was safely stopped.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Live Multi-Stage Status Indicator (shown ONLY while actively processing) */}
            {isProcessing && (
              <div className="p-6 rounded-xl bg-purple-50/60 border border-purple-200 space-y-4 animate-in fade-in">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-bold text-purple-900">
                    <Loader2 className="w-4 h-4 text-purple-600 animate-spin" />
                    <span>{stageMessage}</span>
                  </div>
                  <span className="text-xs font-mono text-purple-700 uppercase font-semibold">
                    Processing
                  </span>
                </div>

                {/* Progress Stepper */}
                <div className="grid grid-cols-4 gap-2 text-xs">
                  {/* Step 1 */}
                  <div
                    className={`p-2.5 rounded-lg border text-center transition-colors ${
                      stage === 'uploading'
                        ? 'bg-purple-100 border-purple-300 text-purple-900 font-bold shadow-xs'
                        : stage === 'ocr' || stage === 'triage'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : 'bg-white border-slate-200 text-slate-400'
                    }`}
                  >
                    <div className="text-[10px] font-bold uppercase mb-0.5">Stage 1</div>
                    <div>Uploading...</div>
                  </div>

                  {/* Step 2 */}
                  <div
                    className={`p-2.5 rounded-lg border text-center transition-colors ${
                      stage === 'ocr'
                        ? 'bg-purple-100 border-purple-300 text-purple-900 font-bold shadow-xs'
                        : stage === 'triage'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : 'bg-white border-slate-200 text-slate-400'
                    }`}
                  >
                    <div className="text-[10px] font-bold uppercase mb-0.5">Stage 2</div>
                    <div>Extracting (OCR)...</div>
                  </div>

                  {/* Step 3 */}
                  <div
                    className={`p-2.5 rounded-lg border text-center transition-colors ${
                      stage === 'triage'
                        ? 'bg-purple-100 border-purple-300 text-purple-900 font-bold shadow-xs'
                        : 'bg-white border-slate-200 text-slate-400'
                    }`}
                  >
                    <div className="text-[10px] font-bold uppercase mb-0.5">Stage 3</div>
                    <div>Analyzing (AI triage)...</div>
                  </div>

                  {/* Step 4 */}
                  <div className="p-2.5 rounded-lg border text-center bg-white border-slate-200 text-slate-400">
                    <div className="text-[10px] font-bold uppercase mb-0.5">Stage 4</div>
                    <div>Done</div>
                  </div>
                </div>
              </div>
            )}

            {/* Submit Button */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleReset}
                disabled={isProcessing}
                className="px-4 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer"
              >
                Clear
              </button>

              <button
                type="submit"
                disabled={!selectedFile || isProcessing}
                className="px-6 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold flex items-center gap-2 shadow-sm transition-all disabled:opacity-50 cursor-pointer"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Processing Document...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Run OCR &amp; AI Triage</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* FULL INLINE RESULT CARD (Rendered after successful completion) */}
      {uploadResult && (
        <div className="space-y-6 animate-in fade-in zoom-in-95 duration-200">
          {/* Success Banner */}
          <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-between text-xs text-emerald-800 font-semibold">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>
                Document successfully processed. Original file deleted from memory. Structured intelligence saved to database.
              </span>
            </div>
            <button
              onClick={handleReset}
              className="text-emerald-700 hover:text-emerald-900 font-bold underline cursor-pointer"
            >
              Upload Another
            </button>
          </div>

          {/* Unified Crisis War Room Card Representation */}
          <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
            {/* Top Card Header */}
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  {/* MANUAL UPLOAD BADGE */}
                  <span className="px-2 py-0.5 rounded bg-purple-100 text-purple-800 text-[10px] uppercase font-bold tracking-wider border border-purple-300 shadow-2xs">
                    MANUAL UPLOAD
                  </span>

                  {/* Publication & Page */}
                  <span className="font-semibold text-slate-800 text-sm">
                    {uploadResult.article.source_name || 'Manual Upload'}
                  </span>

                  {/* Target Company */}
                  <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-800 text-[11px] font-bold border border-slate-200">
                    Target: {uploadResult.article.entity_mentioned || 'Infosys'}
                  </span>

                  {/* Sentiment */}
                  <span className="px-2 py-0.5 rounded bg-slate-50 text-slate-600 text-[11px] font-medium border border-slate-200">
                    Sentiment: <strong>{uploadResult.article.sentiment || 'Neutral'}</strong>
                  </span>

                  {/* OCR Confidence Badge */}
                  {uploadResult.ocr.confidence > 0 && (
                    <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-[11px] font-mono font-semibold border border-blue-200">
                      OCR Confidence: {uploadResult.ocr.confidence.toFixed(1)}%
                    </span>
                  )}
                </div>

                {/* Risk Level Badge */}
                <div className="flex items-center gap-2">
                  <span
                    className={`px-3 py-1 rounded-lg text-xs font-bold font-mono tracking-wide border ${
                      uploadResult.article.risk_level === 'Critical'
                        ? 'bg-rose-50 text-rose-700 border-rose-200'
                        : uploadResult.article.risk_level === 'High'
                        ? 'bg-amber-50 text-amber-700 border-amber-200'
                        : 'bg-slate-100 text-slate-700 border-slate-200'
                    }`}
                  >
                    {uploadResult.article.risk_level?.toUpperCase()} {uploadResult.article.risk_score?.toFixed(1)}/10
                  </span>
                </div>
              </div>

              {/* Publication Date Metadata Row */}
              <div className="flex items-center gap-3 text-xs text-slate-400">
                <span className="flex items-center gap-1 text-slate-600 font-medium">
                  <Clock className="w-3.5 h-3.5 text-slate-400" />
                  {uploadResult.article.published_at ? (
                    <span>Published: {new Date(uploadResult.article.published_at).toLocaleDateString()}</span>
                  ) : (
                    <span>Publish date unknown</span>
                  )}
                </span>
                <span>•</span>
                <span>Ingested: Just now</span>
                {uploadResult.historical && (
                  <>
                    <span>•</span>
                    <span className="text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded text-[10px] font-medium border border-amber-200">
                      Historical Research (Live dispatch skipped)
                    </span>
                  </>
                )}
              </div>

              {/* Headline with interactive toggle */}
              <div>
                {(() => {
                  const titleText = (uploadResult.article.title || '').trim();
                  const charLimit = 90;
                  const isLong = titleText.length > charLimit;
                  const displayTitle = isLong && !isHeadlineExpanded ? `${titleText.substring(0, charLimit)}...` : titleText;

                  return (
                    <h3 className="font-bold text-lg text-black leading-snug">
                      <span>{displayTitle}</span>
                      {isLong && (
                        <button
                          type="button"
                          onClick={() => setIsHeadlineExpanded(!isHeadlineExpanded)}
                          className="ml-2 inline-block text-xs font-semibold text-blue-600 hover:text-blue-700 transition-colors cursor-pointer"
                        >
                          {isHeadlineExpanded ? '[Show less]' : '[Read more]'}
                        </button>
                      )}
                    </h3>
                  );
                })()}
              </div>

              {/* 5-Bullet Brief Section */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/90 space-y-2.5">
                <div className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-purple-600" />
                  <span>Executive 5-Bullet Brief</span>
                </div>

                <ul className="space-y-1.5 text-xs text-slate-700">
                  {uploadResult.article.five_bullet_summary?.map((bullet, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-purple-600 shrink-0 mt-1.5" />
                      <span className="leading-relaxed">{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>


            </div>

            {/* Bottom Action Footer */}
            <div className="bg-slate-50 border-t border-slate-200 p-4 flex items-center justify-between flex-wrap gap-3">
              <button
                type="button"
                onClick={handleReset}
                className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow-2xs"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Upload Another Document</span>
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => navigate('/crisis-war-room')}
                  className="px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <span>Open in Crisis War Room</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>

                <button
                  type="button"
                  onClick={() => navigate('/news')}
                  className="px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <span>Open News Wire</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
