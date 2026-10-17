import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Select, Button, Input, message, Empty, Typography, Spin, Alert } from 'antd';
import { accountApi, crownApi } from '../services/api';
import { ReloadOutlined } from '@ant-design/icons';
import BetFormModal, { type SelectionMeta, type MarketScope } from '../components/Betting/BetFormModal';
import type { CrownAccount, Match as MatchType } from '../types';
import dayjs from 'dayjs';

const { Title } = Typography;

// Helper functions (omitted for brevity but kept in actual implementation)
const manualName = (value: string | null | undefined, fallback: string): string => {
  const trimmed = (value ?? '').trim();
  return trimmed || fallback;
};

const buildLiveClock = (period?: string | null, clock?: string | null): string => {
  const p = (period ?? '').trim();
  const c = (clock ?? '').trim();
  if (c.includes('^')) return c;
  if (p.includes('^')) {
    if (!c) return p;
    const normalizedClock = c.startsWith('^') ? c.slice(1) : c;
    return `${p}${normalizedClock.startsWith('^') ? '' : '^'}${normalizedClock}`;
  }
  if (p && c) {
    const normalizedClock = c.startsWith('^') ? c.slice(1) : c;
    return `${p}^${normalizedClock}`;
  }
  return c || p || '';
};

const parseHandicapDecimal = (line?: string): number | null => {
  if (!line) return null;
  const cleaned = String(line).replace(/[^\d./+\-\s]/g, '').replace(/\s+/g, '');
  if (!cleaned) return null;
  let working = cleaned;
  let globalSign = 1;
  if (working.startsWith('-')) { globalSign = -1; working = working.slice(1); }
  else if (working.startsWith('+')) working = working.slice(1);
  const parts = working.split('/');
  const values: number[] = [];
  for (const partRaw of parts) {
    if (!partRaw) continue;
    let part = partRaw;
    let localSign = globalSign;
    if (part.startsWith('-')) { localSign = -1; part = part.slice(1); }
    else if (part.startsWith('+')) { localSign = 1; part = part.slice(1); }
    const num = parseFloat(part);
    if (Number.isFinite(num)) values.push(num * localSign);
  }
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
  return Number.isFinite(avg) ? avg : null;
};

const formatHandicapValue = (value: number | null): string => {
  if (value === null || Number.isNaN(value)) return '';
  if (Math.abs(value) < 1e-4) return '0';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const absValue = Math.abs(value);
  const str = Number.isInteger(absValue) ? absValue.toString() : absValue.toFixed(2).replace(/\.?0+$/, '');
  return `${sign}${str}`;
};

const parseScoreNumber = (value: any): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseCountNumber = (value: any): number | null => {
  const num = parseScoreNumber(value);
  if (num === null) return null;
  const asInt = Math.trunc(num);
  if (!Number.isFinite(asInt) || asInt < 0) return null;
  return asInt;
};

const extractRedCardCount = (match: any, side: 'home' | 'away'): number | null => {
  const topKey = side === 'home' ? 'home_redcard' : 'away_redcard';
  const lowerKey = side === 'home' ? 'redcard_h' : 'redcard_c';
  const rawKey = side === 'home' ? 'REDCARD_H' : 'REDCARD_C';

  const candidates = [
    match?.[topKey],
    match?.[lowerKey],
    match?.[rawKey],
    match?._rawGame?.[rawKey],
    match?.raw?.[rawKey],
    match?.raw?.game?.[rawKey],
    match?.raw_data?.raw?.game?.[rawKey],
    match?.raw_data?.raw?.[rawKey],
  ];

  for (const value of candidates) {
    const parsed = parseCountNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
};

const renderTeamLabel = (name: string, redcard: number | null) => (
  <span className="team-name-with-redcard">
    <span>{name}</span>
    {(redcard ?? 0) > 0 ? <span className="redcard-badge">{redcard}</span> : null}
  </span>
);

const buildScoreLabel = (match: any): string => {
  const direct = String(match?.score ?? match?.current_score ?? '').trim();
  if (direct) return direct;

  const home = parseScoreNumber(match?.home_score ?? match?.score_h ?? match?.SCORE_H ?? match?._rawGame?.SCORE_H ?? match?.raw?.SCORE_H);
  const away = parseScoreNumber(match?.away_score ?? match?.score_c ?? match?.SCORE_C ?? match?._rawGame?.SCORE_C ?? match?.raw?.SCORE_C);
  if (home === null || away === null) return '';
  return `${home}-${away}`;
};

const normalizeStateValue = (value: any): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const isLiveState = (value: any): boolean => {
  const state = normalizeStateValue(value);
  if (state === undefined) {
    return false;
  }
  return state === 1;
};

const normalizeYesNoFlag = (value: any): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toUpperCase();
  if (!text) return undefined;
  if (['Y', 'YES', 'TRUE', '1'].includes(text)) return true;
  if (['N', 'NO', 'FALSE', '0'].includes(text)) return false;
  return undefined;
};

const extractIsRbFlag = (match: any): boolean | undefined => {
  if (!match) return undefined;
  const rawValue = match?.is_rb
    ?? match?.isRB
    ?? match?.IS_RB
    ?? match?._rawGame?.IS_RB
    ?? match?.raw?.IS_RB
    ?? match?.raw?.is_rb
    ?? match?.raw?.game?.IS_RB
    ?? match?.raw_data?.raw?.IS_RB
    ?? match?.raw_data?.raw?.game?.IS_RB;
  return normalizeYesNoFlag(rawValue);
};

const isFinishedMatch = (match: any): boolean => {
  const state = normalizeStateValue(match?.state ?? match?.status);
  if (state !== undefined) return state === -1 || state === 3;
  const period = String(match?.period ?? match?.match_period ?? '').trim().toLowerCase();
  if (!period) return false;
  const finishedTokens = ['已结束', '結束', 'finished', 'full time', 'ft', 'postponed', 'cancelled'];
  return finishedTokens.some((t) => period.includes(t));
};

const isLiveMatch = (match: any): boolean => {
  if (!match) return false;
  const isRb = extractIsRbFlag(match);
  if (isRb === true) return true;
  const rawState = (match.state ?? match.status);
  const stateNum = normalizeStateValue(rawState);
  if (stateNum !== undefined) {
    return stateNum === 1;
  }

  const stateStr = String(rawState || '').trim().toLowerCase();
  if (stateStr) {
    const tokens = ['rb', 're', 'live', 'inplay', 'in-play', '滚球', '滾球', '进行中', '進行中'];
    if (tokens.some((t) => stateStr.includes(t))) return true;
  }

  const period = String(match.period ?? match.match_period ?? '').trim().toLowerCase();
  if (period) {
    const nonLivePeriods = ['未开赛', '已结束', '結束', 'finished', 'full time', 'ft', 'postponed', 'cancelled'];
    if (nonLivePeriods.some((p) => period.includes(p))) return false;

    const livePeriods = [
      '滚球', '滾球', '1h', '2h', 'ht', 'q1', 'q2', 'q3', 'q4', '1q', '2q', '3q', '4q', 'ot', 'et',
      '上半', '下半', '上半场', '下半场', '第一节', '第二节', '第三节', '第四节',
    ];
    if (livePeriods.some((p) => period.includes(p.toLowerCase()))) return true;
  }

  const clock = String(match.clock ?? match.match_clock ?? '').trim();
  if (clock && clock !== '' && clock !== '0' && clock !== '00:00') return true;

  return false;
};

