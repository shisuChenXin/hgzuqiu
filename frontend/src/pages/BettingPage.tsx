import React, { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  message,
  Typography,
  Row,
  Col,
  Select,
  DatePicker,
  Badge,
  Tooltip,
} from 'antd';
import {
  ReloadOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { Bet, User, TablePagination } from '../types';
import { betApi, agentApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import dayjs, { Dayjs } from 'dayjs';

const { Title, Text } = Typography;

// 注单分组界面
interface BetGroup {
  key: string;
  match_info: string;
  bet_target: string;
  completed_amount: string;
  bet_rate: number;
  average_odds?: number;
  total_profit_loss: number;
  bet_count: string;
  result_count: string;
  time: string;
  bets: Bet[];
  status: 'completed' | 'pending';
  user_username?: string;
  user_display_name?: string;
}

// 子注单界面
interface BetDetail {
  key: string;
  status: string;
  order_id: string;
  user_username?: string;  // 员工用户名
  account_username: string;
  amount_display: string;
  bet_amount: number;
  single_limit: number;
  official_odds?: number;
  virtual_amount_display?: string;
  virtual_profit_display?: string;
  result_score?: string;
  result_text?: string;
  input_display: string;
  input_amount: number;
  input_limit: number;
  time: string;
  error_message?: string;  // 失败原因
  mapping_display: string;
  mapping_detail?: string;
  mapping_applied?: boolean;
}

const formatOdds = (value?: number | null | string) => {
  if (value === undefined || value === null || value === '') {
    return '-';
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '-';
  }
  return parsed.toFixed(3).replace(/\.?0+$/, '');
};

const resolveOfficialOdds = (bet: Bet): number | undefined => {
  const tryParse = (value: any): number | undefined => {
    if (value === null || value === undefined) return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  };

  return tryParse(bet.official_odds) ?? tryParse(bet.odds);
};

const formatBetTime = (bet: Bet): string => {
  const raw =
    bet.confirmed_at ||
    (bet.status !== 'pending' ? bet.updated_at : undefined) ||
    bet.created_at;
  if (!raw) return '-';
  const parsed = dayjs(raw);
  if (!parsed.isValid()) return '-';
  return parsed.format('HH:mm:ss');
};

const hasValue = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null && value !== '';

const formatMappingValue = (value: string | null | undefined): string =>
  hasValue(value) ? value : '-';

const buildSelectionMappingDisplay = (bet: Bet) => {
  const hasExplicitMappingMetadata =
    bet.displayed_market_side !== undefined ||
    bet.executed_market_side !== undefined ||
    bet.displayed_market_rtype !== undefined ||
    bet.executed_market_rtype !== undefined ||
    bet.displayed_market_chose_team !== undefined ||
    bet.executed_market_chose_team !== undefined ||
    bet.mapping_mode !== undefined ||
    bet.mapping_version !== undefined ||
    bet.mapping_applied !== undefined;

  if (!hasExplicitMappingMetadata) {
    return { display: '-', detail: undefined, applied: undefined };
  }

  const displayedSide = bet.displayed_market_side ?? bet.market_side ?? null;
  const executedSide = bet.executed_market_side ?? displayedSide;
  const displayedRtype = bet.displayed_market_rtype ?? bet.market_rtype ?? null;
  const executedRtype = bet.executed_market_rtype ?? displayedRtype;
  const displayedChoseTeam = bet.displayed_market_chose_team ?? bet.market_chose_team ?? null;
  const executedChoseTeam = bet.executed_market_chose_team ?? displayedChoseTeam;

  const details = [
    `side: ${formatMappingValue(displayedSide)} -> ${formatMappingValue(executedSide)}`,
    `rtype: ${formatMappingValue(displayedRtype)} -> ${formatMappingValue(executedRtype)}`,
    `chose_team: ${formatMappingValue(displayedChoseTeam)} -> ${formatMappingValue(executedChoseTeam)}`,
  ];

  if (bet.whitelabel_id !== undefined && bet.whitelabel_id !== null) {
    details.push(`tenant: #${bet.whitelabel_id}`);
  }
  if (bet.mapping_mode !== undefined) details.push(`mode: ${bet.mapping_mode}`);
  if (bet.mapping_version !== undefined) details.push(`version: v${bet.mapping_version}`);
  if (bet.mapping_applied !== undefined) details.push(`mapping_applied: ${bet.mapping_applied}`);

  return {
    display: `${formatMappingValue(displayedSide)} -> ${formatMappingValue(executedSide)}`,
    detail: details.join('\n'),
    applied: bet.mapping_applied,
  };
};

const BettingPage: React.FC = () => {
  const { isAdmin } = useAuth();
  const [betGroups, setBetGroups] = useState<BetGroup[]>([]);
  const [agents, setAgents] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  // 监听窗口大小变化
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 筛选条件
  const [selectedPlatform, setSelectedPlatform] = useState<string>('皇冠');
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState<Dayjs>(dayjs());

  // 统计数据
  const [stats, setStats] = useState({
    total_tickets: 0,
    total_bets: 0,
    pending_bets: 0,
    cancelled_bets: 0,
    total_amount: 0,
    total_profit: 0,
    return_rate: 0,
  });

  const [pagination, setPagination] = useState<TablePagination>({
    current: 1,
    pageSize: 20,
    total: 0,
  });

  useEffect(() => {
    loadInitialData();
  }, []);

  useEffect(() => {
    loadBets();
  }, [selectedAgent, selectedDate, selectedPlatform]);

  // 自动刷新：每 30 秒刷新一次待确认订单
  useEffect(() => {
    const timer = setInterval(() => {
      // 静默刷新（不显示 loading）
      loadBets(true);
    }, 30000); // 每 30 秒刷新一次

    return () => clearInterval(timer);
  }, [selectedAgent, selectedDate, selectedPlatform]);

  const loadInitialData = async () => {
    try {
      const agentsPromise = await agentApi.getAgentList();
      if (agentsPromise.success && agentsPromise.data) {
        setAgents(agentsPromise.data);
      }
    } catch (error) {
      console.error('Failed to load initial data:', error);
    }
  };

  const loadBets = async (
    silent = false,
    overrides?: { selectedAgent?: string; selectedDate?: Dayjs; selectedPlatform?: string },
  ) => {
    try {
      if (!silent) setLoading(true);
      const params: any = {};
      const agentId = overrides?.selectedAgent ?? selectedAgent;
      const dateValue = overrides?.selectedDate ?? selectedDate;
      if (agentId) params.agent_id = agentId;
      if (dateValue) params.date = dateValue.format('YYYY-MM-DD');

      const response = await betApi.getBets(params);
      if (response.success && response.data) {
        // 将注单按比赛分组
        const grouped = groupBetsByMatch(response.data.bets);
        setBetGroups(grouped);

        // 更新统计数据
        setStats({
          total_tickets: grouped.length,
          total_bets: response.data.bets.length,
          pending_bets: response.data.bets.filter((b: Bet) => b.status === 'pending').length,
          cancelled_bets: response.data.bets.filter((b: Bet) => b.status === 'cancelled').length,
          total_amount: response.data.stats.total_amount || 0,
          total_profit: response.data.stats.total_profit_loss || 0,
          return_rate: response.data.stats.total_profit_loss && response.data.stats.total_amount
            ? (response.data.stats.total_profit_loss / response.data.stats.total_amount) * 100
            : 0,
        });

        setPagination(prev => ({
          ...prev,
          total: grouped.length,
        }));
      }
    } catch (error) {
      console.error('Failed to load bets:', error);
      if (!silent) message.error('加载下注记录失败');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const handleClearFilters = async () => {
    const nextDate = dayjs();
    setSelectedPlatform('皇冠');
    setSelectedAgent('');
    setSelectedDate(nextDate);
    setPagination((prev) => ({ ...prev, current: 1 }));
    await loadBets(false, { selectedAgent: '', selectedDate: nextDate, selectedPlatform: '皇冠' });
  };

  const handleSyncSettlements = async () => {
    try {
      setSyncing(true);
      const response = await betApi.syncSettlements();
      if (response.success) {
        const updatedCount = response.data?.updated_bets?.length ?? 0;
        const errorCount = response.data?.errors?.length ?? 0;
        const skippedCount = response.data?.skipped?.length ?? 0;
        const summaryText = response.message
          || `已同步 ${updatedCount} 条注单${errorCount ? `，${errorCount} 个账号失败` : ''}${skippedCount ? `，${skippedCount} 条跳过` : ''}`;

        if (errorCount > 0) {
          message.warning(summaryText);
        } else {
          message.success(summaryText);
        }
      } else {
        message.warning(response.error || '结算同步失败');
      }
      await loadBets();
    } catch (error) {
      console.error('Failed to sync settlements:', error);
      message.error('结算同步失败');
    } finally {
      setSyncing(false);
    }
  };

  // 按比赛分组注单
  const groupBetsByMatch = (bets: Bet[]): BetGroup[] => {
    const groups: { [key: string]: Bet[] } = {};

    bets.forEach(bet => {
      const matchKey = `${bet.match_id}_${bet.bet_type}_${bet.bet_option}`;
      if (!groups[matchKey]) {
        groups[matchKey] = [];
      }
      groups[matchKey].push(bet);
    });

    return Object.keys(groups).map((key, index) => {
      const groupBets = groups[key];
      const firstBet = groupBets[0];
      const completedBets = groupBets.filter(b => b.status === 'confirmed' || b.status === 'settled');
      const totalAmount = groupBets.reduce((sum, b) => sum + Number(b.bet_amount || 0), 0);
      const completedAmount = completedBets.reduce((sum, b) => sum + Number(b.bet_amount || 0), 0);
      const betRate = totalAmount > 0 ? (completedAmount / totalAmount) : 0;

      // 计算平均赔率：所有账号的 official_odds 的平均值
      const validOdds = groupBets
        .map(b => resolveOfficialOdds(b))
        .filter((odds): odds is number => typeof odds === 'number');
      const averageOdds = validOdds.length > 0
        ? validOdds.reduce((sum, odds) => sum + odds, 0) / validOdds.length
        : undefined;

      // 计算盈亏：所有注单的 profit_loss 之和
      const totalProfitLoss = groupBets.reduce((sum, b) => sum + Number(b.profit_loss || 0), 0);

      // 统计已结算和已取消的注单数
      const settledCount = groupBets.filter(b => b.status === 'settled').length;
      const cancelledCount = groupBets.filter(b => b.status === 'cancelled').length;

      return {
        key: key,
        match_info: `${firstBet.league_name || ''}\n${firstBet.home_team} vs ${firstBet.away_team}`,
        bet_target: `[${firstBet.bet_type}]${firstBet.bet_option}@${formatOdds(averageOdds)}`,
        completed_amount: `${completedAmount.toFixed(0)}/${totalAmount.toFixed(0)}`,
        bet_rate: betRate,
        average_odds: averageOdds,
        total_profit_loss: totalProfitLoss,
        bet_count: `${completedBets.length}/${groupBets.length}`,
        result_count: `${groupBets.length}/${settledCount}/${cancelledCount}`,
        time: formatBetTime(firstBet),
        bets: groupBets,
        status: completedBets.length === groupBets.length ? 'completed' : 'pending',
        user_username: firstBet.user_username,
        user_display_name: (firstBet as any).user_display_name,
      };
    });
  };

  // 主表格列定义
  const mainColumns: ColumnsType<BetGroup> = isMobile ? [
    // 移动端简化列
    {
      title: '比赛/盘口',
      key: 'match_bet',
      width: 180,
      render: (_: any, record: BetGroup) => {
        const lines = record.match_info.split('\n');
        const percentage = Math.round(record.bet_rate * 100);
        return (
          <div style={{ fontSize: 11 }}>
            <div style={{ color: '#888', marginBottom: 2 }}>{lines[0]}</div>
            <div style={{ fontWeight: 500, marginBottom: 2 }}>{lines[1]}</div>
            <div style={{ color: '#1890ff', fontSize: 10 }}>{record.bet_target}</div>
            <div style={{ marginTop: 4 }}>
              {record.status === 'completed' ? (
                <Tag color="success" style={{ fontSize: 10, padding: '0 4px' }}>完成</Tag>
              ) : (
                <Tag color="processing" style={{ fontSize: 10, padding: '0 4px' }}>{percentage}%</Tag>
              )}
            </div>
          </div>
        );
      },
    },
    {
      title: '金额/赔率',
      key: 'amount_odds',
      width: 90,
      align: 'right' as const,
      render: (_: any, record: BetGroup) => {
        const [completed, total] = record.completed_amount.split('/');
        const color = record.total_profit_loss > 0 ? '#52c41a' : record.total_profit_loss < 0 ? '#ff4d4f' : '#8c8c8c';
        return (
          <div style={{ fontSize: 11 }}>
            <div><b>{completed}</b>/{total}</div>
            <div style={{ color: '#1890ff' }}>@{formatOdds(record.average_odds)}</div>
            <div style={{ color, fontWeight: 500 }}>{record.total_profit_loss > 0 ? '+' : ''}{record.total_profit_loss.toFixed(0)}</div>
          </div>
        );
      },
    },
    {
      title: '单数',
      dataIndex: 'result_count',
      key: 'result_count',
      width: 70,
      align: 'center' as const,
      render: (text: string) => {
        const [total, settled, cancelled] = text.split('/');
        return (
          <div style={{ fontSize: 10 }}>
            <Badge count={total} showZero style={{ backgroundColor: '#1890ff' }} size="small" />
            <Badge count={settled} showZero style={{ backgroundColor: '#52c41a' }} size="small" />
            <Badge count={cancelled} showZero style={{ backgroundColor: '#8c8c8c' }} size="small" />
          </div>
        );
      },
    },
  ] : [
    // 桌面端完整列
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      fixed: 'left',
      render: (status: string, record: BetGroup) => {
        if (status === 'completed') {
          return (
            <Tag color="success" icon={<CheckCircleOutlined />} style={{ fontSize: 13, padding: '4px 12px' }}>
              已完成
            </Tag>
          );
        } else {
          const percentage = Math.round(record.bet_rate * 100);
          return (
            <Tag color="processing" icon={<CloseCircleOutlined />} style={{ fontSize: 13, padding: '4px 12px' }}>
              {percentage}%
            </Tag>
          );
        }
      },
    },
    {
      title: '比赛信息',
      dataIndex: 'match_info',
      key: 'match_info',
      width: 220,
      fixed: 'left',
      render: (text: string) => {
        const lines = text.split('\n');
        return (
          <Space direction="vertical" size={2}>
            <Text type="secondary" style={{ fontSize: 11 }}>{lines[0]}</Text>
            <Text strong style={{ fontSize: 13, color: '#262626' }}>{lines[1]}</Text>
          </Space>
        );
      },
    },
    {
      title: '目标盘口',
      dataIndex: 'bet_target',
      key: 'bet_target',
      width: 250,
      render: (text: string) => (
        <Text style={{ fontSize: 13, color: '#1890ff', fontWeight: 500 }}>{text}</Text>
      ),
    },
    {
      title: '完成金额',
      dataIndex: 'completed_amount',
      key: 'completed_amount',
      width: 120,
      align: 'right',
      render: (text: string) => {
        const [completed, total] = text.split('/');
        return (
          <Space direction="vertical" size={0} style={{ width: '100%', alignItems: 'flex-end' }}>
            <Text strong style={{ fontSize: 14 }}>{completed}</Text>
            <Text type="secondary" style={{ fontSize: 11 }}>/ {total}</Text>
          </Space>
        );
      },
    },
    {
      title: '综合赔率',
      dataIndex: 'average_odds',
      key: 'average_odds',
      width: 100,
      align: 'center',
      render: (odds?: number) => (
        <Tag color="blue" style={{ fontSize: 13, padding: '4px 12px', fontWeight: 'bold' }}>
          {formatOdds(odds)}
        </Tag>
      ),
    },
    {
      title: '输赢',
      dataIndex: 'total_profit_loss',
      key: 'total_profit_loss',
      width: 100,
      align: 'right',
      render: (profitLoss: number) => {
        const color = profitLoss > 0 ? '#52c41a' : profitLoss < 0 ? '#ff4d4f' : '#8c8c8c';
        const icon = profitLoss > 0 ? '↑' : profitLoss < 0 ? '↓' : '—';
        return (
          <span style={{ color, fontWeight: 'bold', fontSize: 14 }}>
            {icon} {Math.abs(profitLoss).toFixed(0)}
          </span>
        );
      },
    },
    {
      title: '总单/结算/划单',
      dataIndex: 'result_count',
      key: 'result_count',
      width: 140,
      align: 'center',
      render: (text: string) => {
        const [total, settled, cancelled] = text.split('/');
        return (
          <Space size={4}>
            <Badge count={total} showZero style={{ backgroundColor: '#1890ff' }} />
            <Badge count={settled} showZero style={{ backgroundColor: '#52c41a' }} />
            <Badge count={cancelled} showZero style={{ backgroundColor: '#8c8c8c' }} />
          </Space>
        );
      },
    },
    {
      title: '时间',
      dataIndex: 'time',
      key: 'time',
      width: 100,
      align: 'center',
      render: (time: string) => (
        <Text style={{ fontSize: 13, color: '#595959' }}>{time}</Text>
      ),
    },
  ];

  // 展开的子表格列定义
  const expandedColumns: ColumnsType<BetDetail> = [
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: string, record: BetDetail) => {
        if (status === 'settled') {
          return <Tag color="success" icon={<CheckCircleOutlined />}>已结算</Tag>;
        } else if (status === 'confirmed') {
          return <Tag color="processing" icon={<CloseCircleOutlined />}>已下单</Tag>;
        } else if (status === 'cancelled') {
          // 已取消/失败的注单，显示失败原因
          const errorMsg = record.error_message || '下注失败';
          return (
            <Tooltip title={errorMsg}>
              <Tag color="error" icon={<CloseCircleOutlined />}>失败</Tag>
            </Tooltip>
          );
        }
        return <Tag color="default">待处理</Tag>;
      },
    },
    {
      title: '单号',
      dataIndex: 'order_id',
      key: 'order_id',
      width: 160,
      render: (text: string) => (
        <Text copyable style={{ fontSize: 12, fontFamily: 'monospace' }}>{text}</Text>
      ),
    },
    {
      title: '下注员',
      dataIndex: 'user_username',
      key: 'user_username',
      width: 100,
      render: (text: string) => (
        <Tag color="blue" style={{ fontSize: 12 }}>{text || '-'}</Tag>
      ),
    },
    {
      title: '账号',
      dataIndex: 'account_username',
      key: 'account_username',
      width: 120,
      render: (text: string) => (
        <Tag color="cyan" style={{ fontSize: 12 }}>{text}</Tag>
      ),
    },
    {
      title: '展示/执行',
      dataIndex: 'mapping_display',
      key: 'selection_mapping',
      width: 150,
      align: 'center',
      render: (text: string, record: BetDetail) => record.mapping_detail ? (
        <Tooltip
          title={
            <div style={{ whiteSpace: 'pre', fontFamily: 'monospace', fontSize: 12 }}>
              {record.mapping_detail}
            </div>
          }
        >
          <Tag color={record.mapping_applied ? 'warning' : 'default'} style={{ fontFamily: 'monospace' }}>
            {text}
          </Tag>
        </Tooltip>
      ) : (
        <Text type="secondary">-</Text>
      ),
    },
    {
      title: '金额(实/虚)',
      dataIndex: 'amount_display',
      key: 'amount_display',
      width: 120,
      align: 'right',
      render: (text: string) => (
        <Text strong style={{ fontSize: 13 }}>{text}</Text>
      ),
    },
    {
      title: '赔率',
      dataIndex: 'official_odds',
      key: 'official_odds',
      width: 80,
      align: 'center',
      render: (value?: number) => (
        <Tag color="blue" style={{ fontWeight: 'bold' }}>{formatOdds(value)}</Tag>
      ),
    },
    {
      title: '下注比分',
      dataIndex: 'bet_score',
      key: 'bet_score',
      width: 100,
      align: 'center',
      render: (score?: string) => score ? (
        <Text type="secondary" style={{ fontSize: 12 }}>{score}</Text>
      ) : (
        <Text type="secondary">-</Text>
      ),
    },
    {
      title: '输赢(实/虚)',
      dataIndex: 'input_display',
      key: 'input_display',
      width: 120,
      align: 'right',
      render: (text: string) => {
        const [real] = text.split('/');
        const value = parseFloat(real);
        const color = value > 0 ? '#52c41a' : value < 0 ? '#ff4d4f' : '#8c8c8c';
        return <Text strong style={{ color, fontSize: 13 }}>{text}</Text>;
      },
    },
    {
      title: '结果',
      dataIndex: 'result_score',
      key: 'result_score',
      width: 100,
      align: 'center',
      render: (score?: string) => score ? (
        <Tag color="purple" style={{ fontSize: 12, fontWeight: 'bold' }}>{score}</Tag>
      ) : (
        <Text type="secondary">-</Text>
      ),
    },
    {
      title: '时间',
      dataIndex: 'time',
      key: 'time',
      width: 100,
      align: 'center',
      render: (time: string) => (
        <Text type="secondary" style={{ fontSize: 12 }}>{time}</Text>
      ),
    },
  ];

  // 展开的行渲染
  const expandedRowRender = (record: BetGroup) => {
  const detailData: BetDetail[] = record.bets.map(bet => {
    const realAmount = Number(bet.bet_amount ?? 0);
    const virtualAmount = bet.virtual_bet_amount;
    const realLimit = Number(bet.single_limit ?? 0);
    const realProfit = Number(bet.profit_loss ?? 0);
    const virtualProfit = bet.virtual_profit_loss;
    const selectionMapping = buildSelectionMappingDisplay(bet);

    const formatNumber = (value: number) => value.toFixed(2);
    const formatVirtual = (value: number | null | undefined, fallback = '虚') => {
      if (value === null || value === undefined) return fallback;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? formatNumber(numeric) : fallback;
    };

    return {
      key: bet.id.toString(),
      status: bet.status,
      order_id: bet.official_bet_id || `OU${bet.id}`,
      user_username: (bet as any).user_display_name || bet.user_username,
      account_username: bet.account_username || '',
      amount_display: `${formatNumber(realAmount)}/${formatVirtual(virtualAmount)}`,
      virtual_amount_display: virtualAmount !== undefined && virtualAmount !== null
        ? `${formatNumber(realAmount)}/${formatNumber(Number(virtualAmount))}`
        : undefined,
      bet_amount: realAmount,
      single_limit: realLimit,
      official_odds: resolveOfficialOdds(bet),
      bet_score: bet.score || bet.current_score || undefined,
      input_display: `${formatNumber(realProfit)}/${formatVirtual(virtualProfit)}`,
      input_amount: realProfit,
      result_score: bet.result_score,
      result_text: bet.result_text,
      input_limit: realLimit,
      time: formatBetTime(bet),
      error_message: (bet as any).error_message || undefined,
      mapping_display: selectionMapping.display,
      mapping_detail: selectionMapping.detail,
      mapping_applied: selectionMapping.applied,
    };
  });

    return (
      <Table
        columns={isAdmin ? expandedColumns : expandedColumns.filter(column => column.key !== 'selection_mapping')}
        dataSource={detailData}
        pagination={false}
        size="small"
      />
    );
  };

  return (
    <div style={{ padding: isMobile ? 0 : '4px 8px', background: isMobile ? '#fff' : '#f0f2f5', minHeight: '100vh' }}>
      {/* 筛选条件 */}
      <Card
        style={isMobile ? { marginBottom: 1, borderRadius: 0 } : { marginBottom: 12 }}
        bodyStyle={{ padding: isMobile ? '12px' : '16px 24px' }}
      >
        <Row gutter={isMobile ? [0, 8] : [16, 16]} align="middle">
          <Col xs={12} sm={6}>
            <Space size={4}>
              <Text type="secondary" style={{ fontSize: isMobile ? 12 : 14 }}>平台:</Text>
              <Select
                value={selectedPlatform}
                onChange={setSelectedPlatform}
                size={isMobile ? 'small' : 'middle'}
                style={{ width: isMobile ? 80 : 120 }}
                options={[
                  { label: '皇冠', value: '皇冠' },
                ]}
              />
            </Space>
          </Col>
          <Col xs={12} sm={6}>
            <Space size={4}>
              <Text type="secondary" style={{ fontSize: isMobile ? 12 : 14 }}>代理:</Text>
              <Select
                value={selectedAgent}
                onChange={setSelectedAgent}
                placeholder={isMobile ? '代理' : '请选择代理'}
                allowClear
                size={isMobile ? 'small' : 'middle'}
                style={{ width: isMobile ? 80 : 150 }}
                options={agents.map(agent => ({
                  label: agent.username,
                  value: agent.id.toString(),
                }))}
              />
            </Space>
          </Col>
          <Col xs={12} sm={6}>
            <Space size={4}>
              <Text type="secondary" style={{ fontSize: isMobile ? 12 : 14 }}>日期:</Text>
              <DatePicker
                value={selectedDate}
                onChange={(date) => date && setSelectedDate(date)}
                format="YYYY-MM-DD"
                size={isMobile ? 'small' : 'middle'}
                style={{ width: isMobile ? 110 : 'auto' }}
              />
            </Space>
          </Col>
          <Col xs={12} sm={6}>
            <Space size={4}>
              <Button
                type="primary"
                onClick={handleSyncSettlements}
                loading={syncing}
                disabled={loading}
                icon={<CheckCircleOutlined />}
                size={isMobile ? 'small' : 'middle'}
              >
                {isMobile ? '结算' : '结算'}
              </Button>
              {!isMobile && (
                <Button
                  onClick={handleClearFilters}
                  icon={<ReloadOutlined />}
                >
                  清理
                </Button>
              )}
            </Space>
          </Col>
        </Row>
      </Card>

      {/* 统计栏 - 卡片式布局 */}
      <Row gutter={isMobile ? 4 : 16} style={{ marginBottom: isMobile ? 4 : 16 }}>
        <Col xs={8} sm={6} md={3}>
          <Card bodyStyle={{ padding: isMobile ? '8px' : '16px' }} style={isMobile ? { borderRadius: 0 } : {}}>
            <div style={{ textAlign: 'center' }}>
              <Text type="secondary" style={{ fontSize: isMobile ? 11 : 12 }}>票单数</Text>
              <div style={{ fontSize: isMobile ? 16 : 24, fontWeight: 'bold', color: '#1890ff', marginTop: isMobile ? 4 : 8 }}>
                {stats.total_tickets}
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={8} sm={6} md={3}>
          <Card bodyStyle={{ padding: isMobile ? '8px' : '16px' }} style={isMobile ? { borderRadius: 0 } : {}}>
            <div style={{ textAlign: 'center' }}>
              <Text type="secondary" style={{ fontSize: isMobile ? 11 : 12 }}>注单数</Text>
              <div style={{ fontSize: isMobile ? 16 : 24, fontWeight: 'bold', color: '#1890ff', marginTop: isMobile ? 4 : 8 }}>
                {stats.total_bets}
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={8} sm={6} md={3}>
          <Card bodyStyle={{ padding: isMobile ? '8px' : '16px' }} style={isMobile ? { borderRadius: 0 } : {}}>
            <div style={{ textAlign: 'center' }}>
              <Text type="secondary" style={{ fontSize: isMobile ? 11 : 12 }}>未结算</Text>
              <div style={{ fontSize: isMobile ? 16 : 24, fontWeight: 'bold', color: '#faad14', marginTop: isMobile ? 4 : 8 }}>
                {stats.pending_bets}
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={8} sm={6} md={3}>
          <Card bodyStyle={{ padding: isMobile ? '8px' : '16px' }} style={isMobile ? { borderRadius: 0 } : {}}>
            <div style={{ textAlign: 'center' }}>
              <Text type="secondary" style={{ fontSize: isMobile ? 11 : 12 }}>已取消</Text>
              <div style={{ fontSize: isMobile ? 16 : 24, fontWeight: 'bold', color: '#8c8c8c', marginTop: isMobile ? 4 : 8 }}>
                {stats.cancelled_bets}
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={8} sm={8} md={4}>
          <Card bodyStyle={{ padding: isMobile ? '8px' : '16px' }} style={isMobile ? { borderRadius: 0 } : {}}>
            <div style={{ textAlign: 'center' }}>
              <Text type="secondary" style={{ fontSize: isMobile ? 11 : 12 }}>总金额</Text>
              <div style={{ fontSize: isMobile ? 16 : 24, fontWeight: 'bold', color: '#722ed1', marginTop: isMobile ? 4 : 8 }}>
                {stats.total_amount.toFixed(0)}
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={8} sm={8} md={4}>
          <Card bodyStyle={{ padding: isMobile ? '8px' : '16px' }} style={isMobile ? { borderRadius: 0 } : {}}>
            <div style={{ textAlign: 'center' }}>
              <Text type="secondary" style={{ fontSize: isMobile ? 11 : 12 }}>输赢</Text>
              <div style={{
                fontSize: isMobile ? 16 : 24,
                fontWeight: 'bold',
                color: stats.total_profit > 0 ? '#52c41a' : stats.total_profit < 0 ? '#ff4d4f' : '#8c8c8c',
                marginTop: isMobile ? 4 : 8
              }}>
                {stats.total_profit > 0 ? '+' : ''}{stats.total_profit.toFixed(0)}
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={8} sm={8} md={4}>
          <Card bodyStyle={{ padding: isMobile ? '8px' : '16px' }} style={isMobile ? { borderRadius: 0 } : {}}>
            <div style={{ textAlign: 'center' }}>
              <Text type="secondary" style={{ fontSize: isMobile ? 11 : 12 }}>回报率</Text>
              <div style={{
                fontSize: isMobile ? 16 : 24,
                fontWeight: 'bold',
                color: stats.return_rate > 0 ? '#52c41a' : stats.return_rate < 0 ? '#ff4d4f' : '#8c8c8c',
                marginTop: isMobile ? 4 : 8
              }}>
                {stats.return_rate.toFixed(1)}%
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* 主表格 */}
      <Card
        title={
          <Space>
            <Text strong style={{ fontSize: isMobile ? 14 : 16 }}>下注列表</Text>
            <Badge count={betGroups.length} style={{ backgroundColor: '#1890ff' }} />
          </Space>
        }
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => loadBets(false)}
            loading={loading}
            type="text"
            size={isMobile ? 'small' : 'middle'}
          >
            {isMobile ? '' : '刷新'}
          </Button>
        }
        bodyStyle={{ padding: '0' }}
        style={isMobile ? { marginBottom: 0, borderRadius: 0 } : {}}
      >
        <Table
          columns={mainColumns}
          dataSource={betGroups}
          rowKey="key"
          loading={loading}
          expandable={{
            expandedRowRender,
            defaultExpandAllRows: false,
            expandIcon: ({ expanded, onExpand, record }) => (
              expanded ? (
                <Button
                  type="link"
                  size="small"
                  onClick={e => onExpand(record, e)}
                  style={{ padding: 0 }}
                >
                  收起 ▲
                </Button>
              ) : (
                <Button
                  type="link"
                  size="small"
                  onClick={e => onExpand(record, e)}
                  style={{ padding: 0 }}
                >
                  展开 ▼
                </Button>
              )
            ),
          }}
          pagination={{
            ...pagination,
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total) => `共 ${total} 条记录`,
            onChange: (page, pageSize) => {
              setPagination(prev => ({ ...prev, current: page, pageSize }));
            },
            style: { padding: '16px 24px' },
          }}
          scroll={{ x: isMobile ? 340 : 1400 }}
          size="middle"
          rowClassName={(record, index) => index % 2 === 0 ? 'table-row-light' : 'table-row-dark'}
        />
      </Card>

      <style>{`
        .table-row-light {
          background-color: #ffffff;
        }
        .table-row-dark {
          background-color: #fafafa;
        }
        .table-row-light:hover,
        .table-row-dark:hover {
          background-color: #e6f7ff !important;
        }
        .ant-table-expanded-row > td {
          background-color: #f5f5f5 !important;
        }
      `}</style>
    </div>
  );
};

export default BettingPage;
