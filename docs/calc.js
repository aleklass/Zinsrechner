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
    const monthly =
      v.ratePeriod === 'monthly'
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
      reinvestThreshold: Math.max(0, num(v.reinvestThreshold)),
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
        const depositBlocks =
          Math.floor((depositReserve + 1e-9) / threshold) * threshold;
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
        total: activeCapital + cash0,
      });
    }
    series.push({
      month: 0,
      value:
        activeCapital +
        (interestReserve + distributed + depositReserve),
    });

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
        total: totalWealth,
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
      growth: totalPaid > 0 ? (finalWealth / totalPaid - 1) * 100 : 0,
      interestPct:
        finalWealth > 0 ? (totalInterest / finalWealth) * 100 : 0,
      series,
      rows,
    };
  }

  // NextForrest: interest and deposits both land in a shared Cash pool;
  // Cash only ever moves into active capital in full 1000 blocks.
  //
  // Mehrfach-Einzahlungsstrategien: jede Strategie ist
  // { id, kind: 'fixed'|'roundup', amount, period: 'once'|'monthly'|'yearly'
  // (nur bei kind 'fixed' relevant), startMonth, endMonth, stopMode:
  // 'date'|'threshold'|'none', thresholdBasis: 'interest'|'capital',
  // thresholdValue }. Die beiden Einzahlungsarten selbst (fester Betrag vs.
  // 1000er-Aufrundung) entsprechen weiterhin genau den bisherigen — neu ist
  // nur, dass mehrere davon gleichzeitig laufen können und jede ihr eigenes
  // Start-/Endfenster (bzw. wahlweise eine Schwelle, siehe stopMode) hat.
  //
  // Mehrfach-Auszahlungsstrategien: { id, type: 'once'|'monthly'|'yearly'
  // |'percentage'|'cashSurplus', amount, startMonth, endMonth, stopMode,
  // thresholdBasis, thresholdValue } — unverändert gegenüber der bisherigen
  // Auszahlungsstrategie, nur ebenfalls mehrfach und mit Start/Ende.
  //
  // `stopMode` legt bei beiden fest, ob endMonth ODER die Schwelle greift —
  // nie beide gleichzeitig.

  function strategyPeriodicAmount(strategy, monthIndex) {
    const amount = Math.max(0, num(strategy.amount));
    if (strategy.type === 'once') {
      return monthIndex === strategy.startMonth ? amount : 0;
    }
    if (strategy.type === 'monthly') return amount;
    if (strategy.type === 'yearly') {
      return (monthIndex - strategy.startMonth) % 12 === 0 ? amount : 0;
    }
    return 0; // 'percentage'/'cashSurplus' werden separat behandelt
  }

  // Betrag einer Einzahlungsstrategie vom Typ 'fixed' für diesen Monat
  // (kind 'roundup' hat keinen festen Betrag/Periode — siehe Sweep-Schritt).
  function fixedDepositAmount(strategy, monthIndex) {
    const amount = Math.max(0, num(strategy.amount));
    if (strategy.period === 'once') {
      return monthIndex === strategy.startMonth ? amount : 0;
    }
    if (strategy.period === 'yearly') {
      return (monthIndex - strategy.startMonth) % 12 === 0 ? amount : 0;
    }
    return amount; // 'monthly' (Default)
  }

  // Einzahlungs-Strategien stoppen dauerhaft, sobald ihre Schwelle erreicht
  // ist (state.stopped bleibt danach für die restliche Laufzeit gesetzt) —
  // genau wie das bisherige einzelne Sparziel. Gilt für beide Arten (fest
  // wie Roundup) gleichermaßen; nur 'once' (nur bei kind 'fixed' möglich)
  // ignoriert Enddatum/Schwelle, da es ohnehin nur einen Monat betrifft.
  function depositStrategyActive(strategy, state, monthIndex, interestThisMonth, activeCapital) {
    if (state.stopped) return false;
    if (monthIndex < strategy.startMonth) return false;
    if (strategy.period === 'once') return monthIndex === strategy.startMonth;
    if (strategy.stopMode === 'date' && strategy.endMonth != null) {
      return monthIndex <= strategy.endMonth;
    }
    if (strategy.stopMode === 'threshold' && strategy.thresholdValue > 0) {
      const basisValue = strategy.thresholdBasis === 'interest' ? interestThisMonth : activeCapital;
      if (basisValue >= strategy.thresholdValue - 1e-9) {
        state.stopped = true;
        return false;
      }
      return true;
    }
    return true;
  }

  // Auszahlungs-Schwellen werden jeden Monat neu geprüft (nicht dauerhaft) —
  // eine Auszahlung kann also pausieren und später wieder einsetzen.
  function withdrawalStrategyActive(strategy, monthIndex, interestThisMonth, activeCapital) {
    if (monthIndex < strategy.startMonth) return false;
    if (strategy.type === 'once') return monthIndex === strategy.startMonth;
    if (strategy.stopMode === 'date' && strategy.endMonth != null) {
      return monthIndex <= strategy.endMonth;
    }
    if (strategy.stopMode === 'threshold' && strategy.thresholdValue > 0) {
      const basisValue = strategy.thresholdBasis === 'interest' ? interestThisMonth : activeCapital;
      return basisValue >= strategy.thresholdValue - 1e-9;
    }
    return true;
  }

  function withdrawalStrategyAmount(strategy, monthIndex, interestThisMonth, totalBonus) {
    if (strategy.type === 'percentage') {
      const pct = Math.max(0, num(strategy.amount)) / 100;
      return (interestThisMonth + totalBonus) * pct;
    }
    if (strategy.type === 'cashSurplus') return 0; // separat, nach den Einzahlungen
    return strategyPeriodicAmount(strategy, monthIndex);
  }

  // Migriert die alten flachen Einzahlungsfelder (nfDepositStrategy,
  // nfMonthlyDeposit, nfMonthlyDepositPeriod, nfDepositGoal,
  // nfDepositGoalThresholdBasis) in ein einzelnes nfDepositStrategies-Array
  // mit genau einem Eintrag, der exakt das bisherige Verhalten abbildet
  // (inkl. eines eventuellen Sparziels — auch bei kind 'roundup', was vorher
  // nicht separat modellierbar war). 'yearly' wird auf startMonth 12
  // verankert, damit die Kadenz exakt der alten `monthIndex % 12 === 0`-
  // Logik entspricht (Monat 12, 24, …).
  function toDepositStrategiesMigration(flat) {
    const kind = flat.nfDepositStrategy === 'fixed' ? 'fixed' : 'roundup';
    const amount = Math.max(0, num(flat.nfMonthlyDeposit));
    const goal = Math.max(0, num(flat.nfDepositGoal));
    const isYearly = flat.nfMonthlyDepositPeriod === 'yearly';
    const active = kind === 'roundup' || amount > 0 || goal > 0;
    const strategies = active ? [{
      id: 'nfd-migrated-1',
      kind,
      amount: kind === 'fixed' ? amount : 0,
      period: isYearly ? 'yearly' : 'monthly',
      startMonth: kind === 'fixed' && isYearly ? 12 : 1,
      endMonth: null,
      stopMode: goal > 0 ? 'threshold' : 'none',
      thresholdBasis: flat.nfDepositGoalThresholdBasis === 'interest' ? 'interest' : 'capital',
      thresholdValue: goal,
    }] : [];
    return strategies;
  }

  // Migriert die alten flachen Auszahlungsfelder in ein nfWithdrawalStrategies-
  // Array. 'percentage'/'cashSurplus' laufen unverändert durch; 'fixed' wird
  // je nach Periode zu 'monthly'/'yearly' (yearly ebenfalls auf Monat 12
  // verankert, wie bei den Einzahlungen).
  function toWithdrawalStrategiesMigration(flat) {
    const type =
      flat.nfWithdrawalStrategy === 'percentage' || flat.nfWithdrawalStrategy === 'cashSurplus'
        ? flat.nfWithdrawalStrategy
        : 'fixed';
    const amount = Math.max(0, num(flat.nfWithdrawalAmount));
    const minCapital = Math.max(0, num(flat.nfWithdrawalMinCapital));
    const isYearly = flat.nfWithdrawalPeriod === 'yearly';
    const active = type === 'cashSurplus' || amount > 0;
    if (!active) return [];
    return [{
      id: 'nfw-migrated-1',
      type: type === 'fixed' ? (isYearly ? 'yearly' : 'monthly') : type,
      amount,
      startMonth: type === 'fixed' && isYearly ? 12 : 1,
      endMonth: null,
      stopMode: minCapital > 0 ? 'threshold' : 'none',
      thresholdBasis: flat.nfWithdrawalThresholdBasis === 'interest' ? 'interest' : 'capital',
      thresholdValue: minCapital,
    }];
  }

  // Wandelt ein gespeichertes Szenario (aus localStorage) mit den alten
  // flachen NextForrest-Feldern in das neue Array-Schema um. Bereits im
  // neuen Schema vorliegende Szenarien bleiben unverändert. Muss dieselben
  // Simulationsergebnisse liefern wie vorher (siehe calc.test.js).
  function migrateScenarioValues(values) {
    const out = { ...values };
    if (!Array.isArray(out.nfDepositStrategies)) {
      out.nfDepositStrategies = toDepositStrategiesMigration(out);
      delete out.nfDepositStrategy;
      delete out.nfMonthlyDeposit;
      delete out.nfMonthlyDepositPeriod;
      delete out.nfDepositGoal;
      delete out.nfDepositGoalThresholdBasis;
    }
    if (!Array.isArray(out.nfWithdrawalStrategies)) {
      out.nfWithdrawalStrategies = toWithdrawalStrategiesMigration(out);
      delete out.nfWithdrawalStrategy;
      delete out.nfWithdrawalAmount;
      delete out.nfWithdrawalPeriod;
      delete out.nfWithdrawalMinCapital;
      delete out.nfWithdrawalThresholdBasis;
    }
    delete out.nfRoundupEnabled;
    return out;
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
    const depositStrategies = Array.isArray(v.nfDepositStrategies) ? v.nfDepositStrategies : [];
    const depositState = depositStrategies.map(() => ({ stopped: false }));
    const withdrawalStrategies = Array.isArray(v.nfWithdrawalStrategies) ? v.nfWithdrawalStrategies : [];

    // Team-/Empfehlungsstruktur: jedes Teammitglied läuft als eigene,
    // unabhängige simulateNextForrest()-Instanz ab seinem Beitrittsmonat.
    // Deren Ergebnisse fließen als Bonus-Cashflow direkt in das eigene
    // Cash-Konto dieser Simulation ein (siehe Schritt 0 unten) — Boni sind
    // also kein separates Nebenergebnis, sondern Teil von cash/activeCapital.
    const teamMembersRaw = Array.isArray(v.nfTeamMembers)
      ? v.nfTeamMembers
      : [];
    const teamSimulated = teamMembersRaw.length
      ? teamMembersRaw
          .map((m) => simulateTeamMember(v, m))
          .filter(Boolean)
      : [];
    const hasTeam = teamSimulated.length > 0;
    let teamRankIndex = 0;
    const teamRankUps = [];
    let teamTotalTippgeberBonus = 0;
    let teamTotalOwnBonus = 0;
    let teamTotalLevelBonus = 0;
    const teamRows = [];

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
        withdrawn: 0,
      });
    }

    series.push({ month: 0, value: activeCapital + cash });

    for (let m = 1; m <= months; m++) {
      const openingActive = activeCapital;

      let feeThisMonth = 0;
      let withdrawnNet = 0;
      let depositGross = 0;
      let totalBonus = 0;

      const interest = activeCapital * monthlyRate;
      totalInterest += interest;
      cash += interest;

      // 0) Team-Boni landen als Cash-Zufluss auf dem eigenen Konto, noch vor
      // Auszahlung/Einzahlung/Sweep dieses Monats — sie verhalten sich also
      // wie jeder andere Cash-Zugang und können in genau diesem Monat noch
      // mit in einen 1000er-Block gesweept werden. Qualifikation prüft das
      // aktive Kapital, mit dem dieser Monat begonnen wurde (vor dem
      // Sweep von Schritt 3).
      if (hasTeam) {
        let teamVolume = 0;
        const levelActive = {};
        let tippgeberBonus = 0;
        // Monatsverlauf je Mitglied für die TeamBonus-Tabelle (aufklappbare
        // Detailzeile) — eine Momentaufnahme pro aktivem Mitglied für genau
        // diesen Kalendermonat, siehe memberMonthSnapshot().
        const monthMembers = [];

        teamSimulated.forEach((sim) => {
          const active = activeAt(sim, m);
          teamVolume += active;
          const level = Math.round(num(sim.member.level) || 1);
          levelActive[level] = (levelActive[level] || 0) + active;

          // Tippgeber-Bonus (50 €/Block) gilt nur für direkt geworbene
          // Personen (Ebene 1) — unabhängig vom aktuellen Rang. Jeder
          // 1000er-Block zählt, der ins aktive Kapital des Mitglieds
          // gesweept wird — egal ob aus einer neuen Einzahlung oder aus
          // reinvestierten Zinsen. Läuft dauerhaft weiter, solange das
          // Kapital des Mitglieds wächst.
          let memberBonus = 0;
          if (level === 1) {
            let reinvestedThisMonth = 0;
            if (m === sim.joinMonth) {
              const row0 = sim.result.rows.find((r) => r.month === 0);
              if (row0) reinvestedThisMonth += row0.reinvested;
            }
            const localRowM = localRow(sim, m);
            if (localRowM) reinvestedThisMonth += localRowM.reinvested;

            if (reinvestedThisMonth > 0) {
              memberBonus = (reinvestedThisMonth / NF_BLOCK) * TEAM_BLOCK_BONUS;
              tippgeberBonus += memberBonus;
            }
          }

          if (m >= sim.joinMonth) {
            monthMembers.push({
              id: sim.member.id,
              name: sim.member.name || '',
              level,
              joinMonth: sim.joinMonth,
              row: memberMonthSnapshot(sim, m),
              tippgeberBonus: memberBonus,
            });
          }
        });

        // Rang-Aufstieg: der höchste Rang, dessen beide Schwellen (eigenes
        // aktives Kapital + Team-Volumen über alle Ebenen) erreicht sind,
        // bleibt dauerhaft bestehen und ersetzt niedrigere Ränge (nicht
        // kumulativ).
        for (let i = RANKS.length - 1; i > teamRankIndex; i--) {
          if (
            activeCapital >= RANKS[i].ownThreshold &&
            teamVolume >= RANKS[i].teamThreshold
          ) {
            teamRankIndex = i;
            teamRankUps.push({ rankIndex: i, rank: RANKS[i].name, month: m });
            break;
          }
        }

        const rank = RANKS[teamRankIndex];
        // "Eigen"-Bonus: Prozentsatz auf das eigene aktive Kapital, kommt
        // zusätzlich zur normalen Rendite hinzu.
        const ownBonus = rank.ownPct > 0 ? activeCapital * rank.ownPct : 0;
        // Downline-Boni: jede Ebene wird auf ihr EIGENES aktives Kapital
        // berechnet (nicht auf das aggregierte Team-Volumen), und nur die
        // Ebenen, die der aktuelle Rang freischaltet, zahlen aus.
        const e1Bonus = (rank.levelPcts[0] || 0) * (levelActive[1] || 0);
        const e2Bonus = (rank.levelPcts[1] || 0) * (levelActive[2] || 0);
        const e3Bonus = (rank.levelPcts[2] || 0) * (levelActive[3] || 0);
        const levelBonusTotal = e1Bonus + e2Bonus + e3Bonus;
        totalBonus = tippgeberBonus + ownBonus + levelBonusTotal;

        teamTotalTippgeberBonus += tippgeberBonus;
        teamTotalOwnBonus += ownBonus;
        teamTotalLevelBonus += levelBonusTotal;
        cash += totalBonus;

        teamRows.push({
          month: m,
          rank: rank.name,
          rankIndex: teamRankIndex,
          teamVolume,
          ownActive: activeCapital,
          e1Active: levelActive[1] || 0,
          e2Active: levelActive[2] || 0,
          e3Active: levelActive[3] || 0,
          tippgeberBonus,
          ownBonus,
          e1Bonus,
          e2Bonus,
          e3Bonus,
          totalBonus,
          members: monthMembers,
        });
      }

      // 1) Withdrawals skim from this month's cash before reinvestment
      // ('once'/'monthly'/'yearly'/'percentage', summed across all active
      // strategies). 'cashSurplus' strategies are deferred until after
      // deposits (step 2, below) so they reflect exactly the remainder that
      // would otherwise miss the next 1000er block in step 3.
      const applyWithdrawal = (gross) => {
        gross = Math.max(0, Math.min(gross, cash));
        if (gross > 1e-9) {
          const fee = gross * NF_WITHDRAWAL_FEE_PCT;
          cash -= gross;
          totalWithdrawn += gross - fee;
          feeThisMonth += fee;
          totalWithdrawalFees += fee;
          withdrawnNet += gross - fee;
        }
      };

      let preDepositWithdrawalGross = 0;
      withdrawalStrategies.forEach((s) => {
        if (s.type === 'cashSurplus') return;
        if (!withdrawalStrategyActive(s, m, interest, activeCapital)) return;
        preDepositWithdrawalGross += withdrawalStrategyAmount(s, m, interest, totalBonus);
      });
      if (preDepositWithdrawalGross > 0) applyWithdrawal(preDepositWithdrawalGross);

      // 2) Deposits — each strategy sums independently (own start/end
      // month and, if stopMode is 'threshold', its own permanent stop once
      // its goal is reached). 'fixed' strategies run first (they add a
      // known amount to Cash); 'roundup' strategies run afterwards, each
      // topping Cash up to the next 1000er block — so a Roundup strategy
      // active in the same month as a fixed one tops up the combined total,
      // exactly like the historical single-strategy behavior did.
      depositStrategies.forEach((s, i) => {
        if (s.kind === 'roundup') return;
        if (!depositStrategyActive(s, depositState[i], m, interest, activeCapital)) return;
        const amount = fixedDepositAmount(s, m);
        if (amount > 0) {
          const fee = amount * NF_DEPOSIT_FEE_PCT;
          cash += amount;
          totalPaid += amount + fee;
          feeThisMonth += fee;
          totalDepositFees += fee;
          depositGross += amount;
          totalDepositPrincipal += amount;
        }
      });

      depositStrategies.forEach((s, i) => {
        if (s.kind !== 'roundup') return;
        if (!depositStrategyActive(s, depositState[i], m, interest, activeCapital)) return;
        if (cash <= 1e-9) return;
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
      });

      // 2b) 'cashSurplus' withdrawals: pay out exactly the remainder that
      // would otherwise miss the next 1000er block and stay uninvested in
      // Cash — computed after deposits so it matches the actual sweep rest.
      // Multiple simultaneously active cashSurplus strategies still only pay
      // out the one shared remainder once (there is nothing left for a
      // second one to skim).
      const hasActiveCashSurplus = withdrawalStrategies.some(
        (s) => s.type === 'cashSurplus' && withdrawalStrategyActive(s, m, interest, activeCapital),
      );
      if (hasActiveCashSurplus) {
        const blockRemainder =
          cash - Math.floor((cash + 1e-9) / NF_BLOCK) * NF_BLOCK;
        applyWithdrawal(Math.max(0, blockRemainder));
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
        withdrawn: withdrawnNet,
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
      growth: totalPaid > 0 ? (finalWealth / totalPaid - 1) * 100 : 0,
      interestPct:
        finalWealth > 0 ? (totalInterest / finalWealth) * 100 : 0,
      series,
      rows,
      team: hasTeam
        ? {
            rows: teamRows,
            rankIndex: teamRankIndex,
            rank: RANKS[teamRankIndex].name,
            rankUps: teamRankUps,
            totalTippgeberBonus: teamTotalTippgeberBonus,
            totalOwnBonus: teamTotalOwnBonus,
            totalLevelBonus: teamTotalLevelBonus,
            totalBonus:
              teamTotalTippgeberBonus +
              teamTotalOwnBonus +
              teamTotalLevelBonus,
          }
        : null,
    };
  }

  function runSimulation(values) {
    return values.investmentType === 'nextforrest'
      ? simulateNextForrest(values)
      : simulate(values);
  }

  // Team-/Empfehlungsstruktur (nur NextForrest): pro geworbener Person läuft
  // eine eigene simulateNextForrest()-Instanz, ab ihrem Beitrittsmonat auf der
  // gemeinsamen Zeitachse des Hauptszenarios. Daraus werden zwei Bonusarten
  // abgeleitet: ein einmaliger Tippgeber-Bonus pro 1000er-Block, den eine
  // Ebene-1-Empfehlung investiert, und — abhängig vom erreichten Rang —
  // laufende monatliche Beteiligungen auf das eigene aktive Kapital sowie
  // auf das aktive Kapital der Ebenen 1–3 (jeweils EIGENES Kapital dieser
  // Ebene, nicht das aggregierte Team-Volumen). Die Rang-Schwelle selbst
  // wird auf das aggregierte Team-Volumen über ALLE Ebenen gemessen.
  const TEAM_BLOCK_BONUS = 50;

  // Rang ist dauerhaft und ersetzt niedrigere Ränge (nicht kumulativ) — wer
  // Gold erreicht, bekommt Golds Boni, nicht zusätzlich die von Bronze/Silber.
  const RANKS = [
    { name: 'Forrest Member', ownThreshold: 0, teamThreshold: 0, ownPct: 0, levelPcts: [] },
    { name: 'Forrest Bronze', ownThreshold: 10000, teamThreshold: 100000, ownPct: 0, levelPcts: [0.01] },
    { name: 'Forrest Silver', ownThreshold: 20000, teamThreshold: 200000, ownPct: 0, levelPcts: [0.01, 0.01] },
    { name: 'Forrest Gold', ownThreshold: 30000, teamThreshold: 300000, ownPct: 0.01, levelPcts: [0.01, 0.01] },
    { name: 'Forrest Platinum', ownThreshold: 60000, teamThreshold: 600000, ownPct: 0.01, levelPcts: [0.01, 0.01, 0.01] },
    { name: 'Forrest Diamond', ownThreshold: 100000, teamThreshold: 1000000, ownPct: 0.02, levelPcts: [0.01, 0.01, 0.01] }
  ];

  function simulateTeamMember(v, member) {
    const totalMonths = monthsCountFor(v);
    const joinMonth = Math.max(
      1,
      Math.round(num(member.joinMonth) || 1),
    );
    const memberMonths = totalMonths - joinMonth + 1;
    if (memberMonths <= 0) return null;

    // Eigene Szenario-Eigenschaften pro Mitglied. Fehlt ein Feld (z. B. bei
    // Mitgliedern, die vor Einführung dieser Eigenschaften angelegt wurden),
    // greift derselbe Fallback wie zuvor: Rendite und Einzahlungsstrategie
    // vom Hauptszenario übernommen, Einzahlungsziel und Auszahlung
    // deaktiviert. Die flachen Mitglieder-Felder selbst bleiben unverändert
    // (eigene UI, siehe addTeamMember) — sie werden hier lediglich in das
    // Array-Schema übersetzt, das simulateNextForrest() erwartet, mit
    // denselben Migrations-Hilfsfunktionen wie für gespeicherte Szenarien.
    const flat = {
      // v selbst führt seit den Mehrfachstrategien keine einzelne flache
      // nfDepositStrategy mehr (nur noch das nfDepositStrategies-Array,
      // das auch gemischte Einträge enthalten kann) — es gibt also keinen
      // einzelnen Wert mehr, der an ein Mitglied "vererbt" werden könnte.
      // Ohne eigene Angabe fällt ein Mitglied daher auf 'fixed' zurück.
      nfDepositStrategy: member.nfDepositStrategy || 'fixed',
      nfMonthlyDeposit: num(member.monthlyDeposit),
      nfMonthlyDepositPeriod: member.nfMonthlyDepositPeriod || 'monthly',
      nfDepositGoal: Math.max(0, num(member.nfDepositGoal)),
      nfDepositGoalThresholdBasis: member.nfDepositGoalThresholdBasis || 'interest',
      nfWithdrawalStrategy: member.nfWithdrawalStrategy || 'fixed',
      nfWithdrawalAmount: Math.max(0, num(member.nfWithdrawalAmount)),
      nfWithdrawalPeriod: member.nfWithdrawalPeriod || 'monthly',
      nfWithdrawalMinCapital: Math.max(0, num(member.nfWithdrawalMinCapital)),
      nfWithdrawalThresholdBasis: member.nfWithdrawalThresholdBasis || 'interest',
    };
    const result = simulateNextForrest({
      start: num(member.startCapital),
      // Wie beim Hauptszenario: unchecked lässt das Startkapital direkt als
      // aktives Kapital beginnen statt als Einzahlungsereignis — dadurch
      // entsteht kein row0-Deposit und somit auch kein Tippgeber-Bonus im
      // Beitrittsmonat auf diesen Betrag.
      includeStartCapital: member.includeStartCapital !== false,
      duration: memberMonths,
      durationUnit: 'months',
      nfRate: member.nfRate || v.nfRate,
      nfDepositStrategies: toDepositStrategiesMigration(flat),
      nfWithdrawalStrategies: toWithdrawalStrategiesMigration(flat),
    });

    return { member, joinMonth, result };
  }

  // sim = { member, joinMonth, result } aus simulateTeamMember().
  function localRow(sim, month) {
    const localMonth = month - sim.joinMonth + 1;
    if (localMonth < 1) return null;
    return (
      sim.result.rows.find((r) => r.month === localMonth) || null
    );
  }

  // Momentaufnahme der eigenen Monatsverlauf-Zeile eines Mitglieds für einen
  // Kalendermonat — für die aufklappbare Detailansicht je Monat in der
  // TeamBonus-Tabelle. Im Beitrittsmonat verschmilzt sie die interne Zeile 0
  // (Startkapital-Einzahlungsereignis) mit der ersten regulären Monatszeile
  // zu einer einzigen Zeile für diesen Kalendermonat — genau wie der
  // Tippgeber-Bonus oben beide Ereignisse für den Beitrittsmonat
  // zusammenzählt. In jedem folgenden Monat ist es exakt localRow(sim, month).
  function memberMonthSnapshot(sim, month) {
    const localRowM = localRow(sim, month);
    if (!localRowM) return null;
    if (month !== sim.joinMonth) return localRowM;

    const row0 = sim.result.rows.find((r) => r.month === 0);
    if (!row0) return localRowM;

    return {
      month: localRowM.month,
      openingActive: row0.openingActive,
      deposit: row0.deposit + localRowM.deposit,
      withdrawn: (row0.withdrawn || 0) + (localRowM.withdrawn || 0),
      interest: row0.interest + localRowM.interest,
      reinvested: row0.reinvested + localRowM.reinvested,
      cash: localRowM.cash,
      fee: (row0.fee || 0) + (localRowM.fee || 0),
      active: localRowM.active,
      total: localRowM.total,
    };
  }

  // Aktives (verzinstes) Kapital des Mitglieds, mit dem der Kalendermonat
  // `month` beginnt — Basis sowohl für die 100K-Team-Volumen-Schwelle (alle
  // Ebenen) als auch für die 1 %-Ebene-1-Beteiligung. Nutzt bewusst
  // `openingActive` (Stand VOR der Zinsgutschrift dieses Monats), nicht den
  // Endstand: im Beitrittsmonat entspricht das exakt dem investierten
  // Betrag (abzüglich evtl. Rundungsrest unter 1000 €), statt schon die
  // Rendite dieses ersten Monats mitzuzählen.
  function activeAt(sim, month) {
    const row = localRow(sim, month);
    if (row) return row.openingActive;
    if (month < sim.joinMonth) return 0;
    const last = sim.result.rows[sim.result.rows.length - 1];
    return last ? last.active : 0;
  }

  return {
    NF_RATES,
    NF_DEPOSIT_FEE_PCT,
    NF_WITHDRAWAL_FEE_PCT,
    NF_BLOCK,
    TEAM_BLOCK_BONUS,
    RANKS,
    num,
    monthsCountFor,
    rateForCreditPeriod,
    interestDue,
    contributionThisMonth,
    getSettings,
    simulate,
    strategyPeriodicAmount,
    fixedDepositAmount,
    depositStrategyActive,
    withdrawalStrategyActive,
    withdrawalStrategyAmount,
    toDepositStrategiesMigration,
    toWithdrawalStrategiesMigration,
    migrateScenarioValues,
    simulateNextForrest,
    runSimulation,
    simulateTeamMember,
  };
});
