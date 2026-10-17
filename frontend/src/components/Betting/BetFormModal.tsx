import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Modal,
  Form,
  Select,
  InputNumber,
  Input,
  Row,
  Col,
  Space,
  Tag,
  Checkbox,
  message,
  Button,
  Spin,
  Empty,
  Tooltip,
} from 'antd';
import { TrophyOutlined, ReloadOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import type { Match, CrownAccount, BetCreateRequest, AccountSelectionResponse, Group } from '../../types';
import { betApi, accountApi, crownApi, groupApi } from '../../services/api';
import dayjs from 'dayjs';
import type { AxiosError } from 'axios';

const { Option } = Select;

const generateBetIdempotencyKey = (): string => {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return `bet-${cryptoObj.randomUUID()}`;
  }

  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    const random = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `bet-${random}`;
  }

  return `bet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
};


const normalizeLineText = (value: any): string => String(value ?? '').trim();

const parseLineToDecimal = (value: any): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  if (!raw) return null;

  const cleaned = raw.replace(/[^\d./+\-\s]/g, '').replace(/\s+/g, '');
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
    const num = Number.parseFloat(part);
    if (Number.isFinite(num)) values.push(num * localSign);
  }
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
  return Number.isFinite(avg) ? avg : null;
};

const sameLine = (a: any, b: any): boolean => {
  const an = parseLineToDecimal(a);
  const bn = parseLineToDecimal(b);
  if (an !== null && bn !== null) {
    return Math.abs(an - bn) < 0.01;
  }
  return normalizeLineText(a) === normalizeLineText(b);
};

const formatHandicapValue = (value: number | null): string => {
  if (value === null || Number.isNaN(value)) return '';
  if (Math.abs(value) < 1e-4) return '0';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const absValue = Math.abs(value);
  const str = Number.isInteger(absValue) ? absValue.toString() : absValue.toFixed(2).replace(/\.?0+$/, '');
  return `${sign}${str}`;
};

const buildDisplayLine = (rawLine: any, category: MarketCategory, isCorner: boolean): string => {
  const decimal = parseLineToDecimal(rawLine);
  let baseLabel = normalizeLineText(rawLine);
  if (decimal !== null) {
    baseLabel = category === 'overunder'
      ? formatHandicapValue(Math.abs(decimal)).replace(/^[-+]/, '')
      : formatHandicapValue(decimal);
  }
  if (!baseLabel) return '';
  return isCorner ? `角球 ${baseLabel}` : baseLabel;
};

export type MarketCategory = 'moneyline' | 'handicap' | 'overunder';
export type MarketScope = 'full' | 'half';
export type MarketSide = 'home' | 'away' | 'draw' | 'over' | 'under';

export interface SelectionMeta {
  bet_type: string;
  bet_option: string;
  odds: number | string;
  label?: string;
  market_category?: MarketCategory;
  market_scope?: MarketScope;
  market_side?: MarketSide;
  market_line?: string;
  market_index?: number;
  market_wtype?: string;
  market_rtype?: string;
  market_chose_team?: 'H' | 'C' | 'N';
  market_gid?: string;
  market_hgid?: string;
}

interface BetFormModalProps {
  visible: boolean;
  match: Match | null;
  accounts: CrownAccount[];
  onCancel: () => void;
  onSubmit: () => void;
  defaultSelection?: SelectionMeta | null;
  getMatchSnapshot?: (matchId: string | number | undefined | null) => any;
}

const BetFormModal: React.FC<BetFormModalProps> = ({
  visible,
  match,
  accounts,
  onCancel,
  onSubmit,
  defaultSelection,
  getMatchSnapshot,
}) => {
  const [form] = Form.useForm();
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const submittingRef = useRef(false);
  const selectionSyncKeyRef = useRef('');

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  const [loading, setLoading] = useState(false);
  const [selectedAccounts, setSelectedAccounts] = useState<number[]>([]);
  const [estimatedPayout, setEstimatedPayout] = useState(0);
  const [betMode, setBetMode] = useState<'优选' | '平均'>('优选');
  const [autoSelection, setAutoSelection] = useState<AccountSelectionResponse | null>(null);
  const [autoLoading, setAutoLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [oddsPreview, setOddsPreview] = useState<{ odds: number | null; closed: boolean; message?: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [autoRefreshOdds, setAutoRefreshOdds] = useState(true); // 自动刷新赔率开关
  const [maxBetAmount, setMaxBetAmount] = useState<string | number | null>(null);
  const [maxBetLoading, setMaxBetLoading] = useState(false);
  const [maxBetError, setMaxBetError] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);

  // 监听表单值变化以触发重渲染
  const totalAmount = Form.useWatch('total_amount', form);
  const singleLimit = Form.useWatch('single_limit', form);
  const intervalRange = Form.useWatch('interval_range', form);
  const quantity = Form.useWatch('quantity', form);
  const minOdds = Form.useWatch('min_odds', form);

  const groupAccounts = useMemo(() => {
    if (selectedGroupId === null) return [];
    return accounts.filter(account => account.group_id === selectedGroupId);
  }, [accounts, selectedGroupId]);

  const accountDict = useMemo(() => {
    const map = new Map<number, CrownAccount>();
    groupAccounts.forEach(acc => map.set(acc.id, acc));
    return map;
  }, [groupAccounts]);

  const selectionMeta = defaultSelection || undefined;
  const matchKey = match ? (match.crown_gid || match.gid || match.match_id || match.id) : null;
  const marketSnapshot = useMemo(() => {
    if (!matchKey) return match;
    if (!getMatchSnapshot) return match;
    return getMatchSnapshot(matchKey) || match;
  }, [matchKey, match, getMatchSnapshot]);

  const normalizeId = (value: any): string | null => {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text ? text : null;
  };

  const extractHgidFromRaw = (raw: any): string | null => {
    if (!raw || typeof raw !== 'object') return null;
    const direct = normalizeId((raw as any).HGID ?? (raw as any).hgid);
    if (direct) return direct;

    const game = (raw as any).game;
    if (Array.isArray(game) && game.length > 0) {
      return normalizeId(game[0]?.HGID ?? game[0]?.hgid);
    }
    if (game && typeof game === 'object') {
      return normalizeId((game as any).HGID ?? (game as any).hgid);
    }
    return null;
  };

  const resolvedSelection = useMemo(() => {
    if (!selectionMeta || !marketSnapshot) return null;
    const category = selectionMeta.market_category;
    if (!category) return null;
    const scope: MarketScope = (selectionMeta.market_scope || 'full') as MarketScope;
    const markets = (marketSnapshot as any).markets || {};
    const isCorner = String(selectionMeta.market_wtype || '').toUpperCase().includes('CN')
      || String(selectionMeta.bet_type || '').includes('角球');

    const homeName = match?.home_team || '';
    const awayName = match?.away_team || '';

    if (category === 'moneyline') {
      const ml = scope === 'half'
        ? markets?.half?.moneyline || markets?.half?.moneyLine
        : markets?.moneyline || markets?.moneyLine || markets?.full?.moneyline;
      if (!ml) return null;
      const side = selectionMeta.market_side || (selectionMeta.bet_option === '和局' ? 'draw' : 'home');
      const odds = side === 'away' ? ml.away : side === 'draw' ? ml.draw : ml.home;
      if (odds === undefined || odds === null) return null;
      const betOption = side === 'away' ? awayName : side === 'draw' ? '和局' : homeName;
      const label = selectionMeta.bet_type && betOption
        ? `[${selectionMeta.bet_type}] ${betOption} @${odds}`
        : selectionMeta.label;
      return {
        ...selectionMeta,
        odds,
        bet_option: betOption,
        label,
      };
    }

    const pickLineEntry = (lines: any[]) => {
      if (!Array.isArray(lines) || lines.length === 0) return null;
      const targetLine = selectionMeta.market_line;
      if (targetLine !== undefined && targetLine !== null) {
        const foundIndex = lines.findIndex(item => sameLine(item?.line ?? item?.hdp, targetLine));
        if (foundIndex >= 0) return { entry: lines[foundIndex], index: foundIndex };
      }
      if (selectionMeta.market_index !== undefined && selectionMeta.market_index !== null) {
        const idx = Number(selectionMeta.market_index);
        if (Number.isFinite(idx) && lines[idx]) return { entry: lines[idx], index: idx };
      }
      return { entry: lines[0], index: 0 };
    };

    if (category === 'handicap' || category === 'overunder') {
      const lines = category === 'handicap'
        ? (scope === 'half'
          ? markets?.half?.handicapLines || (markets?.half?.handicap ? [markets.half.handicap] : [])
          : markets?.full?.handicapLines || (markets?.handicap ? [markets.handicap] : []))
        : (scope === 'half'
          ? markets?.half?.overUnderLines || (markets?.half?.ou ? [markets.half.ou] : [])
          : markets?.full?.overUnderLines || (markets?.ou ? [markets.ou] : []));

      const picked = pickLineEntry(lines);
      if (!picked) return null;
      const entry = picked.entry || {};
      const rawLine = entry.line ?? entry.hdp ?? selectionMeta.market_line;
      const displayLine = buildDisplayLine(rawLine, category, isCorner);
      const side = selectionMeta.market_side;
      const odds = category === 'handicap'
        ? (side === 'away' ? entry.away : entry.home)
        : (side === 'under' ? entry.under : entry.over);
      let betOption = selectionMeta.bet_option;
      if (displayLine) {
        if (category === 'handicap') {
          const teamName = side === 'away' ? awayName : homeName;
          if (teamName) betOption = `${teamName} (${displayLine})`;
        } else {
          const prefix = side === 'under' ? '小' : '大';
          betOption = `${prefix} ${displayLine}`;
        }
      }
      const oddsLabel = odds ?? selectionMeta.odds;
      const label = selectionMeta.bet_type && betOption && oddsLabel !== undefined && oddsLabel !== null
        ? `[${selectionMeta.bet_type}] ${betOption} @${oddsLabel}`
        : selectionMeta.label;
      const meta = entry?.__meta || entry?.meta || entry?.__META;
      return {
        ...selectionMeta,
        odds: odds ?? selectionMeta.odds,
        bet_option: betOption,
        label,
        market_line: rawLine ?? selectionMeta.market_line,
        market_index: picked.index ?? selectionMeta.market_index,
        market_gid: normalizeId(meta?.gid ?? entry?.gid ?? entry?.id) || selectionMeta.market_gid,
        market_hgid: normalizeId(meta?.hgid ?? entry?.hgid) || selectionMeta.market_hgid,
      };
    }

    return null;
  }, [selectionMeta, marketSnapshot, match, normalizeId]);

  const activeSelection = resolvedSelection || selectionMeta;
  const selectionLabel = activeSelection?.label || '';

  const marketIdsFromSnapshot = useMemo(() => {
    if (!activeSelection || !marketSnapshot) return { gid: null as string | null, hgid: null as string | null };

    const category = activeSelection.market_category;
    const scope: MarketScope = (activeSelection.market_scope || 'full') as MarketScope;

    const markets = (marketSnapshot as any).markets || {};

    const pickEntry = (lines: any[] | undefined) => {
      if (!Array.isArray(lines) || lines.length === 0) return null;
      const targetLine = activeSelection.market_line;
      if (targetLine !== undefined && targetLine !== null) {
        const found = lines.find((item: any) => sameLine(item?.line ?? item?.hdp, targetLine));
        if (found) return found;
      }
      if (activeSelection.market_index !== undefined && activeSelection.market_index !== null) {
        const idx = Number(activeSelection.market_index);
        if (Number.isFinite(idx) && lines[idx]) return lines[idx];
      }
      return lines[0];
    };

    const extractIds = (entry: any) => {
      const meta = entry?.__meta || entry?.meta || entry?.__META;
      return {
        gid: normalizeId(meta?.gid ?? entry?.gid ?? entry?.id),
        hgid: normalizeId(meta?.hgid ?? entry?.hgid),
      };
    };

    if (category === 'handicap') {
      const lines = scope === 'half'
        ? markets?.half?.handicapLines || (markets?.half?.handicap ? [markets.half.handicap] : [])
        : markets?.full?.handicapLines || (markets?.handicap ? [markets.handicap] : []);
      const entry = pickEntry(lines);
      return extractIds(entry);
    }

    if (category === 'overunder') {
      const lines = scope === 'half'
        ? markets?.half?.overUnderLines || (markets?.half?.ou ? [markets.half.ou] : [])
        : markets?.full?.overUnderLines || (markets?.ou ? [markets.ou] : []);
      const entry = pickEntry(lines);
      return extractIds(entry);
    }

    return { gid: null, hgid: null };
  }, [marketSnapshot, activeSelection]);

  const resolvedCrownMatchId = useMemo(() => {
    const base = normalizeId(match?.crown_gid ?? match?.gid ?? match?.match_id ?? match?.id);
    if (!base) return null;
    if (!activeSelection) return base;

    const scope = activeSelection.market_scope || (activeSelection as any).marketScope;
    const isHalf = scope === 'half';
    if (isHalf) {
      return (
        normalizeId(activeSelection.market_hgid)
        || marketIdsFromSnapshot.hgid
        || extractHgidFromRaw((marketSnapshot as any)?.raw)
        || base
      );
    }

    return normalizeId(activeSelection.market_gid) || marketIdsFromSnapshot.gid || base;
  }, [match, activeSelection, marketSnapshot, marketIdsFromSnapshot]);

  const maxBetKey = useMemo(() => {
    if (!match) return 'no-match';
    return [
      match.id,
      activeSelection?.bet_type ?? '',
      activeSelection?.bet_option ?? '',
      activeSelection?.market_line ?? '',
      activeSelection?.market_index ?? '',
      resolvedCrownMatchId ?? '',
    ].join('|');
  }, [match, activeSelection, resolvedCrownMatchId]);

  const getLineKey = useCallback((accountId: number): string => {
    const meta = autoSelection?.eligible_accounts.find(entry => entry.account.id === accountId)
      || autoSelection?.excluded_accounts.find(entry => entry.account.id === accountId);
    if (meta?.account.line_key) {
      return meta.account.line_key;
    }

    const account = accounts.find(item => item.id === accountId);
    const base = (account?.original_username || account?.username || '').trim();
    return base ? base.slice(0, 4).toUpperCase() : 'UNKNOWN';
  }, [accounts, autoSelection]);

  useEffect(() => {
    if (visible && match) {
      form.resetFields();
      setSelectedAccounts([]);
      setEstimatedPayout(0);
      setMaxBetAmount(null);
      setMaxBetError(null);
      setSelectedGroupId(null);
      const defaults = {
        bet_type: defaultSelection?.bet_type || '让球',
        bet_option: defaultSelection?.bet_option || '主队',
        odds: defaultSelection?.odds || 1.85,
      };
      setAutoSelection(null);
      setAutoLoading(false);
      setOddsPreview(null);
      setPreviewError(null);
      // 设置默认值
      form.setFieldsValue({
        bet_type: defaults.bet_type,
        bet_option: defaults.bet_option,
        bet_amount: 100,
        odds: defaults.odds,
        single_limit: undefined,  // 默认为空，使用账号限额
        interval_seconds: 3,
        quantity: 1,
        min_odds: defaults.odds,
        total_amount: 100,
        interval_range: '1-3',
        group: undefined,
        account_ids: [],
      });
    }
  }, [visible, match, form, defaultSelection]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    const loadGroups = async () => {
      setGroupsLoading(true);
      try {
        const response = await groupApi.getGroups();
        if (cancelled) return;
        if (response.success) {
          setGroups(response.data || []);
        } else {
          setGroups([]);
          message.error(response.error || '获取分组失败');
        }
      } catch (error) {
        if (!cancelled) {
          setGroups([]);
          message.error('获取分组失败');
        }
      } finally {
        if (!cancelled) {
          setGroupsLoading(false);
        }
      }
    };

    loadGroups();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    setMaxBetLoading(false);
    setMaxBetAmount(null);
    setMaxBetError(null);
  }, [visible, maxBetKey]);

  const isTruthy = (value: any): boolean => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      return ['1', 'true', 'TRUE', 'True', 'online', 'ONLINE'].includes(value.trim());
    }
    return !!value;
  };

  const accountMetaMap = useMemo(() => {
    const map = new Map<number, AccountSelectionResponse['eligible_accounts'][number]>();
    if (autoSelection) {
      autoSelection.eligible_accounts.forEach(entry => {
        map.set(entry.account.id, entry);
      });
      autoSelection.excluded_accounts.forEach(entry => {
        map.set(entry.account.id, entry);
      });
    }
    return map;
  }, [autoSelection]);

  const isAccountOnline = useCallback((accountId: number): boolean => {
    const meta = accountMetaMap.get(accountId);
    if (meta) {
      if (meta.flags?.offline) {
        return false;
      }
      if (meta.account && meta.account.is_online !== undefined) {
        return isTruthy(meta.account.is_online);
      }
    }

    const account = accountDict.get(accountId);
    if (account && account.is_online !== undefined) {
      return isTruthy(account.is_online);
    }

    return false;
  }, [accountMetaMap, accountDict]);

  const deriveOddsFromMarkets = useCallback(() => {
    if (!marketSnapshot || !activeSelection) {
      return null;
    }

    const markets = marketSnapshot.markets || {};
    const scope: MarketScope = activeSelection.market_scope || 'full';
    const category: MarketCategory | undefined = activeSelection.market_category;
    const side: MarketSide | undefined = activeSelection.market_side;

    const toNumber = (value: any): number | null => {
      if (value === null || value === undefined || value === '') return null;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    };

    const pickLineEntry = (lines?: Array<{ line?: any; hdp?: any; home?: any; away?: any; over?: any; under?: any }>) => {
      if (!Array.isArray(lines) || lines.length === 0) return null;
      if (activeSelection.market_line !== undefined) {
        const target = activeSelection.market_line;
        const found = lines.find(item => sameLine(item?.line ?? (item as any)?.hdp, target));
        if (found) return found;
      }
      if (activeSelection.market_index !== undefined && activeSelection.market_index !== null) {
        const idx = Number(activeSelection.market_index);
        const entry = Number.isFinite(idx) ? lines[idx] : null;
        if (entry) return entry;
      }
      return lines[0];
    };

    const buildResponse = (value: any) => {
      const numeric = toNumber(value);
      return {
        odds: numeric,
        message: 'WSS 实时赔率',
      };
    };

    if (category === 'moneyline') {
      const ml = scope === 'half'
        ? markets?.half?.moneyline || markets?.half?.moneyLine
        : markets.moneyline || markets.moneyLine;
      if (!ml) return null;
      const value = side === 'away' ? ml.away : side === 'draw' ? ml.draw : ml.home;
      return buildResponse(value);
    }

    if (category === 'handicap') {
      const lines = scope === 'half'
        ? markets?.half?.handicapLines || (markets?.half?.handicap ? [markets.half.handicap] : [])
        : markets?.full?.handicapLines || (markets?.handicap ? [markets.handicap] : []);
      const entry = pickLineEntry(lines);
      if (!entry) return null;
      const value = side === 'away' ? entry.away : entry.home;
      return buildResponse(value);
    }

    if (category === 'overunder') {
      const lines = scope === 'half'
        ? markets?.half?.overUnderLines || (markets?.half?.ou ? [markets.half.ou] : [])
        : markets?.full?.overUnderLines || (markets?.ou ? [markets.ou] : []);
      const entry = pickLineEntry(lines);
      if (!entry) return null;
      const value = side === 'under' ? entry.under : entry.over;
      return buildResponse(value);
    }

    return null;
  }, [marketSnapshot, activeSelection]);

  useEffect(() => {
    if (!visible || !match) return;

    const derived = deriveOddsFromMarkets();
    if (derived) {
      if (!oddsPreview || oddsPreview.message === '当前选中赔率') {
        setOddsPreview({
          odds: derived.odds ?? null,
          closed: false,
          message: derived.message,
        });
        if (derived.odds !== null && derived.odds !== undefined) {
          form.setFieldValue('odds', derived.odds);
        }
      }
      return;
    }

    if (!oddsPreview) {
      const fallback = defaultSelection?.odds;
      const numeric = fallback === undefined || fallback === null ? null : Number(fallback);
      setOddsPreview({
        odds: Number.isFinite(numeric as any) ? (numeric as number) : null,
        closed: false,
        message: '当前选中赔率',
      });
    }
  }, [visible, match, deriveOddsFromMarkets, oddsPreview, defaultSelection, form]);

  const previewOddsRequest = useCallback(async (silent = false) => {
    if (!match) {
      setOddsPreview(null);
      setPreviewError(null);
      return { success: false };
    }

    const currentValues = form.getFieldsValue();

    // 先获取前端计算的赔率作为备用，但不立即设置到 oddsPreview
    const derived = deriveOddsFromMarkets();

    // 获取在线账号列表
    if (selectedGroupId === null) {
      if (derived) {
        setOddsPreview({
          odds: derived.odds ?? null,
          closed: false,
          message: derived.message,
        });
        if (derived.odds !== null) {
          form.setFieldValue('odds', derived.odds);
        }
      } else if (!silent) {
        setOddsPreview(null);
        setPreviewError('请先选择分组');
      }
      return { success: false, message: '请先选择分组' };
    }

    const onlineAccounts = groupAccounts.filter(acc => isAccountOnline(acc.id));
    const onlineAccountIds = onlineAccounts.map(acc => acc.id);
    const selectedOnlineIds = selectedAccounts.filter(id => onlineAccountIds.includes(id));
    const candidateAccountIds = selectedOnlineIds.length > 0
      ? [...selectedOnlineIds, ...onlineAccountIds.filter(id => !selectedOnlineIds.includes(id))]
      : onlineAccountIds;

    if (candidateAccountIds.length === 0) {
      // 没有在线账号时，使用前端计算的赔率
      if (derived) {
        setOddsPreview({
          odds: derived.odds ?? null,
          closed: false,
          message: derived.message,
        });
        if (derived.odds !== null) {
          form.setFieldValue('odds', derived.odds);
        }
      } else if (!silent) {
        setOddsPreview(null);
        setPreviewError('当前分组没有可用的在线账号');
      }
      return { success: false, message: '当前分组没有可用的在线账号' };
    }

    const betTypeValue = currentValues.bet_type ?? activeSelection?.bet_type ?? defaultSelection?.bet_type ?? '让球';
    const betOptionValue = currentValues.bet_option ?? activeSelection?.bet_option ?? defaultSelection?.bet_option ?? '主队';
    const oddsValue = currentValues.odds ?? activeSelection?.odds ?? defaultSelection?.odds ?? 1;

    const basePayload = {
      match_id: match.id,
      crown_match_id: resolvedCrownMatchId || match.crown_gid || match.gid || match.match_id,
      bet_type: betTypeValue,
      bet_option: betOptionValue,
      odds: oddsValue,
      bet_amount: currentValues.bet_amount ?? 0,
      league_name: match.league_name,
      home_team: match.home_team,
      away_team: match.away_team,
      market_category: activeSelection?.market_category,
      market_scope: activeSelection?.market_scope,
      market_side: activeSelection?.market_side,
      market_line: activeSelection?.market_line,
      market_index: activeSelection?.market_index,
      market_wtype: activeSelection?.market_wtype,
      market_rtype: activeSelection?.market_rtype,
      market_chose_team: activeSelection?.market_chose_team,
    };

    if (!silent) {
      setPreviewLoading(true);
    }

    try {
      let lastErrorMsg = '获取赔率失败';
      let lastErrorData: any = null;

      for (const accountId of candidateAccountIds) {
        const payload = { ...basePayload, account_id: accountId };
        const response = await crownApi.previewOdds(payload);

        if (response.success && response.data) {
          const previewData = response.data;

          // 检查盘口线是否匹配（仅记录警告，不阻止下注）
          if (previewData.spread_mismatch) {
            console.warn('⚠️ Crown API 返回的盘口线与用户选择不匹配:', {
              requested: previewData.requested_line,
              returned: previewData.returned_spread,
            });
            // 即使盘口线不完全匹配，仍然使用返回的赔率继续下注
            // 因为皇冠的盘口格式可能与前端显示不同（如 "0 / 0.5" vs "0.25"）
          }

          setOddsPreview({
            odds: previewData.odds ?? null,
            closed: !!previewData.closed,
            message: previewData.message,
          });
          if (previewData.closed) {
            setPreviewError(previewData.message || '盘口已封盘或暂时不可投注');
          } else {
            setPreviewError(null);
          }
          // 更新表单中的赔率
          if (previewData.odds !== null && previewData.odds !== undefined) {
            form.setFieldValue('odds', previewData.odds);
          }
          return { success: true, data: previewData };
        }

        const msg = response.error || response.message || '获取赔率失败';
        lastErrorMsg = msg;
        lastErrorData = response.data;

        // 盘口封盘时不需要继续切换账号
        if (response.data?.closed) {
          if (!silent) {
            setPreviewError(msg);
          }
          setOddsPreview({
            odds: response.data.odds ?? null,
            closed: true,
            message: msg,
          });
          return { success: false, message: msg, data: response.data };
        }
      }

      if (!silent) {
        setPreviewError(lastErrorMsg);
      }
      if (derived) {
        setOddsPreview({
          odds: derived.odds ?? null,
          closed: false,
          message: derived.message,
        });
        if (derived.odds !== null && derived.odds !== undefined) {
          form.setFieldValue('odds', derived.odds);
        }
      } else {
        setOddsPreview(null);
      }
      return { success: false, message: lastErrorMsg, data: lastErrorData };
    } catch (error: any) {
      const msg = error?.response?.data?.error || error?.message || '获取赔率失败';
      if (!silent) {
        setPreviewError(msg);
      }
      if (derived) {
        setOddsPreview({
          odds: derived.odds ?? null,
          closed: false,
          message: derived.message,
        });
        if (derived.odds !== null && derived.odds !== undefined) {
          form.setFieldValue('odds', derived.odds);
        }
      } else {
        setOddsPreview(null);
      }
      return { success: false, message: msg };
    } finally {
      if (!silent) {
        setPreviewLoading(false);
      }
    }
  }, [match, selectedAccounts, form, defaultSelection, groupAccounts, isAccountOnline, deriveOddsFromMarkets, activeSelection, resolvedCrownMatchId, selectedGroupId]);

  useEffect(() => {
    if (!visible || !activeSelection) return;
    const syncKey = [
      activeSelection.bet_type ?? '',
      activeSelection.bet_option ?? '',
      activeSelection.market_line ?? '',
      activeSelection.market_index ?? '',
    ].join('|');
    if (selectionSyncKeyRef.current === syncKey) return;
    selectionSyncKeyRef.current = syncKey;

    if (activeSelection.bet_type) {
      form.setFieldValue('bet_type', activeSelection.bet_type);
    }
    if (activeSelection.bet_option) {
      form.setFieldValue('bet_option', activeSelection.bet_option);
    }
    if (activeSelection.odds !== undefined && activeSelection.odds !== null && activeSelection.odds !== '') {
      const numeric = Number(activeSelection.odds);
      form.setFieldValue('odds', Number.isFinite(numeric) ? numeric : activeSelection.odds);
    }

    previewOddsRequest(true);
  }, [visible, activeSelection, form, previewOddsRequest]);

  // 自动刷新赔率：每 2 秒刷新一次
  const previewOddsRef = React.useRef(previewOddsRequest);
  previewOddsRef.current = previewOddsRequest;

  useEffect(() => {
    if (!visible || !match || !autoRefreshOdds) return;

    // 首次加载时立即获取赔率
    previewOddsRef.current(true);

    // 设置定时器
    const timer = setInterval(() => {
      previewOddsRef.current(true);
    }, 2000); // 每 2 秒刷新一次

    return () => clearInterval(timer);
  }, [visible, match, autoRefreshOdds]);

  const fetchAutoSelection = useCallback(async (limit?: number, silent = false) => {
    if (!match) return;
    if (selectedGroupId === null) {
      if (!silent) {
        message.warning('请先选择分组');
      }
      return;
    }

    try {
      setAutoLoading(true);
      const response = await accountApi.autoSelect({ match_id: match.id, limit, group_id: selectedGroupId });
      if (!response.success || !response.data) {
        if (!silent) {
          message.error(response.error || '优选账号失败');
        }
        return;
      }

      setAutoSelection(response.data);

      const usedLines = new Set<string>();
      const recommended: number[] = [];
      response.data.eligible_accounts.forEach((entry) => {
        if (entry.flags?.offline) {
          return;
        }
        const fallbackOnline = accountDict.get(entry.account.id)?.is_online;
        const entryOnline = entry.account.is_online !== undefined
          ? isTruthy(entry.account.is_online)
          : isTruthy(fallbackOnline);
        if (!entryOnline) {
          return;
        }
        const lineKey = entry.account.line_key || 'UNKNOWN';
        if (usedLines.has(lineKey)) {
          return;
        }
        usedLines.add(lineKey);
        recommended.push(entry.account.id);
      });
      const skippedCount = response.data.eligible_accounts.length - recommended.length;
      if (recommended.length === 0) {
        setSelectedAccounts([]);
        form.setFieldValue('account_ids', []);
        if (!silent) {
          message.warning('当前无符合条件的在线账号');
        }
        return;
      }

      setSelectedAccounts(recommended);
      form.setFieldValue('account_ids', recommended);
      calculatePayout(recommended.length);
      setTimeout(() => {
        previewOddsRequest(true);
      }, 0);

      if (!silent) {
        const baseMsg = `已优选 ${recommended.length} 个在线账号`;
        message.success(skippedCount > 0 ? `${baseMsg}（自动跳过 ${skippedCount} 个同线路账号）` : baseMsg);
      }
    } catch (error) {
      console.error('Auto select accounts failed:', error);
      if (!silent) {
        message.error('优选账号失败');
      }
    } finally {
      setAutoLoading(false);
    }
  }, [form, match, accountDict, previewOddsRequest, selectedGroupId]);

  const matchId = match?.id;
  useEffect(() => {
    if (!visible || !matchId) return;
    if (selectedGroupId === null) {
      setSelectedAccounts([]);
      setAutoSelection(null);
      setAutoLoading(false);
      form.setFieldValue('account_ids', []);
      return;
    }
    setSelectedAccounts([]);
    setAutoSelection(null);
    setAutoLoading(false);
    form.setFieldValue('account_ids', []);
    // 弹窗打开时自动优选账号（静默模式，不显示提示）
    fetchAutoSelection(undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, matchId, selectedGroupId]);

  const handleAccountsChange = (accountIds: Array<number | string>) => {
    const normalized = accountIds.map(id => Number(id));
    setSelectedAccounts(normalized);
    form.setFieldValue('account_ids', normalized);
    calculatePayout(normalized.length);
    setTimeout(() => {
      previewOddsRequest(true);
    }, 0);
  };

  const calculatePayout = (accountCountOverride?: number) => {
    const totalAmount = form.getFieldValue('total_amount') || 0;
    const odds = form.getFieldValue('odds') || 1;

    // 预估盈利 = 总金额 × 赔率
    const payout = totalAmount * odds;
    setEstimatedPayout(payout);
  };

  const handleFormValuesChange = () => {
    calculatePayout();
    previewOddsRequest(true);
  };

  const handleModeSwitch = (mode: '优选' | '平均') => {
    setBetMode(mode);
    if (mode === '优选') {
      fetchAutoSelection(undefined, true);
    }
  };

  const formatMaxBet = (value: string | number | null): string => {
    if (value === null || value === undefined) return '--';
    const text = String(value).trim();
    if (!text) return '--';
    const num = Number(text);
    if (Number.isFinite(num)) {
      return num.toLocaleString();
    }
    return text;
  };

  const maxBetDisplay = useMemo(() => formatMaxBet(maxBetAmount), [maxBetAmount]);

  const handleFetchMaxBet = async () => {
    if (selectedGroupId === null) {
      message.warning('请先选择分组');
      return;
    }
    if (maxBetLoading) return;
    setMaxBetLoading(true);
    setMaxBetError(null);

    const response = await previewOddsRequest(true);
    const maxBetValue = response?.data?.max_bet;
    if (response?.success && maxBetValue !== undefined && maxBetValue !== null && String(maxBetValue).trim()) {
      setMaxBetAmount(String(maxBetValue).trim());
      setMaxBetError(null);
    } else {
      const errMsg = response?.message || response?.data?.message || '未获取到最大投注金额';
      setMaxBetError(errMsg);
      message.error(errMsg);
    }
    setMaxBetLoading(false);
  };

  const handleSubmit = async () => {
    if (!match) return;
    if (submittingRef.current) return;

    submittingRef.current = true;
    let backgroundRequestStarted = false;

    try {
      const values = await form.validateFields();

      const betTypeValue = values.bet_type ?? activeSelection?.bet_type ?? defaultSelection?.bet_type ?? '让球';
      const betOptionValue = values.bet_option ?? activeSelection?.bet_option ?? defaultSelection?.bet_option ?? '主队';
      const oddsValue = values.odds ?? activeSelection?.odds ?? defaultSelection?.odds ?? 1;

      if (oddsPreview?.closed) {
        message.error(oddsPreview.message || '盘口已封盘或暂时不可投注');
        return;
      }

      const accountIds = [...selectedAccounts];

      const usedLines = new Set<string>();
      const conflictAccounts: number[] = [];
      accountIds.forEach((accountId) => {
        const lineKey = getLineKey(accountId);
        if (usedLines.has(lineKey)) {
          conflictAccounts.push(accountId);
          return;
        }
        usedLines.add(lineKey);
      });

      if (conflictAccounts.length > 0) {
        const conflictLabels = conflictAccounts
          .map(id => accounts.find(acc => acc.id === id)?.username || String(id))
          .join('、');
        message.error(`所选账号存在同线路冲突：${conflictLabels}。每个线路同场只能下注一次。`);
        return;
      }

      const currentPreviewOdds = oddsPreview && !oddsPreview.closed ? oddsPreview.odds : null;
      const finalOddsCandidate = currentPreviewOdds ?? oddsValue;
      const finalOddsParsed = Number(finalOddsCandidate);
      const finalOdds = Number.isFinite(finalOddsParsed) && finalOddsParsed > 0 ? finalOddsParsed : Number(oddsValue) || 1;

      const requestData: BetCreateRequest = {
        idempotency_key: generateBetIdempotencyKey(),
        account_ids: accountIds,
        match_id: match.id,
        bet_type: betTypeValue,
        bet_option: betOptionValue,
        total_amount: values.total_amount,
        odds: finalOdds,
        single_limit: values.single_limit,
        interval_range: values.interval_range,
        quantity: values.quantity,
        min_odds: values.min_odds,
        crown_match_id: resolvedCrownMatchId || match.crown_gid || match.gid || match.match_id,
        league_name: match.league_name,
        home_team: match.home_team,
        away_team: match.away_team,
        match_time: match.match_time,
        match_status: match.status,
        current_score: match.current_score,
        match_period: match.match_period,
        market_category: activeSelection?.market_category,
        market_scope: activeSelection?.market_scope,
        market_side: activeSelection?.market_side,
        market_line: activeSelection?.market_line,
        market_index: activeSelection?.market_index,
        market_wtype: activeSelection?.market_wtype,
        market_rtype: activeSelection?.market_rtype,
        market_chose_team: activeSelection?.market_chose_team,
      };

      const msgKey = `bet-submit:${Date.now()}`;
      message.loading({ content: '下注任务提交中…', key: msgKey, duration: 0 });

      handleCancel();

      backgroundRequestStarted = true;
      betApi.createBet(requestData)
        .then((response) => {
          if (response.success) {
            const data: any = response.data || {};
            const totalRequested = typeof data.total === 'number' ? data.total : accountIds.length;
            const queuedCount = typeof data.queued === 'number' ? data.queued : undefined;
            const successMessage =
              response.message ||
              (queuedCount !== undefined
                ? `下注任务已提交，正在后台处理中。本次共选择 ${totalRequested} 个账号，计划拆分 ${queuedCount} 笔下注。`
                : `下注任务已提交，正在后台处理中。本次共选择 ${totalRequested} 个账号。`);

            message.success({ content: successMessage, key: msgKey, duration: 4 });
            onSubmit();
            return;
          }

          const data = response.data as any;
          if (data?.failed && data.failed.length > 0) {
            const errorMessages = data.failed.map((f: any) => {
              const accountName = accounts.find(a => a.id === f.accountId)?.username || `账号${f.accountId}`;
              return `${accountName}: ${f.error}`;
            }).join('\n');

            message.error({
              key: msgKey,
              content: (
                <div>
                  <div style={{ fontWeight: 'bold', marginBottom: 8 }}>下注失败</div>
                  <div style={{ whiteSpace: 'pre-line', fontSize: '13px' }}>{errorMessages}</div>
                </div>
              ),
              duration: 8,
            });
          } else {
            const errMsg = response.error || response.message || '创建下注失败';
            message.error({ content: errMsg, key: msgKey, duration: 6 });
          }
        })
        .catch((error: any) => {
          const axiosError = error as AxiosError<{ error?: string; message?: string; data?: any }>;
          const responseData = axiosError.response?.data as any;

          if (responseData?.data?.failed && responseData.data.failed.length > 0) {
            const errorMessages = responseData.data.failed.map((f: any) => {
              const accountName = accounts.find(a => a.id === f.accountId)?.username || `账号${f.accountId}`;
              return `${accountName}: ${f.error}`;
            }).join('\n');

            message.error({
              key: msgKey,
              content: (
                <div>
                  <div style={{ fontWeight: 'bold', marginBottom: 8 }}>{responseData.message || '下注失败'}</div>
                  <div style={{ whiteSpace: 'pre-line', fontSize: '13px' }}>{errorMessages}</div>
                </div>
              ),
              duration: 8,
            });
          } else {
            const serverMessage = responseData?.error || responseData?.message || axiosError.message;
            message.error({ content: serverMessage || '创建下注失败', key: msgKey, duration: 6 });
          }
        })
        .finally(() => {
          submittingRef.current = false;
        });
    } catch (error) {
      if (error && typeof error === 'object' && Array.isArray((error as any).errorFields)) {
        return;
      }

      console.error('Failed to create bet:', error);
      const axiosError = error as AxiosError<{ error?: string; message?: string; data?: any }>;
      const responseData = axiosError.response?.data as any;
      
      // 检查是否有详细的失败信息
      if (responseData?.data?.failed && responseData.data.failed.length > 0) {
        const errorMessages = responseData.data.failed.map((f: any) => {
          const accountName = accounts.find(a => a.id === f.accountId)?.username || `账号${f.accountId}`;
          return `${accountName}: ${f.error}`;
        }).join('\n');
        
        message.error({
          content: (
            <div>
              <div style={{ fontWeight: 'bold', marginBottom: 8 }}>{responseData.message || '下注失败'}</div>
              <div style={{ whiteSpace: 'pre-line', fontSize: '13px' }}>{errorMessages}</div>
            </div>
          ),
          duration: 8,
        });
      } else {
        const serverMessage = responseData?.error || responseData?.message || axiosError.message;
        message.error(serverMessage || '创建下注失败');
      }
    } finally {
      if (!backgroundRequestStarted) {
        submittingRef.current = false;
      }
    }
  };

  const handleCancel = () => {
    form.resetFields();
    setSelectedAccounts([]);
    setEstimatedPayout(0);
    setBetMode('优选');
    setAutoSelection(null);
    setAutoLoading(false);
    setMaxBetLoading(false);
    setMaxBetAmount(null);
    setMaxBetError(null);
    setSelectedGroupId(null);
    onCancel();
  };

  const matchTimeLabel = useMemo(() => {
    if (!match) {
      return '-';
    }
    return dayjs(match.match_time).isValid()
      ? dayjs(match.match_time).format('YYYY-MM-DD HH:mm')
      : (match.match_time || '-');
  }, [match]);

  const recommendedOrder = useMemo(() => (
    autoSelection ? autoSelection.eligible_accounts.map(entry => entry.account.id) : []
  ), [autoSelection]);

  const sortedAccounts = useMemo(() => {
    // 只显示符合下注条件的账号（在线、未达止盈、无线路冲突）
    // 必须等待后端返回的优选结果，不再使用备用逻辑
    if (!autoSelection || selectedGroupId === null) {
      // 如果还没有优选数据，返回空数组（等待加载）
      return [];
    }

    const eligibleAccountIds = new Set<number>();
    autoSelection.eligible_accounts.forEach(entry => {
      eligibleAccountIds.add(entry.account.id);
    });

    const eligibleAccounts = groupAccounts.filter(account =>
      eligibleAccountIds.has(account.id)
    );

    if (!recommendedOrder.length) {
      return eligibleAccounts;
    }
    const orderMap = new Map<number, number>();
    recommendedOrder.forEach((id, index) => orderMap.set(id, index));
    return [...eligibleAccounts].sort((a, b) => {
      const rankA = orderMap.has(a.id) ? orderMap.get(a.id)! : Number.POSITIVE_INFINITY;
      const rankB = orderMap.has(b.id) ? orderMap.get(b.id)! : Number.POSITIVE_INFINITY;
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      return a.username.localeCompare(b.username);
    });
  }, [groupAccounts, recommendedOrder, autoSelection, selectedGroupId]);

  const formatAmount = (value: number | null | undefined) => {
    if (!Number.isFinite(value as number)) {
      return '-';
    }
    return (value as number).toLocaleString();
  };

  const formatAccountLabel = (account: CrownAccount) => {
    const changed = (account.initialized_username || account.username || '').trim();
    const original = (account.original_username || account.username || '').trim();
    const note = (account.note || '').trim() || '-';
    const isLive = match?.status === 'live';
    const limitValue = isLive ? account.football_live_limit : account.football_prematch_limit;
    const limitText = formatAmount(limitValue);
    return `${changed}/${original}/${note} (${limitText})`;
  };

  const renderTeamLabel = (name: string, redcard?: number) => (
    <span className="team-name-with-redcard">
      <span>{name}</span>
      {(redcard ?? 0) > 0 ? <span className="redcard-badge">{redcard}</span> : null}
    </span>
  );

  return (
    <Modal
      title={null}
      open={visible}
      onOk={handleSubmit}
      onCancel={handleCancel}
      confirmLoading={loading}
      width={isMobile ? '100%' : 480}
      style={isMobile ? { top: 0, margin: 0, maxWidth: '100vw', padding: 0 } : undefined}
      maskClosable={false}
      className="bet-modal-v2"
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={handleCancel} style={{ flex: 1 }}>取消</Button>
          <Button type="primary" onClick={handleSubmit} loading={loading} style={{ flex: 2 }}>
            确认下注 ({selectedAccounts.length}个账号)
          </Button>
        </div>
      }
    >
      {match ? (
        <div className="bet-v2">
          {/* 隐藏字段 */}
          <Form form={form} onValuesChange={handleFormValuesChange} style={{ display: 'none' }}>
            <Form.Item name="bet_type"><Input /></Form.Item>
            <Form.Item name="bet_option"><Input /></Form.Item>
            <Form.Item name="odds"><InputNumber /></Form.Item>
            <Form.Item name="account_ids"><Input /></Form.Item>
            <Form.Item name="total_amount"><InputNumber /></Form.Item>
            <Form.Item name="single_limit"><Input /></Form.Item>
            <Form.Item name="interval_range"><Input /></Form.Item>
            <Form.Item name="quantity"><InputNumber /></Form.Item>
            <Form.Item name="min_odds"><InputNumber /></Form.Item>
          </Form>

          {/* 比赛信息头部 */}
          <div className="bet-v2-header">
            <div className="bet-v2-match">
              <span className="teams">
                {renderTeamLabel(match.home_team, match.home_redcard)} vs {renderTeamLabel(match.away_team, match.away_redcard)}
              </span>
              {match.current_score && <span className="score">{match.current_score}</span>}
            </div>
            <div className="bet-v2-meta">
              <span>{match.league_name}</span>
              <span>{matchTimeLabel}</span>
            </div>
          </div>

          {/* 赔率显示 */}
          <div className="bet-v2-odds">
            <div className="odds-main">
              <span className="odds-label">{selectionLabel || '当前赔率'}</span>
              <span className={`odds-value ${oddsPreview?.closed ? 'closed' : ''} ${minOdds && oddsPreview?.odds && oddsPreview.odds < minOdds ? 'below-min' : ''}`}>
                {oddsPreview ? (oddsPreview.odds ?? '-') : '--'}
              </span>
              {previewLoading && <Spin size="small" />}
            </div>
            <div className="odds-actions">
              <Button size="small" icon={<ReloadOutlined />} onClick={() => previewOddsRequest(false)} />
              <Checkbox checked={autoRefreshOdds} onChange={(e) => setAutoRefreshOdds(e.target.checked)}>
                <span style={{ fontSize: 11 }}>自动</span>
              </Checkbox>
            </div>
            {/* 官方提示信息（封盘、错误等） */}
            {oddsPreview?.closed && (
              <div className="odds-closed">🚫 {oddsPreview.message || '盘口已封盘'}</div>
            )}
            {previewError && !oddsPreview?.closed && <div className="odds-error">{previewError}</div>}
            {minOdds && oddsPreview?.odds && oddsPreview.odds < minOdds && !oddsPreview?.closed && (
              <div className="odds-warning">当前赔率 {oddsPreview.odds} 低于最低赔率 {minOdds}</div>
            )}
          </div>

          {/* 表单区域 - 紧凑网格 */}
          <div className="bet-v2-form">
            <div className="form-grid">
              <div className="form-cell">
                <div className="form-label-row">
                  <label>总金额</label>
                  <button
                    type="button"
                    className="max-bet-link"
                    onClick={handleFetchMaxBet}
                    disabled={maxBetLoading}
                  >
                    {maxBetLoading ? '获取中...' : '最大投注金额'}
                  </button>
                </div>
                <InputNumber
                  size="small"
                  min={50}
                  style={{ width: '100%' }}
                  placeholder="50000"
                  value={totalAmount}
                  onChange={(v) => { form.setFieldValue('total_amount', v); handleFormValuesChange(); }}
                />
                <div className={`max-bet-value${maxBetError ? ' error' : ''}`}>
                  {maxBetDisplay}{maxBetDisplay !== '--' ? ' RMB' : ''}
                </div>
              </div>
              <div className="form-cell">
                <label>单笔限额</label>
                <Input
                  size="small"
                  placeholder="留空自动"
                  value={singleLimit}
                  onChange={(e) => form.setFieldValue('single_limit', e.target.value)}
                />
              </div>
              <div className="form-cell">
                <label>间隔(秒)</label>
                <Input
                  size="small"
                  placeholder="3-15"
                  value={intervalRange}
                  onChange={(e) => form.setFieldValue('interval_range', e.target.value)}
                />
              </div>
              <div className="form-cell">
                <label>数量</label>
                <InputNumber
                  size="small"
                  min={1}
                  max={10}
                  style={{ width: '100%' }}
                  value={quantity}
                  onChange={(v) => form.setFieldValue('quantity', v)}
                />
              </div>
              <div className="form-cell">
                <label>最低赔率</label>
                <InputNumber
                  size="small"
                  min={0}
                  step={0.01}
                  style={{ width: '100%' }}
                  placeholder="可选"
                  value={minOdds}
                  onChange={(v) => form.setFieldValue('min_odds', v)}
                />
              </div>
              <div className="form-cell">
                <label>模式</label>
                <div className="mode-switch">
                  {(['优选', '平均'] as const).map(mode => (
                    <span
                      key={mode}
                      className={mode === betMode ? 'active' : ''}
                      onClick={() => handleModeSwitch(mode)}
                    >{mode}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 账号选择 */}
          <div className="bet-v2-accounts">
            <div className="accounts-group">
              <label>分组</label>
              <Select
                size="small"
                placeholder={groupsLoading ? '加载中...' : '请选择分组'}
                value={selectedGroupId ?? undefined}
                onChange={(value) => {
                  const nextValue = typeof value === 'number' ? value : null;
                  setSelectedGroupId(nextValue);
                  setSelectedAccounts([]);
                  setAutoSelection(null);
                  setAutoLoading(false);
                  form.setFieldValue('account_ids', []);
                  setMaxBetAmount(null);
                  setMaxBetError(null);
                }}
                allowClear
                loading={groupsLoading}
                notFoundContent={groupsLoading ? <Spin size="small" /> : '暂无分组'}
                style={{ width: '100%' }}
              >
                {groups.map(group => (
                  <Option key={group.id} value={group.id}>{group.name}</Option>
                ))}
              </Select>
            </div>
            <div className="accounts-header">
              <span>账号 <b>{selectedAccounts.length}</b>/{sortedAccounts.length}</span>
              <Space size={4}>
                {betMode === '优选' && (
                  <Button type="link" size="small" onClick={() => fetchAutoSelection()} disabled={autoLoading || selectedGroupId === null} style={{ padding: 0, fontSize: 11 }}>
                    重选
                  </Button>
                )}
                {autoLoading && <Spin size="small" />}
              </Space>
            </div>
            <div className="accounts-list">
              {selectedGroupId === null ? (
                <div style={{ padding: '12px', textAlign: 'center', color: '#999', fontSize: 12 }}>
                  请先选择分组
                </div>
              ) : autoLoading && !autoSelection ? (
                <div style={{ padding: '12px', textAlign: 'center', color: '#999', fontSize: 12 }}>
                  <Spin size="small" /> 加载中...
                </div>
              ) : sortedAccounts.length === 0 ? (
                <div style={{ padding: '12px', textAlign: 'center', color: '#999', fontSize: 12 }}>
                  暂无可下注的账号
                </div>
              ) : (
                sortedAccounts.map(account => {
                  const selected = selectedAccounts.includes(account.id);
                  const online = isAccountOnline(account.id);
                  return (
                    <div
                      key={account.id}
                      className={`account-item ${selected ? 'selected' : ''} ${online ? '' : 'offline'}`}
                      onClick={() => {
                        if (!online) return;
                        const newSelected = selected
                          ? selectedAccounts.filter(id => id !== account.id)
                          : [...selectedAccounts, account.id];
                        handleAccountsChange(newSelected);
                      }}
                    >
                      <span className="name">{formatAccountLabel(account)}</span>
                      <span className={`status ${online ? 'on' : 'off'}`}>{online ? '✓' : '✗'}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : (
        <Empty description="请选择比赛" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 20 }} />
      )}
    </Modal>
  );
};

export default BetFormModal;
