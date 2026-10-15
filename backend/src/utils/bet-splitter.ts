/**
 * 下注金额拆分工具
 * 
 * 核心概念：
 * - 实数金额 = 真实出款金额（扣费金额）
 * - 虚数金额 = 皇冠系统显示的金额
 * - 关系：实数 = 虚数 × 折扣
 */

export interface BetSplit {
  accountId: number;
  virtualAmount: number;  // 虚数金额
  realAmount: number;     // 实数金额
  discount: number;       // 折扣
}

export interface SplitOptions {
  totalRealAmount: number;  // 目标总实数金额
  accountIds: number[];     // 参与下注的账号ID列表
  accountDiscounts: Map<number, number>;  // 账号折扣映射
  singleLimitRange?: { min: number; max: number };  // 单笔限额范围（虚数）
  accountLimits?: Map<number, { min: number; max: number }>;  // 账号限额映射
}

/**
 * 解析单笔限额字符串
 * @param limitStr 限额字符串，如 "10000-14000" 或 "10000"
 * @returns { min, max } 或 null
 */
export function parseLimitRange(limitStr?: string): { min: number; max: number } | null {
  if (!limitStr || typeof limitStr !== 'string') {
    return null;
  }

  const trimmed = limitStr.trim();
  if (!trimmed) {
    return null;
  }

  // 匹配格式：10000-14000
  const rangeMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (rangeMatch) {
    const min = parseFloat(rangeMatch[1]);
    const max = parseFloat(rangeMatch[2]);

    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || min > max) {
      return null;
    }

    return { min, max };
  }

  // 匹配单个数字格式：10000（表示固定金额）
  const singleMatch = trimmed.match(/^(\d+(?:\.\d+)?)$/);
  if (singleMatch) {
    const value = parseFloat(singleMatch[1]);

    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }

    // 单个数字表示固定金额，min 和 max 都设为该值
    return { min: value, max: value };
  }

  return null;
}

/**
 * 为单个账号拆分金额
 * @param targetRealAmount 目标实数金额
 * @param discount 账号折扣
 * @param limitRange 单笔限额范围（虚数）
 * @returns 虚数金额数组
 */
export function splitAmountForAccount(
  targetRealAmount: number,
  discount: number,
  limitRange: { min: number; max: number }
): number[] {
  // 计算需要的虚数总额
  const targetVirtualAmount = targetRealAmount / discount;
  // 最小下注金额（皇冠系统要求）
  const MIN_BET = 50;
  if (targetVirtualAmount + Number.EPSILON < MIN_BET) {
    throw new Error(`下注金额 ${targetVirtualAmount.toFixed(2)} 低于皇冠最低下注金额 ${MIN_BET}`);
  }

  const bets: number[] = [];
  let remaining = targetVirtualAmount;
  const effectiveMin = Math.max(limitRange.min, MIN_BET);
  const effectiveMax = Math.max(limitRange.max, MIN_BET);

  while (remaining > 0) {
    if (remaining <= effectiveMax) {
      // 最后一笔
      if (remaining >= effectiveMin) {
        bets.push(Math.round(remaining));
      } else if (remaining >= MIN_BET) {
        // 允许最后一笔小于用户设置的最小限额，只要满足皇冠最低下注金额
        bets.push(Math.round(remaining));
      } else if (bets.length > 0) {
        // 如果剩余金额太小（低于 50），合并到上一笔
        bets[bets.length - 1] += remaining;
        bets[bets.length - 1] = Math.round(bets[bets.length - 1]);
      } else {
        // 如果是第一笔且金额太小，强制使用最低下注金额
        bets.push(MIN_BET);
      }
      break;
    }
    
    // 随机生成一笔金额（在限额范围内）
    const randomAmount = Math.floor(Math.random() * (effectiveMax - effectiveMin + 1)) + effectiveMin;
    bets.push(randomAmount);
    remaining -= randomAmount;
  }
  
  return bets;
}

/**
 * 为多个账号拆分金额
 * @param options 拆分选项
 * @returns 拆分结果数组
 */
