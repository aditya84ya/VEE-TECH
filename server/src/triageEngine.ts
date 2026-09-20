import { v4 as uuidv4 } from 'uuid';
import { 
  IntelligenceItem, 
  EntityName, 
  PlatformType, 
  RiskLevel, 
  SentimentType, 
  FiveBulletSummary, 
  SLATimestamps, 
  DispatchStatus 
} from './types.js';

interface RawPayloadInput {
  newspaperOrSource: string;
  author: string;
  pageNumber?: string;
  headline: string;
  shortDescription: string;
  fullText?: string;
  url?: string;
  entity?: EntityName;
  platform?: PlatformType;
  verifiedSource?: boolean;
}

export class TriageEngine {
  /**
   * In-memory AI Triage simulating local Qwen 2.5 LLM inference.
   * Completes in-memory within milliseconds for simulated pipeline,
   * while computing mathematical SLA elapsed telemetry.
   */
  public static triage(input: RawPayloadInput): IntelligenceItem {
    const startTime = Date.now();
    const publishedAt = new Date(startTime - 28000).toISOString();
    const ingestedAt = new Date(startTime - 12000).toISOString();
    const triagedAt = new Date(startTime - 2000).toISOString();
    const dispatchedAt = new Date(startTime).toISOString();

    const entity = input.entity || this.detectEntity(input.headline + ' ' + input.shortDescription);
    const isClient = entity === 'Infosys';
    const platform = input.platform || this.detectPlatform(input.newspaperOrSource);

    // AI Risk & Sentiment Evaluation
    const { sentiment, sentimentScore, riskScore, riskLevel } = this.evaluateRiskAndSentiment(
      input.headline,
      input.shortDescription,
      entity,
      isClient
    );

    // 5-Bullet Executive Brief Generation
    const summary = this.generate5BulletSummary(input, entity, riskScore, isClient);

    // Latency Telemetry (< 120 seconds SLA)
    const ingestDurationMs = 16000;
    const triageDurationMs = 12000;
    const dispatchDurationMs = 3000;
    const totalDurationMs = ingestDurationMs + triageDurationMs + dispatchDurationMs; // 31 seconds

    const sla: SLATimestamps = {
      publishedAt,
      ingestedAt,
      triagedAt,
      dispatchedAt,
      ingestDurationMs,
      triageDurationMs,
      dispatchDurationMs,
      totalDurationMs,
      slaBreached: totalDurationMs > 120000
    };

    // Omnichannel Dispatch Rules
    const dispatch = this.calculateDispatch(riskLevel, isClient);

    return {
      id: `intel-${uuidv4().slice(0, 8)}`,
      entity,
      isClient,
      platform,
      metadata: {
        newspaperOrSource: input.newspaperOrSource,
        author: input.author,
        pageNumber: input.pageNumber,
        headline: input.headline,
        shortDescription: input.shortDescription,
        fullText: input.fullText,
        url: input.url || 'https://wire.veealert.internal/article',
        verifiedSource: input.verifiedSource ?? true,
        reachCount: platform === 'print_epaper' ? '950K Circulation' : '280K Impressions'
      },
      sentiment,
      sentimentScore,
      riskScore,
      riskLevel,
      summary,
      sla,
      dispatch,
      status: riskLevel === 'Critical' ? 'active' : 'investigating'
    };
  }

  private static detectEntity(text: string): EntityName {
    const lower = text.toLowerCase();
    if (lower.includes('infosys') || lower.includes('infy')) return 'Infosys';
    if (lower.includes('tcs') || lower.includes('tata consultancy')) return 'TCS';
    if (lower.includes('wipro')) return 'Wipro';
    if (lower.includes('accenture')) return 'Accenture';
    return 'Infosys'; // Default to primary client
  }

  private static detectPlatform(source: string): PlatformType {
    const lower = source.toLowerCase();
    if (lower.includes('twitter') || lower.includes('x.com')) return 'twitter';
    if (lower.includes('instagram')) return 'instagram';
    if (lower.includes('facebook')) return 'facebook';
    if (lower.includes('times') || lower.includes('mint') || lower.includes('journal') || lower.includes('standard') || lower.includes('chronicle') || lower.includes('express')) {
      return 'print_epaper';
    }
    return 'news_web';
  }

  private static readonly CRITICAL_KEYWORDS = [
    'sebi emergency',
    'emergency order',
    'trading suspended',
    'trading terminated',
    'arrest',
    'arrests',
    'fraud',
    'enforcement directorate',
    'money laundering',
    'insolvency',
    'bankruptcy',
    'liquidation',
    'asset seizure',
    'assets seized',
    'whistleblower'
  ];