const parseMatchDate = (match: any): Date | null => {
  const raw = match?.match_time ?? match?.time ?? match?.timer ?? match?.matchTime ?? match?.datetime;
  if (!raw) {
    return null;
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return date;
};

const startOfDay = (offsetDays = 0) => {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  base.setDate(base.getDate() + offsetDays);
  return base;
};

const getCrownDateOffsetDays = (days: number): string => {
  const d = new Date(Date.now() - 4 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

const getCrownDateFromDate = (date: Date): string => {
  const d = new Date(date.getTime() - 4 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

const extractMatchDateText = (match: any): string | null => {
  const raw = match?.match_time ?? match?.time ?? match?.datetime ?? match?.matchTime ?? match?.timer;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
};

const ensureMatchShowType = (match: any, showtype: string): any => {
  if (!match || typeof match !== 'object') return match;
  if (match.showtype || match.showType || match.show_type || match.source_showtype) return match;
  return { ...match, showType: showtype };
};

const matchBelongsToShowtype = (match: any, showtype: string): boolean => {
  const tag = match?.showtype ?? match?.showType ?? match?.show_type ?? match?.source_showtype;
  if (tag) {
    return String(tag).toLowerCase() === showtype && !isFinishedMatch(match);
  }

  if (showtype === 'live') {
    if (isFinishedMatch(match)) return false;
    return isLiveMatch(match);
  }

  if (showtype === 'today') {
    if (isFinishedMatch(match)) return false;
    const date = parseMatchDate(match);
    if (date) {
      const todayStart = startOfDay(0);
      const tomorrowStart = startOfDay(1);
      return date >= todayStart && date < tomorrowStart;
    }
    const state = normalizeStateValue(match?.state ?? match?.status);
    return state === 0 || isLiveState(state);
  }

  if (showtype === 'early') {
    if (isFinishedMatch(match)) return false;
    const tomorrowDate = getCrownDateOffsetDays(1);
    const rawText = extractMatchDateText(match);
    if (rawText && rawText.startsWith(tomorrowDate)) return true;
    const date = parseMatchDate(match);
    if (date) {
      return getCrownDateFromDate(date) === tomorrowDate;
    }
    return false;
  }

  return !isFinishedMatch(match);
};

const extractRetimeset = (match: any): string => {
  const raw = match?._rawGame || match?.raw || {};
  const direct = String(match?.retimeset ?? match?.RETIMESET ?? raw?.RETIMESET ?? '').trim();
  if (direct) return direct;

  const clock = String(match?.clock ?? match?.match_clock ?? '').trim();
  if (clock.includes('^') || clock.includes('*')) return clock;

  const period = String(match?.period ?? match?.match_period ?? '').trim();
  if (period.includes('^') || period.includes('*')) return period;

  return '';
};

const formatRunningTime = (retimeset: string, gtype: 'ft' | 'bk'): string => {
  const text = String(retimeset || '').trim();
  if (!text) return '';

  // 常见格式：1H^12:00 / 2H^83:49 / Q1^10:00 / 2H*89:41
  const sep = text.includes('^') ? '^' : (text.includes('*') ? '*' : '');
  if (!sep) return text;

  const [phaseRaw, timeRaw] = text.split(sep);
  const phase = String(phaseRaw || '').trim();
  const timePart = String(timeRaw || '').trim();
  if (!timePart) return text.replace(/\^/g, ' ').replace(/\*/g, ' ');

  const upper = phase.toUpperCase();
  if (upper === 'HT') return '中场';

  const q = upper.match(/^Q(\d+)$/);
  if (q) return `第${q[1]}节 ${timePart}`;

  const ot = upper.match(/^OT(\d+)?$/);
  if (ot) return `${ot[1] ? `加时${ot[1]}` : '加时'} ${timePart}`;

  if (gtype === 'ft') {
    if (upper === '1H') return `上半 ${timePart}`;
    if (upper === '2H') return `下半 ${timePart}`;
    return timePart;
  }

  // bk: 默认带上阶段
  return phase ? `${phase} ${timePart}` : timePart;
};

const convertMatch = (matchData: any): MatchType => {
  const nowIso = new Date().toISOString();
  const scoreLabel = buildScoreLabel(matchData);
  const retimeset = extractRetimeset(matchData);
  const homeRed = extractRedCardCount(matchData, 'home');
  const awayRed = extractRedCardCount(matchData, 'away');
  const matchTime = matchData.match_time || matchData.time || matchData.timer || nowIso;
  const periodParts = [retimeset, matchData.clock].filter(Boolean).map((v: any) => String(v).trim()).filter(Boolean);
  const uniquePeriodParts = Array.from(new Set(periodParts));
  return {
    id: Number(matchData.gid) || 0,
    match_id: String(matchData.gid || nowIso),
    league_name: matchData.league || '',
    home_team: matchData.home || '',
    away_team: matchData.away || '',
    match_time: matchTime,
    status: 'live',
    current_score: scoreLabel,
    home_redcard: homeRed ?? undefined,
    away_redcard: awayRed ?? undefined,
    match_period: uniquePeriodParts.join(' '),
    markets: matchData.markets || {},
    crown_gid: matchData.crown_gid || matchData.crownGid || null,
    last_synced_at: nowIso,
    created_at: nowIso,
    updated_at: nowIso,
  };
};

const normalizeWsId = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text === '0') return null;
  return text;
};

const getMatchGid = (match: any): string => {
  return (
    normalizeWsId(match?.gid)
    || normalizeWsId(match?.match_id)
    || normalizeWsId(match?.crown_gid)
    || normalizeWsId(match?.id)
    || ''
  );
};

const normalizeMarkets = (raw: any): any => {
  if (!raw || typeof raw !== 'object') return raw;

  const isPlainObject = (value: any): value is Record<string, any> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const asPlainObject = (value: any): Record<string, any> => (isPlainObject(value) ? value : {});
  const asArray = (value: any): any[] | null => (Array.isArray(value) ? value : null);

  const markets: any = { ...raw };
  markets.full = { ...(isPlainObject(markets.full) ? markets.full : {}) };
  markets.half = { ...(isPlainObject(markets.half) ? markets.half : {}) };

  const fullHandicapLines = asArray(markets.full.handicapLines)
    || asArray(markets.handicapLines)
    || asArray((markets.full as any).handicap_lines)
    || asArray((markets as any).handicap_lines)
    || (isPlainObject(markets.handicap) ? [markets.handicap] : null)
    || (isPlainObject(markets.full.handicap) ? [markets.full.handicap] : null);
  if (fullHandicapLines) {
    markets.full.handicapLines = fullHandicapLines;
  }

  const fullOverUnderLines = asArray(markets.full.overUnderLines)
    || asArray(markets.overUnderLines)
    || asArray(markets.ouLines)
    || asArray((markets.full as any).over_under_lines)
    || asArray((markets as any).over_under_lines)
    || (isPlainObject(markets.ou) ? [markets.ou] : null)
    || (isPlainObject(markets.full.ou) ? [markets.full.ou] : null);
  if (fullOverUnderLines) {
    markets.full.overUnderLines = fullOverUnderLines;
  }

  const halfHandicapLines = asArray(markets.half.handicapLines)
    || asArray(markets.halfHandicapLines)
    || asArray((markets.half as any).handicap_lines)
    || asArray((markets as any).halfHandicapLines)
    || (isPlainObject(markets.half.handicap) ? [markets.half.handicap] : null);
  if (halfHandicapLines) {
    markets.half.handicapLines = halfHandicapLines;
  }

  const halfOverUnderLines = asArray(markets.half.overUnderLines)
    || asArray(markets.halfOverUnderLines)
    || asArray((markets.half as any).over_under_lines)
    || asArray((markets as any).halfOverUnderLines)
    || (isPlainObject(markets.half.ou) ? [markets.half.ou] : null);
  if (halfOverUnderLines) {
    markets.half.overUnderLines = halfOverUnderLines;
  }

  const moneylineRoot = asPlainObject(markets.moneyline || markets.moneyLine);
  const moneylineFull = asPlainObject(markets.full.moneyline || (markets.full as any).moneyLine);
  if (Object.keys(moneylineRoot).length > 0 || Object.keys(moneylineFull).length > 0) {
    const merged = { ...moneylineRoot, ...moneylineFull };
    markets.moneyline = merged;
    markets.full.moneyline = merged;
  }

  if (Array.isArray(markets.full.handicapLines) && markets.full.handicapLines.length > 0) {
    const first = markets.full.handicapLines[0];
    if (isPlainObject(first)) {
      markets.handicap = { ...asPlainObject(markets.handicap), ...first };
      markets.full.handicap = { ...asPlainObject(markets.full.handicap), ...first };
    }
  }

  if (Array.isArray(markets.full.overUnderLines) && markets.full.overUnderLines.length > 0) {
    const first = markets.full.overUnderLines[0];
    if (isPlainObject(first)) {
      markets.ou = { ...asPlainObject(markets.ou), ...first };
      markets.full.ou = { ...asPlainObject(markets.full.ou), ...first };
    }
  }

  if (Array.isArray(markets.half.handicapLines) && markets.half.handicapLines.length > 0) {
    const first = markets.half.handicapLines[0];
    if (isPlainObject(first)) {
      markets.half.handicap = { ...asPlainObject(markets.half.handicap), ...first };
    }
  }

  if (Array.isArray(markets.half.overUnderLines) && markets.half.overUnderLines.length > 0) {
    const first = markets.half.overUnderLines[0];
    if (isPlainObject(first)) {
      markets.half.ou = { ...asPlainObject(markets.half.ou), ...first };
    }
  }

  return markets;
};

type OddsFlashClass = '' | 'flash-up' | 'flash-down' | 'flash';

type MaintenanceInfo = {
  active: boolean;
  detectedAt: number;
  startAt?: number;
  endAt?: number;
  rawPeriod?: string;
  message?: string;
};

const normalizeMaintenanceInfo = (raw: any): MaintenanceInfo | null => {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.active !== 'boolean') return null;
  const detectedAt = typeof raw.detectedAt === 'number' && Number.isFinite(raw.detectedAt) ? raw.detectedAt : 0;
  const startAt = typeof raw.startAt === 'number' && Number.isFinite(raw.startAt) ? raw.startAt : undefined;
  const endAt = typeof raw.endAt === 'number' && Number.isFinite(raw.endAt) ? raw.endAt : undefined;
  const rawPeriod = typeof raw.rawPeriod === 'string' ? raw.rawPeriod : undefined;
  const messageText = typeof raw.message === 'string' ? raw.message : undefined;
  return {
    active: raw.active,
    detectedAt,
    startAt,
    endAt,
    rawPeriod,
    message: messageText,
  };
};

const normalizeOddsText = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text === '-' || text === '--' || text === '—') return null;
  // 上游有时会用 0/0.00 表示“无赔率/未开盘”，前端直接显示会变成 0
  if (text === '0' || text === '0.0' || text === '0.00' || text === '0.000') return null;
  const num = Number.parseFloat(text);
  if (!Number.isFinite(num) || num <= 0) return null;
  return text;
};

