// Pure calculation core for the Zinseszinsrechner — no DOM access, so it
// runs unchanged in the browser (<script src="calc.js">) and under Node
// (require('./calc.js')) for automated tests.
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.ZinsCalc = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const NF_RATES = { low: 0.05, high: 0.052 };
  const NF_DEPOSIT_FEE_PCT = 0.015;
  const NF_WITHDRAWAL_FEE_PCT = 0.035;
  const NF_BLOCK = 1000;

  function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  function monthsCountFor(v) {
    const d = Math.max(1, Math.round(num(v.duration)));
    return v.durationUnit === 'years' ? d * 12 : d;
  }

  function rateForCreditPeriod(v) {
    const raw = num(v.rate) / 100;
    const monthly = v.ratePeriod === 'monthly'
      ? raw
      : Math.pow(1 + raw, 1 / 12) - 1;

    const c = v.compound;
    if (c === 'monthly') return monthly;
    if (c === 'quarterly') return Math.pow(1 + monthly, 3) - 1;
    return Math.pow(1 + monthly, 12) - 1;
  }

  function interestDue(v, monthIndex) {
    const c = v.compound;
    if (c === 'monthly') return true;
    if (c === 'quarterly') return monthIndex % 3 === 0;
    if (c === 'annual') return monthIndex % 12 === 0;
    return true;
  }

  function contributionThisMonth(v, monthIndex) {
    const amount = Math.max(0, num(v.contribution));
    if (v.contributionPeriod === 'monthly') return amount;
    return monthIndex % 12 === 0 ? amount : 0;
  }

  function getSettings(v) {
    return {
      months: monthsCountFor(v),
      creditRate: rateForCreditPeriod(v),
      depositTiming: v.depositTiming,
      reinvestMode: v.reinvestMode,
      reinvestThreshold: Math.max(0, num(v.reinvestThreshold))
    };
  }

  function simulate(v) {
    const settings = getSettings(v);
    const rawStart = Math.max(0, num(v.start));
    // Checked: start capital enters as a month-1 deposit (see below).
    // Unchecked: start capital is the opening balance from month 0, exactly
    // like the calculator behaved before this toggle existed.
    const startAsDeposit = v.includeStartCapital !== false;
    const startCapital = startAsDeposit ? 0 : rawStart;
    let activeCapital = startCapital;
    let interestReserve = 0;
    let depositReserve = 0;
    let distributed = 0;
    let totalPaid = startCapital;
    let totalInterest = 0;
    let totalReinvested = 0;
    let totalContributions = 0;

    const series = [];
    const rows = [];

    function reinvestAvailable() {
      let reinvested = 0;

      if (interestReserve > 0) {
        activeCapital += interestReserve;
        reinvested += interestReserve;
        interestReserve = 0;
      }

      const threshold = settings.reinvestThreshold;
      if (threshold > 0) {
        const depositBlocks = Math.floor((depositReserve + 1e-9) / threshold) * threshold;
        if (depositBlocks > 0) {
          activeCapital += depositBlocks;
          depositReserve -= depositBlocks;
          reinvested += depositBlocks;
        }
      } else if (depositReserve > 0) {
        activeCapital += depositReserve;
        reinvested += depositReserve;
        depositReserve = 0;
      }

      if (Math.abs(interestReserve) < 1e-8) interestReserve = 0;
      if (Math.abs(depositReserve) < 1e-8) depositReserve = 0;

      totalReinvested += reinvested;
      return reinvested;
    }

    // Row 0: start capital enters as its own deposit event, kept separate
    // from the regular contribution schedule (which only starts month 1) so
    // it never interacts with the deposit strategy for month 1.
    if (startAsDeposit && rawStart > 0) {
      depositReserve += rawStart;
      totalPaid += rawStart;
      totalContributions += rawStart;
      const reinvested0 = reinvestAvailable();
      const cash0 = interestReserve + distributed + depositReserve;
      rows.push({
        month: 0,
        openingActive: 0,
        deposit: rawStart,
        interest: 0,
        reinvested: reinvested0,
        cash: cash0,
        active: activeCapital,
        total: activeCapital + cash0
      });
    }
    series.push({ month: 0, value: activeCapital + (interestReserve + distributed + depositReserve) });

    for (let m = 1; m <= settings.months; m++) {
      const openingActive = activeCapital;
      const contribution = contributionThisMonth(v, m);
      totalContributions += contribution;
      const deposit = contribution;
      let interest = 0;
      let reinvested = 0;

      if (settings.depositTiming === 'start' && deposit > 0) {
        depositReserve += deposit;
        totalPaid += deposit;
        reinvested += reinvestAvailable();
      }

      if (interestDue(v, m)) {
        interest = activeCapital * settings.creditRate;
        totalInterest += interest;
        if (settings.reinvestMode === 'distributing') {
          distributed += interest;
        } else {
          interestReserve += interest;
          reinvested += reinvestAvailable();
        }
      }

      if (settings.depositTiming === 'end' && deposit > 0) {
        depositReserve += deposit;
        totalPaid += deposit;
        reinvested += reinvestAvailable();
      }

      const cash = interestReserve + distributed + depositReserve;
      const totalWealth = activeCapital + cash;

      rows.push({
        month: m,
        openingActive,
        deposit,
        interest,
        reinvested,
        cash,
        active: activeCapital,
        total: totalWealth
      });

      series.push({ month: m, value: totalWealth });
    }

    const cash = interestReserve + distributed + depositReserve;
    const finalWealth = activeCapital + cash;

    return {
      startCapital,
      activeCapital,
      cash,
      totalPaid,
      totalDeposits: totalContributions,
      totalInterest,
      totalReinvested,
      totalFees: 0,
      totalDepositFees: 0,
      totalWithdrawalFees: 0,
      totalWithdrawn: 0,
      finalWealth,
      growth: totalPaid > 0 ? ((finalWealth / totalPaid) - 1) * 100 : 0,
      interestPct: finalWealth > 0 ? (totalInterest / finalWealth) * 100 : 0,
      series,
      rows
    };
  }

  // NextForrest: interest and deposits both land in a shared Cash pool;
  // Cash only ever moves into active capital in full 1000 blocks.
  function nfWithdrawalGross(v, monthIndex, interestThisMonth) {
    if (v.nfWithdrawalStrategy === 'percentage') {
      const pct = Math.max(0, num(v.nfWithdrawalAmount)) / 100;
      return interestThisMonth * pct;
    }
    const amount = Math.max(0, num(v.nfWithdrawalAmount));
    if (v.nfWithdrawalPeriod === 'monthly') return amount;
    return monthIndex % 12 === 0 ? amount : 0;
  }

  function simulateNextForrest(v) {
    const months = monthsCountFor(v);
    const monthlyRate = NF_RATES[v.nfRate] ?? NF_RATES.low;
    const rawStart = Math.max(0, num(v.start));
    // Checked: start capital enters as a month-1 deposit through the Cash
    // pool (fee + block-sweep apply). Unchecked: it's the opening active
    // capital from month 0, exactly like before this toggle existed.
    const startAsDeposit = v.includeStartCapital !== false;
    const startCapital = startAsDeposit ? 0 : rawStart;
    const depositGoal = Math.max(0, num(v.nfDepositGoal));
    const depositGoalBasis = v.nfDepositGoalThresholdBasis === 'interest' ? 'interest' : 'capital';
    const minCapitalForWithdrawal = Math.max(0, num(v.nfWithdrawalMinCapital));
    const withdrawalThresholdBasis = v.nfWithdrawalThresholdBasis === 'interest' ? 'interest' : 'capital';

    let activeCapital = startCapital;
    let cash = 0;
    let totalPaid = startCapital;
    let totalInterest = 0;
    let totalFees = 0;
    let totalDepositFees = 0;
    let totalWithdrawalFees = 0;
    let totalWithdrawn = 0;
    let totalReinvested = 0;
    let totalDepositPrincipal = 0;
    let depositsStopped = false;

    const series = [];
    const rows = [];

    // Row 0: start capital enters as its own deposit event into the Cash
    // pool, kept separate from the regular deposit strategy (fixed/roundup),
    // which only starts month 1 — subject to the same 1.5% deposit fee,
    // swept in full 1000 blocks like any other deposit.
    if (startAsDeposit && rawStart > 0) {
      const fee0 = rawStart * NF_DEPOSIT_FEE_PCT;
      cash += rawStart;
      totalPaid += rawStart + fee0;
      totalDepositFees += fee0;
      totalFees += fee0;
      totalDepositPrincipal += rawStart;

      const blocks0 = Math.floor((cash + 1e-9) / NF_BLOCK) * NF_BLOCK;
      let reinvested0 = 0;
      if (blocks0 > 0) {
        activeCapital += blocks0;
        cash -= blocks0;
        reinvested0 = blocks0;
        totalReinvested += blocks0;
      }
      if (Math.abs(cash) < 1e-8) cash = 0;

      rows.push({
        month: 0,
        openingActive: 0,
        deposit: rawStart,
        interest: 0,
        reinvested: reinvested0,
        cash,
        active: activeCapital,
        total: activeCapital + cash,
        fee: fee0,
        withdrawn: 0
      });
    }
    series.push({ month: 0, value: activeCapital + cash });

    for (let m = 1; m <= months; m++) {
      const openingActive = activeCapital;

      let feeThisMonth = 0;
      let withdrawnNet = 0;
      let depositGross = 0;

      const interest = activeCapital * monthlyRate;
      totalInterest += interest;
      cash += interest;

      // 1) Withdrawal skims from this month's cash before reinvestment.
      const meetsWithdrawalThreshold = withdrawalThresholdBasis === 'interest'
        ? interest >= minCapitalForWithdrawal
        : activeCapital >= minCapitalForWithdrawal;
      if (meetsWithdrawalThreshold) {
        let gross = nfWithdrawalGross(v, m, interest);
        gross = Math.max(0, Math.min(gross, cash));
        if (gross > 1e-9) {
          const fee = gross * NF_WITHDRAWAL_FEE_PCT;
          cash -= gross;
          totalWithdrawn += gross - fee;
          feeThisMonth += fee;
          totalWithdrawalFees += fee;
          withdrawnNet = gross - fee;
        }
      }

      // 2) Deposits — stop for good once the deposit goal is reached, on
      // either basis: active capital (checked against the level entering
      // this month) or this month's own interest.
      const meetsDepositGoal = depositGoalBasis === 'interest'
        ? interest >= depositGoal - 1e-9
        : activeCapital >= depositGoal - 1e-9;
      if (depositGoal > 0 && meetsDepositGoal) {
        depositsStopped = true;
      }

      if (!depositsStopped) {
        if (v.nfDepositStrategy === 'fixed') {
          const contribution = contributionThisMonth(
            { contribution: v.nfMonthlyDeposit, contributionPeriod: v.nfMonthlyDepositPeriod }, m
          );
          if (contribution > 0) {
            const fee = contribution * NF_DEPOSIT_FEE_PCT;
            cash += contribution;
            totalPaid += contribution + fee;
            feeThisMonth += fee;
            totalDepositFees += fee;
            depositGross += contribution;
            totalDepositPrincipal += contribution;
          }
        } else if (cash > 1e-9) {
          const target = Math.ceil((cash - 1e-9) / NF_BLOCK) * NF_BLOCK;
          const topUp = Math.max(0, target - cash);
          if (topUp > 1e-9) {
            const fee = topUp * NF_DEPOSIT_FEE_PCT;
            cash += topUp;
            totalPaid += topUp + fee;
            feeThisMonth += fee;
            totalDepositFees += fee;
            depositGross += topUp;
            totalDepositPrincipal += topUp;
          }
        }
      }

      // 3) Sweep full 1000 blocks from Cash into active capital.
      const blocks = Math.floor((cash + 1e-9) / NF_BLOCK) * NF_BLOCK;
      let reinvested = 0;
      if (blocks > 0) {
        activeCapital += blocks;
        cash -= blocks;
        reinvested = blocks;
        totalReinvested += blocks;
      }
      if (Math.abs(cash) < 1e-8) cash = 0;

      totalFees += feeThisMonth;

      const totalWealth = activeCapital + cash;

      rows.push({
        month: m,
        openingActive,
        deposit: depositGross,
        interest,
        reinvested,
        cash,
        active: activeCapital,
        total: totalWealth,
        fee: feeThisMonth,
        withdrawn: withdrawnNet
      });

      series.push({ month: m, value: totalWealth });
    }

    const finalWealth = activeCapital + cash;

    return {
      startCapital,
      activeCapital,
      cash,
      totalPaid,
      totalDeposits: totalDepositPrincipal,
      totalInterest,
      totalReinvested,
      totalFees,
      totalDepositFees,
      totalWithdrawalFees,
      totalWithdrawn,
      finalWealth,
      growth: totalPaid > 0 ? ((finalWealth / totalPaid) - 1) * 100 : 0,
      interestPct: finalWealth > 0 ? (totalInterest / finalWealth) * 100 : 0,
      series,
      rows
    };
  }

  function runSimulation(values) {
    return values.investmentType === 'nextforrest' ? simulateNextForrest(values) : simulate(values);
  }

  return {
    NF_RATES,
    NF_DEPOSIT_FEE_PCT,
    NF_WITHDRAWAL_FEE_PCT,
    NF_BLOCK,
    num,
    monthsCountFor,
    rateForCreditPeriod,
    interestDue,
    contributionThisMonth,
    getSettings,
    simulate,
    nfWithdrawalGross,
    simulateNextForrest,
    runSimulation
  };
});