  private static evaluateRiskAndSentiment(
    headline: string,
    desc: string,
    entity: EntityName,
    isClient: boolean
  ): { sentiment: SentimentType; sentimentScore: number; riskScore: number; riskLevel: RiskLevel } {
    const text = (headline + ' ' + desc).toLowerCase();

    // 1. Dedicated CRITICAL Tier (Extreme Corporate / Financial Distress)
    const hasCriticalMatch = this.CRITICAL_KEYWORDS.some(kw => text.includes(kw));
    if (hasCriticalMatch) {
      return { 
        sentiment: 'critical_crisis', 
        sentimentScore: -0.95, 
        riskScore: 9.8, 
        riskLevel: 'Critical' 
      };
    }

    // Critical Crisis Keywords (Regulatory & Probes)
    if (text.includes('rbi') || text.includes('audit') || text.includes('probe') || text.includes('breach') || text.includes('sec inquiry') || text.includes('regulator')) {
      if (isClient) {
        return { sentiment: 'critical_crisis', sentimentScore: -0.92, riskScore: 9.8, riskLevel: 'Critical' };
      } else {
        return { sentiment: 'negative', sentimentScore: -0.75, riskScore: 7.5, riskLevel: 'High' };
      }
    }

    // High Impact Outages / Disputes
    if (text.includes('outage') || text.includes('down') || text.includes('lawsuit') || text.includes('fired') || text.includes('loss') || text.includes('delay')) {
      if (isClient) {
        return { sentiment: 'negative', sentimentScore: -0.80, riskScore: 7.5, riskLevel: 'High' };
      } else {
        return { sentiment: 'negative', sentimentScore: -0.65, riskScore: 7.5, riskLevel: 'High' };
      }
    }

    // Restructuring / Leadership / Strategy
    if (text.includes('restructure') || text.includes('resigns') || text.includes('step down') || text.includes('quarterly') || text.includes('margins')) {
      return { sentiment: 'neutral', sentimentScore: -0.20, riskScore: 4.8, riskLevel: 'Medium' };
    }

    // AI, Growth, Deals
    if (text.includes('ai') || text.includes('billion') || text.includes('expansion') || text.includes('deal') || text.includes('win') || text.includes('record')) {
      return { sentiment: 'positive', sentimentScore: 0.85, riskScore: 3.2, riskLevel: 'Low' };
    }

    return { sentiment: 'neutral', sentimentScore: 0.05, riskScore: 3.0, riskLevel: 'Low' };
  }

  private static generate5BulletSummary(
    input: RawPayloadInput,
    entity: EntityName,
    riskScore: number,
    isClient: boolean
  ): FiveBulletSummary {
    if (isClient) {
      return {
        whatHappened: `Breaking development regarding ${entity}: "${input.headline}" reported via ${input.newspaperOrSource}${input.pageNumber ? ` (${input.pageNumber})` : ''}.`,
        whyItMatters: `Direct brand and operational exposure for ${entity} affecting institutional client confidence and market open sentiment.`,
        riskJustification: `AI Risk Index calculated at ${riskScore}/10 based on publisher circulation and potential regulatory/legal escalation vectors.`,
        competitorImpact: `Key rivals (TCS, Wipro, Accenture) may initiate proactive marketing and account poaching across shared client accounts.`,
        recommendedAction: `Deploy immediate cross-functional crisis communication; brief media relations and client executive sponsors within 30 minutes.`
      };
    } else {
      return {
        whatHappened: `Competitor update for ${entity}: "${input.headline}" published by ${input.newspaperOrSource} by ${input.author}.`,
        whyItMatters: `Presents a measurable shift in ${entity}'s operational or market position, opening tactical intercept opportunities for Infosys.`,
        riskJustification: `Severity score assigned at ${riskScore}/10 based on viral spread across social channels and tier-1 media reach.`,
        competitorImpact: `${entity} executive leadership diverted to crisis response or aggressive campaign execution.`,
        recommendedAction: `Direct Infosys sales and account executives to review active enterprise RFPs where ${entity} is the incumbent.`
      };
    }
  }

  private static calculateDispatch(riskLevel: RiskLevel, isClient: boolean): DispatchStatus {
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (riskLevel === 'Critical') {
      return {
        dashboard: true,
        whatsapp: { dispatched: true, recipient: '+91-98840-CRISIS', timestamp: timeStr },
        slack: { dispatched: true, channel: '#crisis-war-room-exec', timestamp: timeStr },
        email: { dispatched: true, recipients: ['cmo@infosys.com', 'crisis-response@infosys.com'], timestamp: timeStr },
        voiceCall: {
          dispatched: true,
          targetRole: 'Chief Crisis Officer & CMO',
          phone: '+91-98840-83333',
          callStatus: 'ringing',
          timestamp: timeStr
        }
      };
    }

    if (riskLevel === 'High') {
      return {
        dashboard: true,
        whatsapp: { dispatched: true, recipient: '+91-98840-STRATEGY', timestamp: timeStr },
        slack: { dispatched: true, channel: '#market-intelligence-intel', timestamp: timeStr },
        email: { dispatched: true, recipients: ['intel-brief@infosys.com'], timestamp: timeStr },
        voiceCall: {
          dispatched: false,
          targetRole: 'Standby (Tier-4 only)',
          phone: '',
          callStatus: 'idle'
        }
      };
    }

    if (riskLevel === 'Medium') {
      return {
        dashboard: true,
        whatsapp: { dispatched: false },
        slack: { dispatched: true, channel: '#competitor-radar-feed', timestamp: timeStr },
        email: { dispatched: false },
        voiceCall: { dispatched: false, targetRole: 'None', phone: '', callStatus: 'idle' }
      };
    }

    return {
      dashboard: true,
      whatsapp: { dispatched: false },
      slack: { dispatched: false },
      email: { dispatched: false },
      voiceCall: { dispatched: false, targetRole: 'None', phone: '', callStatus: 'idle' }
    };
  }
}