const parseOddsNumber = (value: unknown): number | null => {
  const text = normalizeOddsText(value);
  if (!text) return null;
  const num = Number.parseFloat(text);
  return Number.isFinite(num) ? num : null;
};

const OddsCell: React.FC<{ value: any; onClick?: () => void }> = ({ value, onClick }) => {
  const prevRef = useRef<number | null | undefined>(undefined);
  const rafRef = useRef<number | null>(null);
  const [flashClass, setFlashClass] = useState<OddsFlashClass>('');
  const displayText = useMemo(() => normalizeOddsText(value), [value]);
  const clickable = displayText !== null && typeof onClick === 'function';

  useEffect(() => {
    const nextNum = parseOddsNumber(value);
    const prevNum = prevRef.current;
    prevRef.current = nextNum;

    if (prevNum === undefined) return;
    if (prevNum === nextNum) return;

    let nextFlash: OddsFlashClass = 'flash';
    if (prevNum !== null && nextNum !== null) {
      nextFlash = nextNum > prevNum ? 'flash-up' : 'flash-down';
    }

    setFlashClass('');
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    rafRef.current = window.requestAnimationFrame(() => setFlashClass(nextFlash));
  }, [value]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  return (
    <div
      className={`odds-cell${!clickable ? ' disabled' : ''}${flashClass ? ` ${flashClass}` : ''}`}
      onClick={() => {
        if (!clickable) return;
        onClick?.();
      }}
    >
      {displayText ?? '-'}
    </div>
  );
};

const MatchesPage: React.FC = () => {
  const [showtype, setShowtype] = useState<'live' | 'today' | 'early'>('live');
  const [gtype, setGtype] = useState<'ft' | 'bk'>('ft');
  const [loading, setLoading] = useState(false);
  const [matches, setMatches] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [betModalVisible, setBetModalVisible] = useState(false);
  const [betModalKey, setBetModalKey] = useState(0);
  const [selectedMatch, setSelectedMatch] = useState<MatchType | null>(null);
  const [selectionPreset, setSelectionPreset] = useState<SelectionMeta | null>(null);
  const [accounts, setAccounts] = useState<CrownAccount[]>([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const lastUpdatedAtRef = useRef<number | null>(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [renderLimit, setRenderLimit] = useState(() => (window.innerWidth <= 768 ? 40 : 80));
  const [maintenance, setMaintenance] = useState<MaintenanceInfo | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const matchesMapRef = useRef<Map<string, any>>(new Map());
  const pendingUpdatesRef = useRef<Map<string, any>>(new Map());
  const pendingRemovalsRef = useRef<Set<string>>(new Set());
  const flushTimerRef = useRef<number | null>(null);
  const latestRequestSeqRef = useRef(0);
  const latestBlockingSeqRef = useRef(0);
  const lastCacheWriteAtRef = useRef(0);
  const viewCacheRef = useRef<Map<string, { matches: any[]; lastUpdatedAt: number | null }>>(new Map());
  const matchesViewKeyRef = useRef<string>('');
  const currentViewKeyRef = useRef<string>('');
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const wsFullDataAtRef = useRef<Map<string, number>>(new Map());
  const wsMatchesByTypeRef = useRef<Map<string, Map<string, any>>>(new Map());
  const wsAuthedRef = useRef(false);
  const wsSubscribedRef = useRef(false);
  const wsAuthTimerRef = useRef<number | null>(null);
  const currentShowtypeRef = useRef(showtype);
  const currentGtypeRef = useRef(gtype);
  // API 兜底只在 WS 连接不可用时触发，避免 UI 被慢接口卡住

  const buildCacheKey = (gt: string, st: string) => `matches_cache_v2:${gt}:${st}`;

  const maintenanceActive = maintenance?.active === true;
  const getCacheTtl = useCallback((st: string) => {
    const key = String(st || '').toLowerCase();
    if (key === 'live') return 60000;
    if (key === 'today') return 600000;
    if (key === 'early') return 1800000;
    return 60000;
  }, []);
  const getWsGuardTtl = useCallback((st: string) => {
    const key = String(st || '').toLowerCase();
    if (key === 'live') return 15000;
    if (key === 'today') return 60000;
    if (key === 'early') return 120000;
    return 30000;
  }, []);

  const maintenanceDescription = useMemo(() => {
    if (!maintenanceActive) return null;
    const lines: string[] = [];
    if (maintenance?.rawPeriod) lines.push(`维护时间：${maintenance.rawPeriod}`);
    else if (maintenance?.endAt) lines.push(`预计结束：${dayjs(maintenance.endAt).format('YYYY-MM-DD HH:mm:ss')}`);
    if (maintenance?.message) lines.push(maintenance.message);
    if (lines.length === 0) lines.push('皇冠系统维护中，数据暂停更新');
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {lines.map((line, idx) => (
          <div key={idx}>{line}</div>
        ))}
      </div>
    );
  }, [maintenanceActive, maintenance]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const fetchAccounts = async (silent = false) => {
    try {
      const res = await accountApi.getAccounts();
      if (res.success && res.data) setAccounts(res.data);
      else if (!silent) message.error(res.error || '获取账号列表失败');
    } catch (error) {
      if (!silent) message.error('获取账号列表失败');
    }
  };

  useEffect(() => { fetchAccounts(true); }, []);

  useEffect(() => {
    lastUpdatedAtRef.current = lastUpdatedAt;
  }, [lastUpdatedAt]);

  useEffect(() => {
    const key = matchesViewKeyRef.current;
    if (!key) return;
    if (matches.length === 0 && lastUpdatedAt === null) {
      viewCacheRef.current.delete(key);
      return;
    }
    viewCacheRef.current.set(key, { matches, lastUpdatedAt });
  }, [matches, lastUpdatedAt]);

  useEffect(() => {
    currentViewKeyRef.current = buildCacheKey(gtype, showtype);
  }, [gtype, showtype]);
  useEffect(() => {
    currentShowtypeRef.current = showtype;
  }, [showtype]);
  useEffect(() => {
    currentGtypeRef.current = gtype;
  }, [gtype]);

  useEffect(() => {
    setRenderLimit(isMobile ? 40 : 80);
  }, [gtype, showtype, search, isMobile]);

  // WebSocket 实时订阅（使用 VITE_WS_URL / VITE_WS_AUTH_TOKEN）
  const mergeMatchData = useCallback((prevMatch: any, nextMatch: any) => {
    const merged: any = { ...(prevMatch || {}), ...(nextMatch || {}) };
    if ((prevMatch && prevMatch.markets) || (nextMatch && nextMatch.markets)) {
      const prevMarkets: any = prevMatch?.markets || {};
      const nextMarkets: any = nextMatch?.markets || {};
      const mergedMarkets: any = { ...prevMarkets, ...nextMarkets };

      const mergeNested = (key: string) => {
        if (prevMarkets?.[key] || nextMarkets?.[key]) {
          mergedMarkets[key] = { ...(prevMarkets?.[key] || {}), ...(nextMarkets?.[key] || {}) };
        }
      };
      mergeNested('full');
      mergeNested('half');
      mergeNested('corners');
      mergeNested('cornerFull');
      mergeNested('cornerHalf');

      merged.markets = normalizeMarkets(mergedMarkets);
    }
    return merged;
  }, []);

  const flushPendingUpdates = useCallback(() => {
    const pendingUpdates = pendingUpdatesRef.current;
    const pendingRemovals = pendingRemovalsRef.current;
    if (pendingUpdates.size === 0 && pendingRemovals.size === 0) return;

    const map = matchesMapRef.current;

    for (const gid of pendingRemovals) {
      map.delete(gid);
      pendingUpdates.delete(gid);
    }
    pendingRemovals.clear();

    for (const [gid, patch] of pendingUpdates.entries()) {
      const prevMatch = map.get(gid);
      if (!prevMatch) {
        map.set(gid, patch);
      } else {
        map.set(gid, mergeMatchData(prevMatch, patch));
      }
    }
    pendingUpdates.clear();

    matchesViewKeyRef.current = buildCacheKey(currentGtypeRef.current, currentShowtypeRef.current);
    setMatches(Array.from(map.values()));
    setLastUpdatedAt(Date.now());
  }, [mergeMatchData]);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      flushPendingUpdates();
    }, 80);
  }, [flushPendingUpdates]);

  const resolveShowType = (payload: any): string | null => {
    if (!payload || typeof payload !== 'object') return null;
    const candidates = [
      payload.showType,
      payload.show_type,
      payload?.match?.showType,
      payload?.match?.showtype,
      payload?.match?.show_type,
      payload?.match?.source_showtype,
    ];
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) continue;
      const text = String(candidate).trim().toLowerCase();
      if (text) return text;
    }
    return null;
  };

  const WS_SHOWTYPES = ['live', 'today', 'early'];

  const sendWs = useCallback((payload: any) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[WS] send failed', err);
      return false;
    }
  }, []);

  const trySubscribeAll = useCallback((force = false) => {
    if (wsSubscribedRef.current && !force) return true;
    if (!wsAuthedRef.current && !force) return false;
    const ok = sendWs({
      type: 'subscribe',
      data: { showTypes: WS_SHOWTYPES },
    });
    if (ok && (wsAuthedRef.current || force)) wsSubscribedRef.current = true;
    return ok;
  }, [sendWs]);

  const getWsMap = useCallback((st: string): Map<string, any> => {
    const store = wsMatchesByTypeRef.current;
    let map = store.get(st);
    if (!map) {
      map = new Map<string, any>();
      store.set(st, map);
    }
    return map;
  }, []);

  const requestWsSnapshot = useCallback((st: string): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (!wsAuthedRef.current) return false;
    return sendWs({
      type: 'subscribe',
      data: { showTypes: [st] },
    });
  }, [sendWs]);

  const handleWsMessage = useCallback((raw: any) => {
    if (!raw || typeof raw !== 'object') return;
    const { type, data } = raw as { type?: string; data?: any };
    if (!type || !data) return;
    if (type === 'heartbeat') {
      const messageText = String(data?.message ?? data?.msg ?? '').trim();
      if (!wsAuthedRef.current && messageText.includes('认证成功')) {
        wsAuthedRef.current = true;
        trySubscribeAll();
      }
      const nextMaintenance = normalizeMaintenanceInfo(data.maintenance);
      if (nextMaintenance) {
        setMaintenance(nextMaintenance);
        if (nextMaintenance.active) {
          // 维护期间不应一直卡在“加载中”
          setLoading(false);
        }
      }
      return;
    }
    if (type === 'error') {
      // eslint-disable-next-line no-console
      console.error('[WS] error message', data);
      return;
    }

    const activeShowType = currentShowtypeRef.current;
    const resolvedShowType = resolveShowType(data);
    if (type === 'full_data' && !resolvedShowType) return;
    const msgShowType = resolvedShowType || activeShowType;
    const currentGtype = currentGtypeRef.current;
    const viewKey = buildCacheKey(currentGtype, msgShowType);
    const markWsFresh = () => {
      wsFullDataAtRef.current.set(viewKey, Date.now());
    };

    // 全量数据：直接覆盖当前列表
    if (type === 'full_data') {
      const list = Array.isArray(data.matches) ? data.matches : [];
      const normalized = list.map((m: any) => mergeMatchData(null, ensureMatchShowType(m, msgShowType)));
      const nextMap = new Map<string, any>();
      for (const item of normalized) {
        const gid = getMatchGid(item);
        if (!gid) continue;
        nextMap.set(gid, item);
      }
      wsMatchesByTypeRef.current.set(msgShowType, nextMap);
      markWsFresh();
      if (msgShowType === activeShowType) {
        matchesMapRef.current = new Map(nextMap);
        pendingUpdatesRef.current.clear();
        pendingRemovalsRef.current.clear();
        matchesViewKeyRef.current = buildCacheKey(currentGtype, activeShowType);
        setMatches(Array.from(nextMap.values()));
        setLastUpdatedAt(Date.now());
        // WS 全量到达后，优先结束首屏阻塞态（接口可能仍在慢速兜底分支中）
        setLoading(false);
      }
      return;
    }

    // 新增 / 更新 / 赔率 / 比分：按 gid 合并到现有列表
    if (type === 'match_add' || type === 'match_update' || type === 'odds_update' || type === 'score_update') {
      const match = data.match;
      if (!match) return;
      const normalized = ensureMatchShowType(match, msgShowType);
      const gid = normalizeWsId(data.gid) || getMatchGid(normalized);
      if (!gid) return;

      const map = getWsMap(msgShowType);
      const merged = mergeMatchData(map.get(gid), normalized);
      map.set(gid, merged);
      wsMatchesByTypeRef.current.set(msgShowType, map);

      // 若同一个 gid 同时存在于其他 showType 缓存，也同步更新，避免 showType 标记不一致导致 UI 看起来“赔率不动”
      let mergedForActive: any | null = msgShowType === activeShowType ? merged : null;
      for (const [st, otherMap] of wsMatchesByTypeRef.current.entries()) {
        if (st === msgShowType) continue;
        if (!otherMap.has(gid)) continue;
        const mergedOther = mergeMatchData(otherMap.get(gid), normalized);
        otherMap.set(gid, mergedOther);
        wsMatchesByTypeRef.current.set(st, otherMap);
        if (st === activeShowType) mergedForActive = mergedOther;
      }

      markWsFresh();
      const shouldPatchActive = mergedForActive !== null || matchesMapRef.current.has(gid);
      if (!shouldPatchActive) return;

      const activeMerged = mergedForActive ?? mergeMatchData(matchesMapRef.current.get(gid), normalized);
      const existingPatch = pendingUpdatesRef.current.get(gid);
      pendingUpdatesRef.current.set(gid, existingPatch ? mergeMatchData(existingPatch, activeMerged) : activeMerged);
      scheduleFlush();
      return;
    }

    // 删除赛事
    if (type === 'match_remove') {
      const gid = normalizeWsId(data.gid);
      if (!gid) return;
      const map = getWsMap(msgShowType);
      map.delete(gid);
      wsMatchesByTypeRef.current.set(msgShowType, map);
      for (const [st, otherMap] of wsMatchesByTypeRef.current.entries()) {
        if (st === msgShowType) continue;
        if (!otherMap.has(gid)) continue;
        otherMap.delete(gid);
        wsMatchesByTypeRef.current.set(st, otherMap);
      }
      markWsFresh();
      if (matchesMapRef.current.has(gid)) {
        pendingRemovalsRef.current.add(gid);
        scheduleFlush();
      }
      return;
    }
  }, [mergeMatchData, scheduleFlush, trySubscribeAll, getWsMap]);

  useEffect(() => {
    const WS_URL = import.meta.env.VITE_WS_URL as string | undefined;
    const WS_TOKEN = import.meta.env.VITE_WS_AUTH_TOKEN as string | undefined;

    if (!WS_URL || !WS_TOKEN || typeof WebSocket === 'undefined') {
      return;
    }

    let isUnmounted = false;
    let reconnectTimer: number | undefined;
    wsAuthedRef.current = false;
    wsSubscribedRef.current = false;
    if (wsAuthTimerRef.current !== null) {
      window.clearTimeout(wsAuthTimerRef.current);
      wsAuthTimerRef.current = null;
    }

    const connect = () => {
      if (isUnmounted) return;
      try {
        wsAuthedRef.current = false;
        wsSubscribedRef.current = false;
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          try {
            ws.send(JSON.stringify({ type: 'auth', data: { token: WS_TOKEN } }));
            // Local/real-time fixtures process frames in order. Force the initial
            // subscription immediately after auth so one missed heartbeat cannot
            // leave the matches page empty.
            ws.send(JSON.stringify({
              type: 'subscribe',
              data: { showTypes: WS_SHOWTYPES },
            }));
            wsSubscribedRef.current = true;
            wsAuthTimerRef.current = window.setTimeout(() => {
              wsAuthTimerRef.current = null;
              if (!wsAuthedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
                try {
                  wsRef.current.send(JSON.stringify({ type: 'auth', data: { token: WS_TOKEN } }));
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error('[WS] resend auth failed', err);
                }
              }
            }, 1200);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[WS] send auth/subscribe failed', err);
          }
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            handleWsMessage(msg);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[WS] parse message failed', err);
          }
        };

        ws.onclose = () => {
          wsAuthedRef.current = false;
          wsSubscribedRef.current = false;
          wsRef.current = null;
          if (!isUnmounted) {
            reconnectTimer = window.setTimeout(connect, 5000);
          }
        };

        ws.onerror = (event) => {
          // eslint-disable-next-line no-console
          console.error('[WS] error', event);
          // 交给 onclose 去处理重连
        };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[WS] connect failed', err);
        reconnectTimer = window.setTimeout(connect, 5000);
      }
    };

    connect();

    return () => {
      isUnmounted = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
        wsRef.current = null;
      }
      if (wsAuthTimerRef.current !== null) {
        window.clearTimeout(wsAuthTimerRef.current);
        wsAuthTimerRef.current = null;
      }
    };
  }, [handleWsMessage, trySubscribeAll]);

  const loadMatches = async (options?: { silent?: boolean; fast?: boolean }) => {
    const silent = options?.silent ?? false;
    if (maintenanceActive) {
      if (!silent) {
        message.warning('皇冠系统维护中，已暂停拉取赛事数据');
      }
      setLoading(false);
      return;
    }
    if (!silent) setLoading(false);
    return;
  };

  const handleRefresh = () => {
    if (!requestWsSnapshot(showtype)) {
      loadMatches({ silent: false, fast: true });
    }
  };

  useEffect(() => {
    // 切换 view 时清空 WS 缓冲，避免旧视图的增量合并到新视图
    pendingUpdatesRef.current.clear();
    pendingRemovalsRef.current.clear();
    matchesMapRef.current = new Map();
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    // 优先尝试读取 WS 缓存或本地缓存，避免刷新页面时列表瞬间变成 0 场
    setLoading(false);
    let loadedFromCache = false;
    try {
      const key = buildCacheKey(gtype, showtype);
      const wsMap = wsMatchesByTypeRef.current.get(showtype);
      if (wsMap && wsMap.size > 0) {
        matchesViewKeyRef.current = key;
        setMatches(Array.from(wsMap.values()));
        matchesMapRef.current = new Map(wsMap);
        const wsAt = wsFullDataAtRef.current.get(key);
        if (wsAt) setLastUpdatedAt(wsAt);
        loadedFromCache = true;
      }
      const ttl = getCacheTtl(showtype);
      if (!loadedFromCache) {
        const inMemory = viewCacheRef.current.get(key);
        const inMemoryAge = inMemory?.lastUpdatedAt ? Date.now() - inMemory.lastUpdatedAt : Number.POSITIVE_INFINITY;
        if (inMemory && inMemoryAge < ttl) {
          matchesViewKeyRef.current = key;
          setMatches(inMemory.matches);
          const map = new Map<string, any>();
          for (const item of inMemory.matches) {
            const gid = getMatchGid(item);
            if (!gid) continue;
            map.set(gid, item);
          }
          matchesMapRef.current = map;
          setLastUpdatedAt(inMemory.lastUpdatedAt ?? null);
          loadedFromCache = true;
        }
      }
      if (!loadedFromCache) {
        const raw = window.localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          const cacheAge = parsed.lastUpdatedAt ? Date.now() - parsed.lastUpdatedAt : Number.POSITIVE_INFINITY;
          const valid = cacheAge < ttl;
          if (valid && Array.isArray(parsed.matches)) {
            matchesViewKeyRef.current = key;
            setMatches(parsed.matches);
            const map = new Map<string, any>();
            for (const item of parsed.matches) {
              const gid = getMatchGid(item);
              if (!gid) continue;
              map.set(gid, item);
            }
            matchesMapRef.current = map;
            loadedFromCache = true;
          }
          if (valid) {
            setLastUpdatedAt(parsed.lastUpdatedAt ?? null);
          } else if (!loadedFromCache && Array.isArray(parsed.matches) && parsed.matches.length > 0 && cacheAge < 3600000) {
            // 允许使用 1 小时内的旧缓存，避免首屏空白
            matchesViewKeyRef.current = key;
            setMatches(parsed.matches);
            const map = new Map<string, any>();
            for (const item of parsed.matches) {
              const gid = getMatchGid(item);
              if (!gid) continue;
              map.set(gid, item);
            }
            matchesMapRef.current = map;
            setLastUpdatedAt(parsed.lastUpdatedAt ?? null);
            loadedFromCache = true;
          }
        }
      }
    } catch {
      // 读缓存失败忽略
    }

    if (!loadedFromCache) {
      matchesViewKeyRef.current = buildCacheKey(gtype, showtype);
      setMatches([]);
      setLastUpdatedAt(null);
    }

    // 首屏/切换优先尝试 WS 快照，API 兜底只在 WS 不可用时触发
    const snapshotRequested = requestWsSnapshot(showtype);
    if (!snapshotRequested) {
      loadMatches({ silent: loadedFromCache, fast: true });
    }
    // const interval = setInterval(loadMatches, 10000);
    // return () => clearInterval(interval);
  }, [showtype, gtype, getCacheTtl]);

  // 每次获得新的非空赛事列表时，写入 localStorage，做简单持久化
  useEffect(() => {
    try {
      if (matches) {
        const shouldPersist = matches.length > 0 || lastUpdatedAt !== null;
        if (!shouldPersist) return;
        const now = Date.now();
        // 赔率更新频率很高，频繁 stringify 会卡 UI，这里做节流（>=10s 才写一次）
        if (now - lastCacheWriteAtRef.current < 10000) return;
        lastCacheWriteAtRef.current = now;

        const key = buildCacheKey(gtype, showtype);
        const payload = { matches, lastUpdatedAt };

        const write = () => {
          try {
            window.localStorage.setItem(key, JSON.stringify(payload));
          } catch {
            // ignore
          }
        };

        const ric = (window as any).requestIdleCallback as undefined | ((cb: () => void, opts?: { timeout?: number }) => number);
        const cic = (window as any).cancelIdleCallback as undefined | ((id: number) => void);
        if (typeof ric === 'function') {
          const id = ric(write, { timeout: 2000 });
          return () => { if (typeof cic === 'function') cic(id); };
        }
        const id = window.setTimeout(write, 0);
        return () => window.clearTimeout(id);
      }
    } catch {
      // 本地存储失败忽略
    }
  }, [matches, gtype, showtype, lastUpdatedAt]);

  const filtered = useMemo(() => {
    if (!search.trim()) return matches;
    const k = search.trim().toLowerCase();
    return matches.filter((m: any) => {
      const leagueLabel = m.league || m.league_name;
      const homeLabel = m.home || m.home_team;
      const awayLabel = m.away || m.away_team;
      return [leagueLabel, homeLabel, awayLabel].some((v: any) => String(v || '').toLowerCase().includes(k));
    });
  }, [matches, search]);

  const visibleMatches = useMemo(() => {
    if (!Array.isArray(filtered) || filtered.length === 0) return [];
    return filtered.slice(0, Math.max(0, renderLimit));
  }, [filtered, renderLimit]);

  useEffect(() => {
    if (renderLimit >= filtered.length) return;
    const el = loadMoreSentinelRef.current;
    if (!el) return;
    const IO = (window as any).IntersectionObserver as undefined | typeof IntersectionObserver;
    if (typeof IO !== 'function') return;

    const observer = new IO(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setRenderLimit((prev) => Math.min(prev + (isMobile ? 30 : 60), filtered.length));
      },
      { root: null, rootMargin: '600px 0px', threshold: 0.01 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [filtered.length, renderLimit, isMobile]);

  const getMatchSnapshot = useCallback((matchId: string | number | undefined | null) => {
    if (matchId === undefined || matchId === null) return null;
    const target = String(matchId);
    return matches.find((m: any) => String(m?.crown_gid ?? m?.gid ?? m?.match_id ?? m?.id ?? '') === target) || null;
  }, [matches]);

  const openBetModal = (matchData: any, selection: SelectionMeta) => {
    setSelectedMatch(convertMatch(matchData));
    setSelectionPreset(selection);
    setBetModalKey((prev) => prev + 1);
    setBetModalVisible(true);
  };

  const closeBetModal = () => {
    setBetModalVisible(false);
    setSelectedMatch(null);
    setSelectionPreset(null);
  };

  const renderLastUpdated = () => {
    if (!lastUpdatedAt) return '从未';
    return dayjs(lastUpdatedAt).format('HH:mm:ss');
  };

  const MarketCell = ({ label, odds, onClick }: { label?: string, odds?: string, onClick?: () => void }) => {
    if (!odds) return <div className="market-cell empty"><span className="odds-value-display empty closed">停</span></div>;
    return (
      <div className="market-cell" onClick={onClick}>
        {label && <div className="handicap-label">{label}</div>}
        <div className="odds-value-display">{odds}</div>
      </div>
    );
  };

  return (
    <div className="matches-page" style={{ padding: isMobile ? 0 : '4px 8px' }}>
      <Card className="matches-filter-card glass-panel" bodyStyle={{ padding: isMobile ? 12 : 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <Select
              value={gtype}
              onChange={(v) => setGtype(v as any)}
              style={{ width: 110 }}
              size="large"
              options={[{ label: '足球', value: 'ft' }, { label: '篮球', value: 'bk' }]}
            />
            <Select
              value={showtype}
              onChange={(v) => setShowtype(v as any)}
              style={{ width: 110 }}
              size="large"
              options={[{ label: '滚球', value: 'live' }, { label: '今日', value: 'today' }, { label: '明日', value: 'early' }]}
            />
            <div className="matches-meta">当前赛事：{filtered.length} 场</div>
            <div className="matches-meta">最后更新：{renderLastUpdated()}</div>
            <Button
              icon={<ReloadOutlined />}
              size="large"
              onClick={handleRefresh}
              loading={loading}
              disabled={maintenanceActive}
            >
              刷新
            </Button>
          </div>
          <Input
            allowClear
            placeholder="搜索联赛/球队"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: isMobile ? '100%' : 240, marginTop: isMobile ? 8 : 0 }}
          />
        </div>
        {maintenanceActive ? (
          <div style={{ marginTop: 12 }}>
            <Alert type="warning" showIcon message="皇冠系统维护中" description={maintenanceDescription} />
          </div>
        ) : null}
      </Card>

      <Card className="matches-card glass-panel">
        <Spin spinning={!maintenanceActive && loading && matches.length === 0} tip="加载中..." delay={200}>
          {filtered.length === 0 ? (
            <Empty description={maintenanceActive ? '皇冠维护中，数据暂停更新' : '暂无赛事'} />
          ) : (
            <div className="matches-table-container">
              {visibleMatches.map((m: any, idx: number) => {
                const leagueLabel = manualName(m.league ?? m.league_name, '未识别联赛');
                const homeLabel = manualName(m.home ?? m.home_team, '-');
                const awayLabel = manualName(m.away ?? m.away_team, '-');
                // 优先使用 retimeset（如 "2H^93:26"），否则用 period/clock
                const retimeset = extractRetimeset(m);
                const period = retimeset || m.period || m.match_period || '';
                const clock = m.clock || '';
                const scoreLabel = buildScoreLabel(m);
                const homeRed = extractRedCardCount(m, 'home');
                const awayRed = extractRedCardCount(m, 'away');
                const markets = m.markets || {};

	                const fullHdp = markets.full?.handicapLines || (markets.handicap ? [markets.handicap] : []);
	                const fullOu = markets.full?.overUnderLines || (markets.ou ? [markets.ou] : []);

	                // 角球盘口（全场）：优先使用后端标准 markets.corners，其次兼容 WS 的 markets.cornerFull
	                const cornerFullSource = markets.corners || (markets as any).cornerFull || {};
	                const rawCornerFullHdp = cornerFullSource.handicapLines || [];
	                const rawCornerFullOu = cornerFullSource.overUnderLines || [];
	                const isFromWsCornerFull = !markets.corners && !!(markets as any).cornerFull;
	                const pickMainLines = (lines: any[]): any[] => {
	                  if (!Array.isArray(lines) || lines.length === 0) return [];
	                  const masters = lines.filter(
	                    (ln: any) => ln?.__meta?.isMaster === 'Y' || ln?.isMaster === 'Y',
	                  );
	                  if (masters.length > 0) return [masters[0]];
	                  return [lines[0]];
	                };
	                const cornerFullHdpBase = pickMainLines(rawCornerFullHdp);
	                const cornerFullOuBase = pickMainLines(rawCornerFullOu);
	                const cornerFullHdp = isFromWsCornerFull
	                  ? cornerFullHdpBase.map((line: any) => ({ ...line, __isCorner: true }))
	                  : cornerFullHdpBase;
	                const cornerFullOu = isFromWsCornerFull
	                  ? cornerFullOuBase.map((line: any) => ({ ...line, __isCorner: true }))
	                  : cornerFullOuBase;

	                // 用于展示的全场让球/大小 = 普通 + 角球（角球在下方）
	                const displayFullHdp = [...fullHdp, ...cornerFullHdp];
	                const displayFullOu = [...fullOu, ...cornerFullOu];

	                const halfHdpBase = markets.half?.handicapLines || (markets.half?.handicap ? [markets.half.handicap] : []);
	                const halfOuBase = markets.half?.overUnderLines || (markets.half?.ou ? [markets.half.ou] : []);

	                // 角球盘口（半场）：兼容 WS 的 markets.cornerHalf（也只取一个主盘口）
	                const cornerHalfSource = (markets as any).cornerHalf || {};
	                const rawCornerHalfHdp = cornerHalfSource.handicapLines || [];
	                const rawCornerHalfOu = cornerHalfSource.overUnderLines || [];
	                const cornerHalfHdpBase = pickMainLines(rawCornerHalfHdp);
	                const cornerHalfOuBase = pickMainLines(rawCornerHalfOu);
	                const cornerHalfHdp = cornerHalfHdpBase.map((line: any) => ({
	                  ...line,
	                  __isCorner: true,
	                }));
	                const cornerHalfOu = cornerHalfOuBase.map((line: any) => ({
	                  ...line,
	                  __isCorner: true,
	                }));

	                // 半场盘口只显示 3 行，但要优先保证角球那一行在 3 行里
	                const selectWithCornerPriority = (lines: any[], max: number): any[] => {
	                  if (!Array.isArray(lines) || lines.length <= max) return lines;
	                  const corners = lines.filter((ln: any) => (ln as any).__isCorner);
	                  const normals = lines.filter((ln: any) => !(ln as any).__isCorner);
	                  const result: any[] = [];
	                  const normalLimit = corners.length ? max - 1 : max;
	                  result.push(...normals.slice(0, normalLimit));
	                  if (corners.length) result.push(corners[0]);
	                  return result.slice(0, max);
	                };

	                // 半场盘口 = 普通 + 角球
	                const halfHdp = [...halfHdpBase, ...cornerHalfHdp];
	                const halfOu = [...halfOuBase, ...cornerHalfOu];
                const fullMl = markets.moneyline || markets.full?.moneyline || {};
                const halfMl = markets.half?.moneyline || {};

                const liveClock = buildLiveClock(period, clock);
                let displayTime = '';
                if (showtype === 'live') {
                  displayTime = formatRunningTime(liveClock || retimeset, gtype);
                } else {
                  displayTime = liveClock;
                }
                if (!displayTime) {
                  // 非滚球：只显示时间 HH:mm
                  const rawTime = m.time || '';
                  if (rawTime) {
                    // 如果已有时间格式如 "07:00" 或 "11-26 07:00"，提取时间部分
                    const timeMatch = rawTime.match(/(\d{1,2}:\d{2})/);
                    displayTime = timeMatch ? timeMatch[1] : rawTime;
                  } else if (m.match_time) {
                    try {
                      const date = new Date(m.match_time);
                      const chinaTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
                      const hours = String(chinaTime.getUTCHours()).padStart(2, '0');
                      const minutes = String(chinaTime.getUTCMinutes()).padStart(2, '0');
                      displayTime = `${hours}:${minutes}`;
                    } catch { displayTime = ''; }
                  }
                }

                return (
                  <div key={String(m.gid ?? m.match_id ?? idx)} className="match-block">
                    {/* Left: Home Team */}
                    <div className="team-col team-home">{renderTeamLabel(homeLabel, homeRed)}</div>

                    {/* Center: Match Info + Markets */}
                    <div className="match-center-block">
                      {/* Match Info Header */}
                      <div className="match-info-header">
                        <span className="league-name">{leagueLabel}</span>
                        {isMobile && (
                          <div className="mobile-teams-row">
                            <span className="mobile-team-home">{renderTeamLabel(homeLabel, homeRed)}</span>
                            <span className="mobile-score">{scoreLabel || 'vs'}</span>
                            <span className="mobile-team-away">{renderTeamLabel(awayLabel, awayRed)}</span>
                          </div>
                        )}
                        {!isMobile && scoreLabel && <span className="score-display">({scoreLabel})</span>}
                        <span className="time-display">{displayTime}</span>
                      </div>

                      {/* Markets Grid - Horizontal Layout */}
                      <div className="markets-grid">
                        {/* Full Moneyline */}
                        <div className="market-section">
                          <div className="market-title">独赢(1/2/X)</div>
                          <div className="market-odds-grid moneyline-grid">
                            <OddsCell value={fullMl.home} onClick={() => fullMl.home && openBetModal(m, { bet_type: '独赢', bet_option: homeLabel, odds: fullMl.home, label: `[独赢] ${homeLabel} @${fullMl.home}`, market_category: 'moneyline', market_scope: 'full', market_side: 'home' })} />
                            <OddsCell value={fullMl.away} onClick={() => fullMl.away && openBetModal(m, { bet_type: '独赢', bet_option: awayLabel, odds: fullMl.away, label: `[独赢] ${awayLabel} @${fullMl.away}`, market_category: 'moneyline', market_scope: 'full', market_side: 'away' })} />
                            <OddsCell value={fullMl.draw} onClick={() => fullMl.draw && openBetModal(m, { bet_type: '独赢', bet_option: '和局', odds: fullMl.draw, label: `[独赢] 和局 @${fullMl.draw}`, market_category: 'moneyline', market_scope: 'full', market_side: 'draw' })} />
                          </div>
                        </div>

                        {/* Full Handicap (含角球让球) */}
                        <div className="market-section">
                          <div className="market-title">让球(1/2)</div>
                          <div className="market-odds-grid handicap-grid">
                            {displayFullHdp.map((line: any, i: number) => {
                              const rawHdp = line.hdp ?? line.line;
                              const decimal = parseHandicapDecimal(rawHdp);
                              const baseLabel = decimal !== null ? formatHandicapValue(decimal) : rawHdp;
                              const isCorner = (line as any).__isCorner || (line as any).__meta?.mode === 'CN';
                              const displayHdp = isCorner ? `角球 ${baseLabel}` : baseLabel;
                              return (
                                <React.Fragment key={`${isCorner ? 'cn' : 'ft'}:${String(rawHdp ?? i)}`}>
                                  <div className="hdp-label-cell">{displayHdp}</div>
                                  <OddsCell value={line.home} onClick={() => line.home && openBetModal(m, { bet_type: isCorner ? '角球让球' : '让球', bet_option: `${homeLabel} (${displayHdp})`, odds: line.home, label: `[${isCorner ? '角球让球' : '让球'}] ${homeLabel} (${displayHdp}) @${line.home}`, market_category: 'handicap', market_scope: 'full', market_side: 'home', market_line: rawHdp, market_index: i, market_wtype: isCorner ? 'CNR' : undefined, market_rtype: isCorner ? 'CNRH' : undefined, market_gid: (line as any)?.__meta?.gid, market_hgid: (line as any)?.__meta?.hgid })} />
                                  <OddsCell value={line.away} onClick={() => line.away && openBetModal(m, { bet_type: isCorner ? '角球让球' : '让球', bet_option: `${awayLabel} (${displayHdp})`, odds: line.away, label: `[${isCorner ? '角球让球' : '让球'}] ${awayLabel} (${displayHdp}) @${line.away}`, market_category: 'handicap', market_scope: 'full', market_side: 'away', market_line: rawHdp, market_index: i, market_wtype: isCorner ? 'CNR' : undefined, market_rtype: isCorner ? 'CNRC' : undefined, market_gid: (line as any)?.__meta?.gid, market_hgid: (line as any)?.__meta?.hgid })} />
                                </React.Fragment>
                              );
                            })}
                          </div>
                        </div>

                        {/* Full Over/Under (含角球大小) */}
                        <div className="market-section">
                          <div className="market-title">大小(O/U)</div>
                          <div className="market-odds-grid handicap-grid">
                            {displayFullOu.map((line: any, i: number) => {
                              const rawHdp = line.hdp ?? line.line;
                              const decimal = parseHandicapDecimal(rawHdp);
                              const baseLabel = decimal !== null
                                ? formatHandicapValue(Math.abs(decimal)).replace(/^[-+]/, '')
                                : rawHdp;
                              const isCorner = (line as any).__isCorner || (line as any).__meta?.mode === 'CN';
                              const displayHdp = isCorner ? `角球 ${baseLabel}` : baseLabel;
                              return (
                                <React.Fragment key={`${isCorner ? 'cn' : 'ft'}:${String(rawHdp ?? i)}`}>
                                  <div className="hdp-label-cell">{displayHdp}</div>
                                  <OddsCell value={line.over} onClick={() => line.over && openBetModal(m, { bet_type: isCorner ? '角球大小' : '大小', bet_option: `大 ${displayHdp}`, odds: line.over, label: `[${isCorner ? '角球大小' : '大小'}] 大 ${displayHdp} @${line.over}`, market_category: 'overunder', market_scope: 'full', market_side: 'over', market_line: rawHdp, market_index: i, market_wtype: isCorner ? 'CNOU' : undefined, market_rtype: isCorner ? 'CNOUC' : undefined, market_gid: (line as any)?.__meta?.gid, market_hgid: (line as any)?.__meta?.hgid })} />
                                  <OddsCell value={line.under} onClick={() => line.under && openBetModal(m, { bet_type: isCorner ? '角球大小' : '大小', bet_option: `小 ${displayHdp}`, odds: line.under, label: `[${isCorner ? '角球大小' : '大小'}] 小 ${displayHdp} @${line.under}`, market_category: 'overunder', market_scope: 'full', market_side: 'under', market_line: rawHdp, market_index: i, market_wtype: isCorner ? 'CNOU' : undefined, market_rtype: isCorner ? 'CNOUH' : undefined, market_gid: (line as any)?.__meta?.gid, market_hgid: (line as any)?.__meta?.hgid })} />
                                </React.Fragment>
                              );
                            })}
                          </div>
                        </div>

                        {/* Half Moneyline */}
                        <div className="market-section">
                          <div className="market-title">独赢(半场)</div>
                          <div className="market-odds-grid moneyline-grid">
                            <OddsCell value={halfMl.home} onClick={() => halfMl.home && openBetModal(m, { bet_type: '半场独赢', bet_option: homeLabel, odds: halfMl.home, label: `[半场独赢] ${homeLabel} @${halfMl.home}`, market_category: 'moneyline', market_scope: 'half', market_side: 'home' })} />
                            <OddsCell value={halfMl.away} onClick={() => halfMl.away && openBetModal(m, { bet_type: '半场独赢', bet_option: awayLabel, odds: halfMl.away, label: `[半场独赢] ${awayLabel} @${halfMl.away}`, market_category: 'moneyline', market_scope: 'half', market_side: 'away' })} />
                            <OddsCell value={halfMl.draw} onClick={() => halfMl.draw && openBetModal(m, { bet_type: '半场独赢', bet_option: '和局', odds: halfMl.draw, label: `[半场独赢] 和局 @${halfMl.draw}`, market_category: 'moneyline', market_scope: 'half', market_side: 'draw' })} />
                          </div>
                        </div>

                        {/* Half Handicap (含角球让球) */}
                        <div className="market-section">
                          <div className="market-title">让球(半场)</div>
                          <div className="market-odds-grid handicap-grid">
                            {halfHdp.map((line: any, i: number) => {
                              const rawHdp = line.hdp ?? line.line;
                              const decimal = parseHandicapDecimal(rawHdp);
                              const baseLabel = decimal !== null ? formatHandicapValue(decimal) : rawHdp;
                              const isCorner = (line as any).__isCorner || (line as any).__meta?.mode === 'CN';
                              const displayHdp = isCorner ? `角球 ${baseLabel}` : baseLabel;
                              return (
                                <React.Fragment key={`${isCorner ? 'cn' : 'ft'}:${String(rawHdp ?? i)}`}>
                                  <div className="hdp-label-cell">{displayHdp}</div>
                                  <OddsCell value={line.home} onClick={() => line.home && openBetModal(m, { bet_type: isCorner ? '半场角球让球' : '半场让球', bet_option: `${homeLabel} (${displayHdp})`, odds: line.home, label: `[${isCorner ? '半场角球让球' : '半场让球'}] ${homeLabel} (${displayHdp}) @${line.home}`, market_category: 'handicap', market_scope: 'half', market_side: 'home', market_line: rawHdp, market_index: i, market_wtype: isCorner ? 'HCNR' : undefined, market_rtype: isCorner ? 'HCNRH' : undefined, market_gid: (line as any)?.__meta?.gid, market_hgid: (line as any)?.__meta?.hgid })} />
                                  <OddsCell value={line.away} onClick={() => line.away && openBetModal(m, { bet_type: isCorner ? '半场角球让球' : '半场让球', bet_option: `${awayLabel} (${displayHdp})`, odds: line.away, label: `[${isCorner ? '半场角球让球' : '半场让球'}] ${awayLabel} (${displayHdp}) @${line.away}`, market_category: 'handicap', market_scope: 'half', market_side: 'away', market_line: rawHdp, market_index: i, market_wtype: isCorner ? 'HCNR' : undefined, market_rtype: isCorner ? 'HCNRC' : undefined, market_gid: (line as any)?.__meta?.gid, market_hgid: (line as any)?.__meta?.hgid })} />
                                </React.Fragment>
                              );
                            })}
                          </div>
                        </div>

                        {/* Half Over/Under (含角球大小) */}
                        <div className="market-section">
                          <div className="market-title">大小(O/U半)</div>
                          <div className="market-odds-grid handicap-grid">
                            {halfOu.map((line: any, i: number) => {
                              const rawHdp = line.hdp ?? line.line;
                              const decimal = parseHandicapDecimal(rawHdp);
                              const baseLabel = decimal !== null
                                ? formatHandicapValue(Math.abs(decimal)).replace(/^[-+]/, '')
                                : rawHdp;
                              const isCorner = (line as any).__isCorner || (line as any).__meta?.mode === 'CN';
                              const displayHdp = isCorner ? `角球 ${baseLabel}` : baseLabel;
                              return (
                                <React.Fragment key={`${isCorner ? 'cn' : 'ft'}:${String(rawHdp ?? i)}`}>
                                  <div className="hdp-label-cell">{displayHdp}</div>
                                  <OddsCell value={line.over} onClick={() => line.over && openBetModal(m, { bet_type: isCorner ? '半场角球大小' : '半场大小', bet_option: `大 ${displayHdp}`, odds: line.over, label: `[${isCorner ? '半场角球大小' : '半场大小'}] 大 ${displayHdp} @${line.over}`, market_category: 'overunder', market_scope: 'half', market_side: 'over', market_line: rawHdp, market_index: i, market_wtype: isCorner ? 'HCNOU' : undefined, market_rtype: isCorner ? 'HCNOUC' : undefined, market_gid: (line as any)?.__meta?.gid, market_hgid: (line as any)?.__meta?.hgid })} />
                                  <OddsCell value={line.under} onClick={() => line.under && openBetModal(m, { bet_type: isCorner ? '半场角球大小' : '半场大小', bet_option: `小 ${displayHdp}`, odds: line.under, label: `[${isCorner ? '半场角球大小' : '半场大小'}] 小 ${displayHdp} @${line.under}`, market_category: 'overunder', market_scope: 'half', market_side: 'under', market_line: rawHdp, market_index: i, market_wtype: isCorner ? 'HCNOU' : undefined, market_rtype: isCorner ? 'HCNOUH' : undefined, market_gid: (line as any)?.__meta?.gid, market_hgid: (line as any)?.__meta?.hgid })} />
                                </React.Fragment>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Right: Away Team */}
                    <div className="team-col team-away">{renderTeamLabel(awayLabel, awayRed)}</div>
                  </div>
                );
              })}
              <div ref={loadMoreSentinelRef} style={{ height: 1 }} />
              {visibleMatches.length < filtered.length && (
                <div style={{ padding: 12, textAlign: 'center' }}>
                  <Button
                    size="large"
                    onClick={() => setRenderLimit((prev) => Math.min(prev + (isMobile ? 30 : 60), filtered.length))}
                  >
                    加载更多（{visibleMatches.length}/{filtered.length}）
                  </Button>
                </div>
              )}
            </div>
          )}
        </Spin>
      </Card>
      <BetFormModal
        key={betModalKey}
        visible={betModalVisible}
        match={selectedMatch}
        accounts={accounts}
        defaultSelection={selectionPreset}
        getMatchSnapshot={getMatchSnapshot}
        onCancel={closeBetModal}
        onSubmit={() => {
          closeBetModal();
          fetchAccounts(true);
        }}
      />
    </div>
  );
};

export default MatchesPage;
