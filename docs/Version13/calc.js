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
  const TAX_RATE_DEFAULT = 26.375;
  const NF_DEPOSIT_FEE_PCT = 0.015;
  const NF_WITHDRAWAL_FEE_PCT = 0.035;
  const NF_BLOCK = 1000;

  function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  // ROI-Kennzahlen, gemeinsam für Klassisch und NextForrest: `growth` ist
  // die Gesamtrendite über die komplette Laufzeit gegenüber den eigenen
  // Einzahlungen — inklusive bereits erhaltener Auszahlungen (sonst würde
  // eine aktive Auszahlungsstrategie die Rendite künstlich niedrig
  // aussehen lassen, weil das ausgezahlte Geld im Endvermögen fehlt, aber
  // ja trotzdem beim Anleger angekommen ist). `roiPerYear` rechnet dieselbe
  // Gesamtrendite auf eine jährliche Rate um (Näherung: behandelt alle
  // Einzahlungen so, als wären sie zu Laufzeitbeginn erfolgt — kein
  // zeitpunktgenauer IRR), damit Szenarien unterschiedlicher Laufzeit
  // vergleichbar werden.
  function computeRoi(totalPaid, finalWealth, totalWithdrawn, months) {
    if (!(totalPaid > 0)) return { growth: 0, roiPerYear: 0 };
    const totalReturnFactor = (finalWealth + totalWithdrawn) / totalPaid;
    const growth = (totalReturnFactor - 1) * 100;
    const roiPerYear = months > 0 ? (Math.pow(totalReturnFactor, 12 / months) - 1) * 100 : 0;
    return { growth, roiPerYear };
  }

  // Erster Monat, in dem die kumulierten Auszahlungen (netto) die
  // kumulierten Einzahlungen erreichen oder übersteigen: der Zeitpunkt, ab
  // dem man über die Auszahlungen bereits mehr zurückbekommen hat, als man
  // eingezahlt hat — unabhängig davon, wie viel Restkapital noch investiert
  // ist. null, wenn das innerhalb der Laufzeit nicht eintritt (z. B. ohne
  // aktive Auszahlungsstrategie).
  // initialPaid ist das Startkapital, FALLS es nicht bereits als eigenes
  // Einzahlungsereignis in rows steckt (siehe die "startCapital"-Variable in
  // simulate()/simulateNextForrest(): 0, wenn das Startkapital schon als
  // Zeile-0-Einzahlung gezählt wurde, sonst der volle Betrag) — sonst würde
  // reines "Startkapital + nur Auszahlungen, keine laufenden Einzahlungen"
  // (heute der Normalfall, da die Checkbox dafür entfernt wurde) nie ein
  // Break-even finden, obwohl real längst mehr zurückgezahlt wurde, als
  // ursprünglich eingesetzt wurde.
  function computeBreakEvenMonth(rows, initialPaid) {
    let cumulativeDeposit = Math.max(0, initialPaid || 0);
    let cumulativeWithdrawn = 0;
    for (const r of rows) {
      cumulativeDeposit += r.deposit || 0;
      cumulativeWithdrawn += r.withdrawn || 0;
      if (cumulativeDeposit > 0 && cumulativeWithdrawn >= cumulativeDeposit - 1e-9) {
        return r.month;
      }
    }
    return null;
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
      ...computeRoi(totalPaid, finalWealth, 0, settings.months),
      breakEvenMonth: computeBreakEvenMonth(rows, startCapital),
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

  // Startbedingung einer Strategie. 'month' (Vorgabe) verhält sich wie
  // bisher; 'capital' prüft das aktive Kapital, 'yield' die Rendite dieses
  // Monats INKLUSIVE der Boni. Das Gatter rastet ein: einmal offen, bleibt es
  // offen — beendet wird eine Strategie ausschließlich über ihre
  // Stopp-Bedingung. Sonst ginge sie bei schwankender Rendite oder nach einer
  // Auszahlung wieder aus, und "Start" wäre kein Ereignis mehr, sondern ein
  // Dauerzustand.
  function strategyStarted(strategy, state, monthIndex, interestThisMonth, activeCapital, totalBonus) {
    if (state && state.started) return true;
    const mode = strategy.startMode || 'month';
    const schwelle = Math.max(0, num(strategy.startThreshold));
    let offen;
    if (mode === 'capital') {
      offen = activeCapital >= schwelle - 1e-9;
    } else if (mode === 'yield') {
      offen = interestThisMonth + (totalBonus || 0) >= schwelle - 1e-9;
    } else {
      offen = monthIndex >= strategy.startMonth;
    }
    if (offen && state && !state.started) {
      state.started = true;
      state.startedAt = monthIndex;
    }
    return offen;
  }

  // Bezugsmonat für 'once' und 'yearly'. Bei einer Schwelle als Startbedingung
  // hat `startMonth` keine Bedeutung mehr — dann zählt der Monat, in dem das
  // Gatter tatsächlich aufging.
  function strategyAnchorMonth(strategy, state) {
    if (state && state.startedAt != null) return state.startedAt;
    return strategy.startMonth;
  }

  function strategyPeriodicAmount(strategy, monthIndex, anchorMonth) {
    const amount = Math.max(0, num(strategy.amount));
    const anker = anchorMonth != null ? anchorMonth : strategy.startMonth;
    if (strategy.type === 'once') {
      return monthIndex === anker ? amount : 0;
    }
    if (strategy.type === 'monthly') return amount;
    if (strategy.type === 'yearly') {
      return (monthIndex - anker) % 12 === 0 ? amount : 0;
    }
    return 0; // 'percentage'/'cashSurplus' werden separat behandelt
  }

  // Betrag einer Einzahlungsstrategie vom Typ 'fixed' für diesen Monat
  // (kind 'roundup' hat keinen festen Betrag/Periode — siehe Sweep-Schritt).
  function fixedDepositAmount(strategy, monthIndex, anchorMonth) {
    const amount = Math.max(0, num(strategy.amount));
    const anker = anchorMonth != null ? anchorMonth : strategy.startMonth;
    if (strategy.period === 'once') {
      return monthIndex === anker ? amount : 0;
    }
    if (strategy.period === 'yearly') {
      return (monthIndex - anker) % 12 === 0 ? amount : 0;
    }
    return amount; // 'monthly' (Default)
  }

  // Einzahlungs-Strategien stoppen dauerhaft, sobald ihre Schwelle erreicht
  // ist (state.stopped bleibt danach für die restliche Laufzeit gesetzt) —
  // genau wie das bisherige einzelne Sparziel. Gilt für beide Arten (fest
  // wie Roundup) gleichermaßen; nur 'once' (nur bei kind 'fixed' möglich)
  // ignoriert Enddatum/Schwelle, da es ohnehin nur einen Monat betrifft.
  function depositStrategyActive(strategy, state, monthIndex, interestThisMonth, activeCapital, totalBonus) {
    if (state.stopped) return false;
    if (!strategyStarted(strategy, state, monthIndex, interestThisMonth, activeCapital, totalBonus)) return false;
    if (strategy.period === 'once') return monthIndex === strategyAnchorMonth(strategy, state);
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
  // eine Auszahlung kann also pausieren und später wieder einsetzen. Die
  // Ausnahme ist stopMode 'total': dort wird derselbe thresholdValue als
  // kumulativer Zielbetrag interpretiert (state.paidTotal, siehe unten) und
  // der Stopp ist wie beim Einzahlungs-Schwellenwert dauerhaft, sobald der
  // Zielbetrag erreicht ist.
  function withdrawalStrategyActive(strategy, state, monthIndex, interestThisMonth, activeCapital, totalBonus) {
    if (state && state.stopped) return false;
    if (!strategyStarted(strategy, state, monthIndex, interestThisMonth, activeCapital, totalBonus)) return false;
    if (strategy.type === 'once') return monthIndex === strategyAnchorMonth(strategy, state);
    if (strategy.stopMode === 'date' && strategy.endMonth != null) {
      return monthIndex <= strategy.endMonth;
    }
    if (strategy.stopMode === 'threshold' && strategy.thresholdValue > 0) {
      const basisValue = strategy.thresholdBasis === 'interest' ? interestThisMonth : activeCapital;
      return basisValue >= strategy.thresholdValue - 1e-9;
    }
    if (strategy.stopMode === 'total' && strategy.thresholdValue > 0) {
      return !state || state.paidTotal < strategy.thresholdValue - 1e-9;
    }
    return true;
  }

  // Kappt den für diesen Monat vorgesehenen Bruttobetrag einer Strategie mit
  // stopMode 'total' so, dass der NETTO-Betrag (nach der 3,5%-
  // Auszahlungsgebühr — das, was tatsächlich beim Empfänger ankommt) in
  // Summe nie über den Zielbetrag hinausschießt. state.paidTotal führt
  // daher die kumulierte NETTO-Summe fort, nicht die angeforderte
  // Bruttosumme. Muss mit dem Bruttobetrag aufgerufen werden, der für diese
  // Strategie in diesem Monat TATSÄCHLICH angesetzt wird (vor Cash-Clamping
  // durch applyWithdrawal).
  function capToWithdrawalTarget(strategy, state, grossAmount) {
    if (strategy.stopMode !== 'total' || !(strategy.thresholdValue > 0) || !state) return grossAmount;
    const remainingNet = Math.max(0, strategy.thresholdValue - state.paidTotal);
    if (remainingNet <= 1e-9) {
      state.stopped = true;
      return 0;
    }
    const netIfFull = grossAmount * (1 - NF_WITHDRAWAL_FEE_PCT);
    if (netIfFull <= remainingNet + 1e-9) {
      state.paidTotal += netIfFull;
      if (state.paidTotal >= strategy.thresholdValue - 1e-9) state.stopped = true;
      return grossAmount;
    }
    // Letzte Rate: Bruttobetrag so kappen, dass nach Gebührenabzug exakt der
    // fehlende Netto-Restbetrag übrig bleibt.
    state.paidTotal = strategy.thresholdValue;
    state.stopped = true;
    return remainingNet / (1 - NF_WITHDRAWAL_FEE_PCT);
  }

  function withdrawalStrategyAmount(strategy, monthIndex, interestThisMonth, totalBonus, anchorMonth) {
    if (strategy.type === 'percentage') {
      const pct = Math.max(0, num(strategy.amount)) / 100;
      return (interestThisMonth + totalBonus) * pct;
    }
    if (strategy.type === 'cashSurplus') return 0; // separat, nach den Einzahlungen
    return strategyPeriodicAmount(strategy, monthIndex, anchorMonth);
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
    if (Array.isArray(out.nfTeamMembers)) {
      const tree = migrateTeamMembersToTree(out.nfTeamMembers);
      // Nur setzen, nie zurücksetzen: beim zweiten Laden ist das Szenario
      // bereits ein Baum, tree.migrated also false. Ein bedingungsloses
      // Zuweisen hätte den Hinweis nach einem Neuladen dauerhaft gelöscht —
      // gleichgültig, ob der Nutzer ihn je gesehen hat. Gelöscht wird das
      // Flag ausschließlich von markTeamStructureTouched(), also durch eine
      // echte Handlung des Nutzers an der Struktur.
      if (tree.migrated) out.nfTeamTreeMigrated = true;
      out.nfTeamMembers = tree.members;
      walkTeam(out.nfTeamMembers, (m, depth, parent) => {
        const migratedMember = migrateTeamMemberStrategies(m);
        // Object.assign kopiert nur vorhandene Schlüssel, löscht aber keine
        // fehlenden — die von migrateTeamMemberStrategies() bereits entfernten
        // alten flachen Felder (nfDepositStrategy, monthlyDeposit, ...) blieben
        // sonst auf m stehen. Deshalb hier explizit nachräumen.
        Object.keys(m).forEach((key) => {
          if (!(key in migratedMember)) delete m[key];
        });
        Object.assign(m, migratedMember);
        if (!Array.isArray(m.children)) m.children = [];
      });
    }
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
    const depositState = depositStrategies.map(() => ({ stopped: false, started: false, startedAt: null }));
    const withdrawalStrategies = Array.isArray(v.nfWithdrawalStrategies) ? v.nfWithdrawalStrategies : [];
    const withdrawalState = withdrawalStrategies.map(() => ({ stopped: false, paidTotal: 0, started: false, startedAt: null }));

    // Kapitalertragsteuer: nur auf den Zins, nicht auf Team-Boni (§ 20 EStG
    // erfasst Kapitalerträge, keine Provisionen). Kein Sparer-Pauschbetrag —
    // der volle Jahreszins wird versteuert. Jedes Team-Mitglied bekommt seine
    // eigene, unabhängige Einstellung (siehe simulateTeamMember()).
    const taxEnabled = !!v.taxEnabled;
    const taxRate = Math.max(0, v.taxRate != null ? num(v.taxRate) : TAX_RATE_DEFAULT) / 100;
    // Steht die Steuerschuld tatsächlich aus dem Investment (Rendite, notfalls
    // aktives Kapital) ab, oder wird sie nur ausgewiesen, weil sie aus
    // externen Mitteln (Gehalt, Rücklage) beglichen wird? Default true erhält
    // das bisherige Verhalten unverändert.
    const taxPayout = v.taxPayout !== false;
    let yearInterestAccrued = 0;
    let totalTax = 0;
    // Anteil der Steuer, der nicht aus der Rendite (vorhandenem Cash) gedeckt
    // war und deshalb per Block-Entnahme aus dem aktiven Kapital kam — bleibt
    // absichtlich getrennt von `totalWithdrawn`: verließe er die Anlage über
    // dieselbe Variable wie eine echte Auszahlung, würde er Gesamtrendite,
    // Rendite p.a. und den Break-even-Monat verfälschen, obwohl das Geld ans
    // Finanzamt ging statt in die Tasche des Anlegers. Für die Anzeige in der
    // „Auszahlung“-Spalte addiert die UI ihn separat hinzu (siehe index.html).
    let totalTaxFromCapital = 0;

    // Team-/Empfehlungsstruktur: jedes Teammitglied läuft als eigene,
    // unabhängige simulateNextForrest()-Instanz ab seinem Beitrittsmonat.
    // Deren Ergebnisse fließen als Bonus-Cashflow direkt in das eigene
    // Cash-Konto dieser Simulation ein (siehe Schritt 0 unten) — Boni sind
    // also kein separates Nebenergebnis, sondern Teil von cash/activeCapital.
    const teamMembersRaw = Array.isArray(v.nfTeamMembers)
      ? v.nfTeamMembers
      : [];
    // nfTeamDepth kommt aus simulateTeamMember(); im Hauptszenario ist es
    // undefined und die Direkten liegen auf Tiefe 1.
    const ownDepth = Math.max(1, Math.round(num(v.nfTeamDepth) || 1));
    const teamSimulated = teamMembersRaw.length
      ? teamMembersRaw
          .map((m) => simulateTeamMember(v, m, ownDepth))
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
        tax: 0,
        taxFromCapital: 0,
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
      yearInterestAccrued += interest;

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
          // Jeder Eintrag in teamSimulated ist eine eigene Direkte — die
          // Ebene ergibt sich aus dem Baum, nicht aus einem Feld.
          levelActive[1] = (levelActive[1] || 0) + active;
          teamVolume += active;

          // Ebenen 2 und 3 sind die Ebenen 1 und 2 dieses Mitglieds. Das
          // Team-Volumen zählt seinen gesamten Unterbau mit, auch Ebene 4+.
          const childTeamRow = teamRowAt(sim, m);
          if (childTeamRow) {
            levelActive[2] = (levelActive[2] || 0) + childTeamRow.e1Active;
            levelActive[3] = (levelActive[3] || 0) + childTeamRow.e2Active;
            teamVolume += childTeamRow.teamVolume;
          }

          // Tippgeber-Bonus: 50 € pro 1000er-Block, den eine eigene Direkte
          // ins aktive Kapital sweept — rangunabhängig. Die frühere
          // level === 1-Prüfung entfällt, weil hier nur noch Direkte stehen.
          let memberBonus = 0;
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

          if (m >= sim.joinMonth) {
            // Jedes Mitglied und sein gesamter Unterbau kommen in die
            // Monatsansicht — je mit eigener Ebene und eigenem Rang.
            monthMembers.push({
              id: sim.member.id,
              name: sim.member.name || '',
              level: 1,
              joinMonth: sim.joinMonth,
              // Achtung, zwei Zeitachsen in einem Objekt: `joinMonth` ist ein
              // Kalendermonat, `row.month` dagegen der lokale Monatszähler des
              // Mitglieds (memberMonthSnapshot() liefert dessen eigene Zeile).
              // Das bleibt bewusst so — `row.month` wird nirgends angezeigt,
              // die Tabelle gruppiert ohnehin nach dem äußeren Kalendermonat.
              row: memberMonthSnapshot(sim, m),
              tippgeberBonus: memberBonus,
              ownRankIndex: childTeamRow ? childTeamRow.rankIndex : 0,
              // Reine Anzeigewerte, sie gehen in keine Rechnung ein:
              // `ownTotalBonus` ist der Bonus, den dieses Mitglied in diesem
              // Monat aus SEINEM eigenen Unterbau verdient (sein
              // Tippgeber-, Eigen- und Level-Bonus zusammen) — das
              // Gegenstück zu `tippgeberBonus`, der zeigt, was es SEINEM
              // Werbenden eingebracht hat. `activeBase` ist exakt das
              // aktive Kapital, mit dem die Ebenen-Boni und das
              // Team-Volumen rechnen (Stand zu Monatsbeginn), damit die
              // Zwischensumme je Ebene in der Tabelle mit e1Active/
              // e2Active/e3Active und den daraus gezahlten Boni aufgeht.
              ownTotalBonus: childTeamRow ? childTeamRow.totalBonus : 0,
              activeBase: active,
            });
            if (childTeamRow) {
              childTeamRow.members.forEach((sub) => {
                // Die Einträge aus dem Unterbaum stehen in der Zeitachse
                // dieses Mitglieds. Für die Tabelle müssen sie wieder in
                // Kalendermonate zurückgerechnet werden — sonst zeigt die
                // Monatsansicht für tiefere Ebenen zu frühe Beitritte an.
                //
                // `tippgeberBonus` behält dabei bewusst seinen Wert, wechselt
                // aber die Bedeutung: es ist der Betrag, den dieses Mitglied
                // SEINEM Werbenden eingebracht hat — auf Ebene 1 bin das ich,
                // ab Ebene 2 ist es das Mitglied eine Ebene darüber. Die
                // Spalte summiert sich über alle Ebenen deshalb NICHT auf den
                // `tippgeberBonus` des Monats: dort steht nur, was bei mir
                // ankommt. Wer sie als meinen Anteil liest, zählt fremdes
                // Geld mit; für eine Gesamtansicht darf nur Ebene 1 addiert
                // werden. Der Wert bleibt erhalten, weil die Detailansicht
                // später zeigen soll, was jedes Mitglied selbst verdient.
                monthMembers.push({
                  ...sub,
                  level: sub.level + 1,
                  joinMonth: sub.joinMonth + sim.joinMonth - 1,
                });
              });
            }
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
          deepActive: Math.max(
            0,
            teamVolume -
              (levelActive[1] || 0) - (levelActive[2] || 0) - (levelActive[3] || 0)
          ),
          tippgeberBonus,
          ownBonus,
          e1Bonus,
          e2Bonus,
          e3Bonus,
          totalBonus,
          members: monthMembers,
        });
      }

      // 0b) Jährliche Steuerabrechnung auf den bis hierhin aufgelaufenen
      // Zins: alle 12 Monate sowie, falls die Laufzeit dazwischen endet,
      // einmalig als Restabrechnung im letzten Monat — sonst bliebe ein
      // angebrochenes Jahr unversteuert. Bei taxPayout wird die Steuer
      // tatsächlich beglichen (aus Cash, notfalls per Block-Entnahme aus dem
      // aktiven Kapital, wie bei einer Auszahlung) — sonst wird sie nur in
      // `tax`/`totalTax` ausgewiesen, weil sie aus externen Mitteln bezahlt
      // wird und Cash/aktives Kapital unberührt bleiben.
      let taxThisMonth = 0;
      let taxFromCapitalThisMonth = 0;
      if (taxEnabled && (m % 12 === 0 || (m === months && yearInterestAccrued > 1e-9))) {
        const steuer = yearInterestAccrued * taxRate;
        if (steuer > 1e-9) {
          if (taxPayout) {
            // Deckt die Rendite (vorhandenes Cash) die Steuer nicht, muss der
            // Rest aus dem aktiven Kapital geholt werden — das ist eine
            // Entnahme wie jede andere Auszahlung und trägt deshalb dieselbe
            // 3,5%-Auszahlungsgebühr. Hochgerechnet auf den Bruttobetrag, der
            // NETTO genau die Deckungslücke schließt (dieselbe Logik wie
            // capToWithdrawalTarget() für ein Netto-Ziel).
            const shortfallNet = Math.max(0, steuer - cash);
            if (shortfallNet > 1e-9) {
              const grossNeeded = shortfallNet / (1 - NF_WITHDRAWAL_FEE_PCT);
              const blocksNeeded = Math.ceil((grossNeeded - 1e-9) / NF_BLOCK) * NF_BLOCK;
              const blocksAvailable = Math.floor((activeCapital + 1e-9) / NF_BLOCK) * NF_BLOCK;
              const pulled = Math.min(blocksNeeded, blocksAvailable);
              if (pulled > 0) {
                activeCapital -= pulled;
                cash += pulled;
                const grossFromCapital = Math.min(pulled, grossNeeded);
                const feeFromCapital = grossFromCapital * NF_WITHDRAWAL_FEE_PCT;
                cash -= feeFromCapital;
                feeThisMonth += feeFromCapital;
                totalWithdrawalFees += feeFromCapital;
                taxFromCapitalThisMonth = grossFromCapital - feeFromCapital;
              }
            }
            taxThisMonth = Math.min(steuer, Math.max(0, cash));
            cash -= taxThisMonth;
          } else {
            taxThisMonth = steuer;
          }
          totalTax += taxThisMonth;
          totalTaxFromCapital += taxFromCapitalThisMonth;
        }
        yearInterestAccrued = 0;
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
      withdrawalStrategies.forEach((s, i) => {
        if (s.type === 'cashSurplus') return;
        const state = withdrawalState[i];
        if (!withdrawalStrategyActive(s, state, m, interest, activeCapital, totalBonus)) return;
        const amount = capToWithdrawalTarget(s, state, withdrawalStrategyAmount(s, m, interest, totalBonus, strategyAnchorMonth(s, state)));
        preDepositWithdrawalGross += amount;
      });
      if (preDepositWithdrawalGross > 0) {
        // Reicht das laufende Cash (Zins/Boni dieses Monats) nicht aus,
        // werden zusätzliche volle 1000er-Blöcke aus dem aktiven Kapital
        // ins Cash-Konto zurückgeholt — begrenzt durch das tatsächlich
        // vorhandene aktive Kapital. 'cashSurplus' bleibt davon unberührt,
        // da sie per Definition nur den Sweep-Rest abgreift (Schritt 2b).
        const shortfall = preDepositWithdrawalGross - cash;
        if (shortfall > 1e-9) {
          const blocksNeeded = Math.ceil((shortfall - 1e-9) / NF_BLOCK) * NF_BLOCK;
          const blocksAvailable = Math.floor((activeCapital + 1e-9) / NF_BLOCK) * NF_BLOCK;
          const pulled = Math.min(blocksNeeded, blocksAvailable);
          if (pulled > 0) {
            activeCapital -= pulled;
            cash += pulled;
          }
        }
        applyWithdrawal(preDepositWithdrawalGross);
      }

      // 2) Deposits — each strategy sums independently (own start/end
      // month and, if stopMode is 'threshold', its own permanent stop once
      // its goal is reached). 'fixed' strategies run first (they add a
      // known amount to Cash); 'roundup' strategies run afterwards, each
      // topping Cash up to the next 1000er block — so a Roundup strategy
      // active in the same month as a fixed one tops up the combined total,
      // exactly like the historical single-strategy behavior did.
      depositStrategies.forEach((s, i) => {
        if (s.kind === 'roundup') return;
        if (!depositStrategyActive(s, depositState[i], m, interest, activeCapital, totalBonus)) return;
        const amount = fixedDepositAmount(s, m, strategyAnchorMonth(s, depositState[i]));
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
        if (!depositStrategyActive(s, depositState[i], m, interest, activeCapital, totalBonus)) return;
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
      // second one to skim); if one of them has stopMode 'total', the shared
      // remainder is capped to whatever that strategy still has left, and
      // every active cashSurplus strategy's own paidTotal is advanced by the
      // amount actually paid (each tracks its own target independently, even
      // though they share the same underlying cash).
      const activeCashSurplus = withdrawalStrategies
        .map((s, i) => ({ s, state: withdrawalState[i] }))
        .filter(({ s, state }) => s.type === 'cashSurplus' && withdrawalStrategyActive(s, state, m, interest, activeCapital, totalBonus));
      if (activeCashSurplus.length) {
        let blockRemainder = Math.max(0, cash - Math.floor((cash + 1e-9) / NF_BLOCK) * NF_BLOCK);
        activeCashSurplus.forEach(({ s, state }) => {
          blockRemainder = capToWithdrawalTarget(s, state, blockRemainder);
        });
        applyWithdrawal(blockRemainder);
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
        tax: taxThisMonth,
        taxFromCapital: taxFromCapitalThisMonth,
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
      totalTax,
      totalTaxFromCapital,
      finalWealth,
      ...computeRoi(totalPaid, finalWealth, totalWithdrawn, months),
      breakEvenMonth: computeBreakEvenMonth(rows, startCapital),
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

  // Tiefe 0 = Hauptszenario, Tiefe 1 = die eigenen Direkten. Die Grenze
  // begrenzt die Rekursionstiefe und die Einrückung in der Oberfläche.
  const MAX_TEAM_DEPTH = 20;

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

  // Die Ebene eines Mitglieds ist seine Tiefe im Baum, nicht mehr ein
  // getipptes Feld. `depth` zählt ab 1 für die eigenen Direkten; das
  // Hauptszenario selbst ist Tiefe 0 und taucht hier nicht auf.
  function walkTeam(members, cb, depth, parent) {
    if (!Array.isArray(members)) return;
    const d = depth || 1;
    for (const m of members) {
      // Leere Einträge (null aus beschädigten gespeicherten Daten) sind keine
      // Mitglieder — überspringen, statt jeden Aufrufer werfen zu lassen.
      if (!m) continue;
      cb(m, d, parent || null);
      if (Array.isArray(m.children) && m.children.length) {
        walkTeam(m.children, cb, d + 1, m);
      }
    }
  }

  // Niemand tritt vor seinem Werbenden bei. Wird nach jeder Strukturänderung
  // und beim Laden gespeicherter Szenarien angewendet.
  function clampTeamJoinMonths(members) {
    walkTeam(members, (m, depth, parent) => {
      const min = parent ? Math.max(1, Math.round(num(parent.joinMonth) || 1)) : 1;
      const own = Math.round(num(m.joinMonth) || 1);
      m.joinMonth = Math.max(min, own, 1);
    });
    return members;
  }

  // Alte Szenarien speichern eine flache Liste mit getippter Ebene. Wer wen
  // geworben hat, steht dort nicht — die Zuordnung ist deshalb eine Annahme:
  // jeder Eintrag hängt sich an den zuletzt gesehenen Eintrag der Ebene
  // darüber. Das Ergebnis meldet über `migrated`, ob geraten wurde, damit
  // die Oberfläche einen Hinweis zeigen kann.
  function migrateTeamMembersToTree(list) {
    if (!Array.isArray(list)) return { members: [], migrated: false };
    // Ein null-Eintrag in einer gespeicherten Altliste ist kein Mitglied,
    // sondern Datenschrott. Vor der Baumumstellung überlebte er, weil die
    // Migration jeden Eintrag über `{...raw}` kopierte ({...null} ergibt {});
    // seither würde `raw.level` daran werfen und beim Laden die ganze Seite
    // mitreißen. Deshalb hier still aussortieren statt werfen.
    list = list.filter(Boolean);
    const alreadyTree = list.every((m) => m.level === undefined);
    if (alreadyTree) {
      list.forEach((m) => { if (!Array.isArray(m.children)) m.children = []; });
      clampTeamJoinMonths(list);
      return { members: list, migrated: false };
    }

    const roots = [];
    const lastAtLevel = {};
    let guessed = false;

    for (const raw of list) {
      const level = Math.max(1, Math.round(num(raw.level) || 1));
      const node = { ...raw, children: [] };
      delete node.level;

      const parent = level > 1 ? lastAtLevel[level - 1] : null;
      if (level > 1) guessed = true;
      if (parent) parent.children.push(node);
      else roots.push(node);

      lastAtLevel[level] = node;
      // Tiefere Merker verfallen, sobald eine höhere Ebene neu gesetzt wird.
      Object.keys(lastAtLevel).forEach((k) => {
        if (Number(k) > level) delete lastAtLevel[k];
      });
    }

    clampTeamJoinMonths(roots);
    return { members: roots, migrated: guessed };
  }

  // Der gesamte Unterbaum wird mit demselben Versatz umgerechnet, nicht nur
  // die direkten Kinder: sonst trägt ein Enkel weiterhin seinen Kalender-
  // monat, während sein Elternteil bereits auf die lokale Achse umgestellt
  // wurde — beim nächsten Rekursionsschritt würde ein kalendarischer Wert
  // von einem lokalen abgezogen. So gilt auf jeder Ebene dieselbe Regel:
  // die Kinder eines Knotens sprechen dieselbe Zeitachse wie der Knoten.
  function rebaseSubtree(node, offset) {
    return {
      ...node,
      joinMonth: Math.max(1, Math.round(num(node.joinMonth) || 1) - offset + 1),
      children: Array.isArray(node.children)
        ? node.children.map((c) => rebaseSubtree(c, offset))
        : [],
    };
  }

  function simulateTeamMember(v, member, depth) {
    const level = depth || 1;
    if (level > MAX_TEAM_DEPTH) return null;
    const totalMonths = monthsCountFor(v);
    const joinMonth = Math.max(
      1,
      Math.round(num(member.joinMonth) || 1),
    );
    const memberMonths = totalMonths - joinMonth + 1;
    if (memberMonths <= 0) return null;

    // Eigene Szenario-Eigenschaften pro Mitglied, inkl. eigener
    // Mehrfach-Ein-/Auszahlungsstrategien (genau wie im Hauptszenario).
    // Ein Mitglied mit bereits migrierten Arrays (neu angelegt oder via
    // migrateScenarioValues() migriert) nutzt diese direkt; ein Mitglied
    // mit den alten flachen Feldern (z. B. in bestehenden Tests) wird hier
    // on-the-fly mit denselben Migrations-Hilfsfunktionen umgewandelt wie
    // gespeicherte Szenarien — Rendite fällt ohne eigene Angabe weiterhin
    // aufs Hauptszenario zurück, für die Einzahlungsart gibt es (wie beim
    // Hauptszenario selbst) keinen einzelnen vererbbaren Wert mehr.
    const depositStrategies = Array.isArray(member.nfDepositStrategies)
      ? member.nfDepositStrategies
      : toDepositStrategiesMigration({
          nfDepositStrategy: member.nfDepositStrategy || 'fixed',
          nfMonthlyDeposit: num(member.monthlyDeposit),
          nfMonthlyDepositPeriod: member.nfMonthlyDepositPeriod || 'monthly',
          nfDepositGoal: Math.max(0, num(member.nfDepositGoal)),
          nfDepositGoalThresholdBasis: member.nfDepositGoalThresholdBasis || 'interest',
        });
    const withdrawalStrategies = Array.isArray(member.nfWithdrawalStrategies)
      ? member.nfWithdrawalStrategies
      : toWithdrawalStrategiesMigration({
          nfWithdrawalStrategy: member.nfWithdrawalStrategy || 'fixed',
          nfWithdrawalAmount: Math.max(0, num(member.nfWithdrawalAmount)),
          nfWithdrawalPeriod: member.nfWithdrawalPeriod || 'monthly',
          nfWithdrawalMinCapital: Math.max(0, num(member.nfWithdrawalMinCapital)),
          nfWithdrawalThresholdBasis: member.nfWithdrawalThresholdBasis || 'interest',
        });

    // Die eigenen Geworbenen laufen als Sub-Simulation dieses Mitglieds —
    // dadurch verdient es selbst Tippgeber-, Eigen- und Level-Boni, und
    // diese Boni wachsen in seinem Kapital, das wiederum ins Team-Volumen
    // seines Werbenden zählt.
    //
    // Die Zeitachse muss dabei umgerechnet werden: die Simulation dieses
    // Mitglieds beginnt bei seinem eigenen Monat 1 (= Kalendermonat
    // `joinMonth`), die Beitrittsmonate der Kinder sind aber Kalendermonate.
    const childMembers = Array.isArray(member.children)
      ? member.children.map((child) => rebaseSubtree(child, joinMonth))
      : [];

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
      nfDepositStrategies: depositStrategies,
      nfWithdrawalStrategies: withdrawalStrategies,
      nfTeamMembers: childMembers,
      nfTeamDepth: level + 1,
      // Keine Vererbung: jedes Mitglied trägt seine eigene, unabhängige
      // Steuer-Konstellation — Default ist deaktiviert, nicht die des
      // Hauptszenarios.
      taxEnabled: !!member.taxEnabled,
      taxRate: member.taxRate != null ? member.taxRate : TAX_RATE_DEFAULT,
      taxPayout: member.taxPayout !== false,
    });

    return { member, joinMonth, result, depth: level };
  }

  // Migriert die alten flachen Einzahlungs-/Auszahlungsfelder eines
  // Team-Mitglieds (aus gespeicherten Szenarien) in dieselben Array-Felder,
  // die simulateTeamMember() bevorzugt. Wird nur beim Laden aufgerufen —
  // simulateTeamMember() selbst migriert flache Felder weiterhin
  // on-the-fly, damit auch nicht migrierte Aufrufe (z. B. in Tests) exakt
  // gleich rechnen.
  function migrateTeamMemberStrategies(member) {
    const out = { ...member };
    if (!Array.isArray(out.nfDepositStrategies)) {
      out.nfDepositStrategies = toDepositStrategiesMigration({
        nfDepositStrategy: out.nfDepositStrategy || 'fixed',
        nfMonthlyDeposit: num(out.monthlyDeposit),
        nfMonthlyDepositPeriod: out.nfMonthlyDepositPeriod || 'monthly',
        nfDepositGoal: Math.max(0, num(out.nfDepositGoal)),
        nfDepositGoalThresholdBasis: out.nfDepositGoalThresholdBasis || 'interest',
      });
      delete out.nfDepositStrategy;
      delete out.monthlyDeposit;
      delete out.nfMonthlyDepositPeriod;
      delete out.nfDepositGoal;
      delete out.nfDepositGoalThresholdBasis;
    }
    if (!Array.isArray(out.nfWithdrawalStrategies)) {
      out.nfWithdrawalStrategies = toWithdrawalStrategiesMigration({
        nfWithdrawalStrategy: out.nfWithdrawalStrategy || 'fixed',
        nfWithdrawalAmount: Math.max(0, num(out.nfWithdrawalAmount)),
        nfWithdrawalPeriod: out.nfWithdrawalPeriod || 'monthly',
        nfWithdrawalMinCapital: Math.max(0, num(out.nfWithdrawalMinCapital)),
        nfWithdrawalThresholdBasis: out.nfWithdrawalThresholdBasis || 'interest',
      });
      delete out.nfWithdrawalStrategy;
      delete out.nfWithdrawalAmount;
      delete out.nfWithdrawalPeriod;
      delete out.nfWithdrawalMinCapital;
      delete out.nfWithdrawalThresholdBasis;
    }
    return out;
  }

  // Die Team-Bonuszeile eines Mitglieds für einen Kalendermonat. Anders als
  // localRow() greift sie auf result.team.rows zu — das ist die Sicht des
  // Mitglieds auf SEINE Downline, aus der der Elternteil seine Ebenen 2 und 3
  // ableitet.
  function teamRowAt(sim, month) {
    if (!sim.result.team) return null;
    const localMonth = month - sim.joinMonth + 1;
    if (localMonth < 1) return null;
    return sim.result.team.rows.find((r) => r.month === localMonth) || null;
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
      tax: (row0.tax || 0) + (localRowM.tax || 0),
      taxFromCapital: (row0.taxFromCapital || 0) + (localRowM.taxFromCapital || 0),
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

  // ---------------------------------------------------------------------
  // "Mit meinem Investment zusammenrechnen": reine Funktionen von
  // (values, result). Sie standen früher inline in index.html und waren
  // damit von keinem Test erreichbar — sie brauchen aber kein DOM, nur
  // walkTeam/monthsCountFor/computeRoi/num aus dieser Datei. Deshalb leben
  // sie hier; index.html holt sie sich über das Export-Objekt.
  // ---------------------------------------------------------------------
  const MERGE_ROW_FIELDS = ['openingActive', 'deposit', 'withdrawn', 'interest', 'reinvested', 'cash', 'fee', 'tax', 'taxFromCapital', 'active', 'total'];

  // Team-Mitglieder von `values`, deren "Mit meinem Investment
  // zusammenrechnen"-Checkbox aktiv ist — nur relevant, wenn dieser Lauf
  // überhaupt Team-Daten erzeugt hat (NextForrest + result.team vorhanden).
  // Klassische Szenarien oder ein result ohne team liefern sofort [] — das
  // ist der zentrale No-Op-Guard für die komplette Merge-Funktion.
  // Bewusst über den GANZEN Baum: die Checkbox steht in der Eingabemaske
  // jedes Mitglieds, nicht nur bei den eigenen Direkten. Solange hier nur
  // die Wurzelliste gefiltert wurde, blieb sie ab Ebene 2 wirkungslos —
  // seit der Umstellung auf den Baum steht in `nfTeamMembers` nur noch die
  // erste Ebene, der Rest hängt in `children`.
  function mergedTeamMembers(values, result) {
    if (!result || !result.team) return [];
    const members = Array.isArray(values.nfTeamMembers) ? values.nfTeamMembers : [];
    const merged = [];
    walkTeam(members, (m) => { if (m.mergeWithOwn) merged.push(m); });
    return merged;
  }

  // Ein Kalendermonat: eigene Zeile + die Zeilen der zusammengerechneten
  // Mitglieder, feldweise summiert (identisches Zeilenformat auf beiden
  // Seiten, siehe memberMonthSnapshot() weiter oben). `own` und `members`
  // bleiben für die aufklappbare Detailansicht im Monatsverlauf erhalten.
  function combineMonthRow(month, ownRow, memberEntries) {
    const own = ownRow || { month, openingActive: 0, deposit: 0, withdrawn: 0, interest: 0, reinvested: 0, cash: 0, fee: 0, tax: 0, taxFromCapital: 0, active: 0, total: 0 };
    const combined = { ...own };
    memberEntries.forEach(({ row }) => {
      MERGE_ROW_FIELDS.forEach(k => { combined[k] = (combined[k] || 0) + (row[k] || 0); });
    });
    return { month, own, members: memberEntries, combined };
  }

  // Kombinierte Monatsansicht für ein Szenario-Ergebnis, oder null, wenn für
  // dieses Szenario kein Mitglied zusammengerechnet wird (No-Op-Signal an
  // die Aufrufer — Diagramm und Monatsverlauf bleiben dann unverändert).
  // Monate vor dem Beitritt eines Mitglieds bzw. Monat 0 (kein
  // result.team.rows-Eintrag) tragen automatisch 0 bei, da das Mitglied dort
  // schlicht nicht in teamRow.members auftaucht (siehe die Monatsschleife
  // von simulateNextForrest()).
  function buildCombinedRows(values, result) {
    const merged = mergedTeamMembers(values, result);
    if (!merged.length) return null;

    const teamRowByMonth = new Map(result.team.rows.map(r => [r.month, r]));

    return result.rows.map(ownRow => {
      const teamRow = teamRowByMonth.get(ownRow.month);
      const memberEntries = merged
        .map(m => {
          const found = teamRow && teamRow.members.find(x => x.id === m.id);
          return found ? { id: m.id, name: found.name, level: found.level, row: found.row } : null;
        })
        .filter(Boolean);
      return combineMonthRow(ownRow.month, ownRow, memberEntries);
    });
  }

  // Kombinierte Gesamtsummen für die Szenario-Übersichtstabelle oben, wenn
  // Mitglieder zusammengerechnet werden — sonst null (No-Op-Signal, Tabelle
  // zeigt dann unverändert nur die eigenen Werte). Eigene Summen kommen
  // direkt von `result` (bereits korrekt von calc.js berechnet); pro
  // zusammengerechnetem Mitglied werden Zinsen/Gebühren/Auszahlungen/
  // Einzahlungen aus den bereits vorhandenen Monatszeilen aufsummiert.
  // `startActive` fängt den Sonderfall ab, dass ein Mitglied sein eigenes
  // Startkapital NICHT als Einzahlung zählt (dann taucht es nie in einer
  // deposit-Spalte auf, sondern nur als openingActive der ersten Zeile —
  // exakt wie result.startCapital das beim eigenen Szenario schon abbildet).
  function combinedScenarioTotals(result, combinedList, merged, values) {
    if (!combinedList || !merged.length) return null;

    let totalInterest = result.totalInterest;
    let totalFees = result.totalFees;
    let totalWithdrawn = result.totalWithdrawn;
    let totalDeposits = result.totalDeposits;
    let totalPaid = result.totalPaid;
    let totalTax = result.totalTax || 0;
    let totalTaxFromCapital = result.totalTaxFromCapital || 0;

    merged.forEach(m => {
      let startActive = 0;
      let seen = false;
      let memberDeposits = 0;
      let memberFees = 0;
      combinedList.forEach(({ members }) => {
        const entry = members.find(x => x.id === m.id);
        if (!entry) return;
        if (!seen) { startActive = entry.row.openingActive || 0; seen = true; }
        totalInterest += entry.row.interest || 0;
        totalFees += entry.row.fee || 0;
        totalTax += entry.row.tax || 0;
        totalTaxFromCapital += entry.row.taxFromCapital || 0;
        totalWithdrawn += entry.row.withdrawn || 0;
        totalDeposits += entry.row.deposit || 0;
        memberDeposits += entry.row.deposit || 0;
        memberFees += entry.row.fee || 0;
      });
      totalPaid += startActive + memberDeposits + memberFees;
    });

    const last = combinedList[combinedList.length - 1].combined;
    const finalWealth = last.total;
    const activeCapital = last.active;
    const cash = last.cash;
    const months = monthsCountFor(values);
    const { growth, roiPerYear } = computeRoi(totalPaid, finalWealth, totalWithdrawn, months);

    return { finalWealth, activeCapital, cash, totalInterest, totalDeposits, totalFees, totalWithdrawn, totalTax, totalTaxFromCapital, growth, roiPerYear };
  }

  return {
    NF_RATES,
    TAX_RATE_DEFAULT,
    NF_DEPOSIT_FEE_PCT,
    NF_WITHDRAWAL_FEE_PCT,
    NF_BLOCK,
    TEAM_BLOCK_BONUS,
    MAX_TEAM_DEPTH,
    RANKS,
    num,
    monthsCountFor,
    rateForCreditPeriod,
    interestDue,
    contributionThisMonth,
    getSettings,
    computeRoi,
    computeBreakEvenMonth,
    simulate,
    strategyStarted,
    strategyAnchorMonth,
    strategyPeriodicAmount,
    fixedDepositAmount,
    depositStrategyActive,
    withdrawalStrategyActive,
    withdrawalStrategyAmount,
    capToWithdrawalTarget,
    toDepositStrategiesMigration,
    toWithdrawalStrategiesMigration,
    migrateScenarioValues,
    simulateNextForrest,
    runSimulation,
    simulateTeamMember,
    teamRowAt,
    walkTeam,
    clampTeamJoinMonths,
    migrateTeamMembersToTree,
    mergedTeamMembers,
    buildCombinedRows,
    combinedScenarioTotals,
  };
});