export function splitBetsForAccounts(options: SplitOptions): BetSplit[] {
  const {
    totalRealAmount,
    accountIds,
    accountDiscounts,
    singleLimitRange,
    accountLimits,
  } = options;

  if (accountIds.length === 0) {
    throw new Error('没有可用的账号');
  }

  if (totalRealAmount <= 0) {
    throw new Error('总金额必须大于 0');
  }

  // 先计算所有账号折扣的总和，用于按折扣占比分配金额
  const totalDiscount = accountIds.reduce((sum, accountId) => {
    const discount = accountDiscounts.get(accountId) || 1.0;
    if (discount <= 0 || discount > 1) {
      throw new Error(`账号 ${accountId} 的折扣设置不正确: ${discount}`);
    }
    return sum + discount;
  }, 0);

  if (totalDiscount <= 0) {
    throw new Error('所有账号的折扣设置无效');
  }

  const results: BetSplit[] = [];

  for (const accountId of accountIds) {
    const discount = accountDiscounts.get(accountId) || 1.0;

    if (discount <= 0 || discount > 1) {
      throw new Error(`账号 ${accountId} 的折扣设置不正确: ${discount}`);
    }

    // 按折扣占比计算该账号的目标实数金额，确保高折扣账号承担更多额度
    const targetPerAccount = (totalRealAmount * discount) / totalDiscount;

    // 确定该账号的限额范围
    let limitRange: { min: number; max: number };
    
    if (singleLimitRange) {
      // 使用用户指定的限额
      limitRange = singleLimitRange;
    } else if (accountLimits && accountLimits.has(accountId)) {
      // 使用账号的限额
      limitRange = accountLimits.get(accountId)!;
    } else {
      // 使用默认限额
      limitRange = { min: 50, max: 50000 };
    }

    // 为该账号拆分金额
    const virtualAmounts = splitAmountForAccount(targetPerAccount, discount, limitRange);

    // 生成拆分结果
    for (const virtualAmount of virtualAmounts) {
      const realAmount = virtualAmount * discount;
      results.push({
        accountId,
        virtualAmount,
        realAmount,
        discount,
      });
    }
  }

  return results;
}

/**
 * 生成轮流下注的队列
 * @param splits 拆分结果数组
 * @returns 按轮流顺序排列的下注队列
 */
export function generateBetQueue(splits: BetSplit[]): BetSplit[] {
  // 按账号分组
  const accountGroups = new Map<number, BetSplit[]>();
  
  for (const split of splits) {
    if (!accountGroups.has(split.accountId)) {
      accountGroups.set(split.accountId, []);
    }
    accountGroups.get(split.accountId)!.push(split);
  }

  // 轮流取出每个账号的下注
  const queue: BetSplit[] = [];
  const accountIds = Array.from(accountGroups.keys());
  let maxRounds = 0;
  
  // 找出最大轮数
  for (const bets of accountGroups.values()) {
    maxRounds = Math.max(maxRounds, bets.length);
  }

  // 按轮次轮流添加
  for (let round = 0; round < maxRounds; round++) {
    for (const accountId of accountIds) {
      const bets = accountGroups.get(accountId)!;
      if (round < bets.length) {
        queue.push(bets[round]);
      }
    }
  }

  return queue;
}

/**
 * 解析间隔时间范围
 * @param rangeStr 间隔时间字符串，如 "3-15"
 * @returns { min, max } 或 null
 */
export function parseIntervalRange(rangeStr?: string): { min: number; max: number } | null {
  if (!rangeStr || typeof rangeStr !== 'string') {
    return null;
  }

  const trimmed = rangeStr.trim();
  if (!trimmed) {
    return null;
  }

  // 支持格式：
  // - "3-15" / "3 - 15"
  // - "3~15" / "3～15"
  // - "3-15s" / "3-15秒"
  // - "5" / "5s"（等同于 5-5）
  const normalized = trimmed;
  const unitSuffix = '(?:\\s*(?:s|sec|secs|秒))?';
  const sep = '[-–—~～－]';

  const singleMatch = normalized.match(new RegExp(`^(\\d+(?:\\.\\d+)?)${unitSuffix}$`, 'i'));
  if (singleMatch) {
    const value = parseFloat(singleMatch[1]);
    if (!Number.isFinite(value) || value < 0) return null;
    return { min: value, max: value };
  }

  const match = normalized.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*${sep}\\s*(\\d+(?:\\.\\d+)?)${unitSuffix}$`, 'i'));
  if (!match) return null;

  const min = parseFloat(match[1]);
  const max = parseFloat(match[2]);

  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0 || min > max) {
    return null;
  }

  return { min, max };
}

/**
 * 生成随机间隔时间（秒）
 * @param intervalRange 间隔时间范围
 * @returns 随机秒数
 */
export function generateRandomInterval(intervalRange?: { min: number; max: number }): number {
  if (!intervalRange) {
    return 0;
  }

  const { min, max } = intervalRange;
  return Math.random() * (max - min) + min;
}
