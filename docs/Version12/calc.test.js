const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  simulate,
  simulateNextForrest,
  runSimulation,
  simulateTeamMember,
  migrateScenarioValues,
  computeRoi,
  computeBreakEvenMonth,
  NF_RATES,
  walkTeam,
  clampTeamJoinMonths,
  MAX_TEAM_DEPTH,
  migrateTeamMembersToTree,
  mergedTeamMembers,
  buildCombinedRows,
  combinedScenarioTotals,
} = require('./calc.js');

const EPS = 0.01;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < EPS, msg || `expected ${a} ≈ ${b}`);

const sum = (rows, key) => rows.reduce((acc, r) => acc + (r[key] || 0), 0);

function baseClassic(overrides) {
  return {
    investmentType: 'classic',
    start: 10000,
    includeStartCapital: true,
    currency: 'EUR',
    rate: 5,
    duration: 24,
    durationUnit: 'months',
    contribution: 0,
    contributionPeriod: 'monthly',
    compound: 'monthly',
    ratePeriod: 'annual',
    reinvestThreshold: 0,
    depositTiming: 'end',
    reinvestMode: 'accumulating',
    ...overrides
  };
}

// Default: entspricht dem alten Default `nfDepositStrategy: 'roundup'` —
// eine Einzahlungsstrategie vom Typ Roundup, keine Auszahlungsstrategien.
function baseNextForrest(overrides) {
  return {
    investmentType: 'nextforrest',
    start: 10000,
    includeStartCapital: true,
    currency: 'EUR',
    duration: 24,
    durationUnit: 'months',
    nfRate: 'low',
    nfDepositStrategies: [depositStrategy({ kind: 'roundup' })],
    nfWithdrawalStrategies: [],
    ...overrides
  };
}

// kind: 'fixed' (fester Betrag, mit period 'monthly'/'yearly'/'once') oder
// 'roundup' (1000er-Aufrundung, amount/period irrelevant) — entspricht
// genau den zwei bisherigen Einzahlungsarten, jetzt mehrfach mit eigenem
// Start/Ende bzw. Schwelle (stopMode) pro Eintrag.
function depositStrategy(overrides) {
  return {
    id: 'd1',
    kind: 'fixed',
    amount: 0,
    period: 'monthly',
    startMonth: 1,
    endMonth: null,
    stopMode: 'none',
    thresholdBasis: 'interest',
    thresholdValue: 0,
    ...overrides
  };
}

function withdrawalStrategy(overrides) {
  return {
    id: 'w1',
    type: 'monthly',
    amount: 0,
    startMonth: 1,
    endMonth: null,
    stopMode: 'none',
    thresholdBasis: 'interest',
    thresholdValue: 0,
    ...overrides
  };
}

describe('Klassisch (simulate)', () => {
  test('default scenario: 10.000 € / 5% p.a. / 24 Monate / keine Einzahlung', () => {
    const r = simulate(baseClassic());
    close(r.finalWealth, 11025.00);
    close(r.totalInterest, 1025.00);
    close(r.totalDeposits, 10000); // enthält das Startkapital (als Einzahlung berücksichtigt)
  });

  test('checked vs. unchecked ergeben denselben Endwert (kein Fee, Threshold 0)', () => {
    const checked = simulate(baseClassic({ includeStartCapital: true }));
    const unchecked = simulate(baseClassic({ includeStartCapital: false }));
    close(checked.finalWealth, unchecked.finalWealth);
    close(checked.totalInterest, unchecked.totalInterest);
  });

  test('checked: Zeile 0 zeigt Startkapital als Einzahlung, sofort reinvestiert (Threshold 0)', () => {
    const r = simulate(baseClassic());
    assert.strictEqual(r.rows[0].month, 0);
    close(r.rows[0].deposit, 10000);
    close(r.rows[0].openingActive, 0);
    close(r.rows[0].active, 10000); // Klassisch hat keinen Reinvest-Threshold -> sofort aktiv
    close(r.rows[1].openingActive, 10000); // Monat 1 startet bereits mit dem reinvestierten Startkapital
  });

  test('unchecked: keine Zeile 0, Monat 1 startet direkt mit Startkapital', () => {
    const r = simulate(baseClassic({ includeStartCapital: false }));
    assert.strictEqual(r.rows[0].month, 1);
    close(r.rows[0].openingActive, 10000);
    close(r.rows[0].deposit, 0);
  });

  test('Einzahlungen inkl. Startkapital (checked) vs. exkl. (unchecked)', () => {
    const checked = simulate(baseClassic({ contribution: 100 }));
    const unchecked = simulate(baseClassic({ contribution: 100, includeStartCapital: false }));
    close(checked.totalDeposits, 10000 + 24 * 100); // 12.400
    close(unchecked.totalDeposits, 24 * 100); // 2.400
  });

  test('growth = (finalWealth / totalPaid - 1) * 100', () => {
    const r = simulate(baseClassic({ contribution: 100 }));
    close(r.growth, ((r.finalWealth / r.totalPaid) - 1) * 100);
  });

  test('roiPerYear: 24 Monate Laufzeit, 20% Gesamtrendite → ca. 9,54% p.a.', () => {
    const { growth, roiPerYear } = computeRoi(10000, 12000, 0, 24);
    close(growth, 20);
    close(roiPerYear, (Math.pow(1.2, 0.5) - 1) * 100);
  });

  test('computeBreakEvenMonth: findet den ersten Monat, in dem kumulierte Auszahlungen die kumulierten Einzahlungen erreichen', () => {
    const rows = [
      { month: 1, deposit: 1000, withdrawn: 0 },
      { month: 2, deposit: 1000, withdrawn: 500 },
      { month: 3, deposit: 0, withdrawn: 800 },
      { month: 4, deposit: 0, withdrawn: 800 },
    ];
    // Kumuliert: Einzahlung 1000/2000/2000/2000, Auszahlung 0/500/1300/2100
    // → in Monat 4 übersteigt die kumulierte Auszahlung (2100) erstmals die
    // kumulierte Einzahlung (2000).
    close(computeBreakEvenMonth(rows, 0), 4);
  });

  test('computeBreakEvenMonth: initialPaid (Startkapital, das nicht als Einzahlungszeile zählt) fließt mit ein', () => {
    const rows = [
      { month: 1, deposit: 0, withdrawn: 5000 },
      { month: 2, deposit: 0, withdrawn: 5000 },
      { month: 3, deposit: 0, withdrawn: 5000 },
    ];
    // Ohne initialPaid würde bereits Monat 1 als Break-even gelten (0
    // Einzahlung, aber schon Auszahlung > 0 wäre unsinnig) — mit einem
    // Startkapital von 10.000 als initialPaid erst, wenn die kumulierte
    // Auszahlung die 10.000 erreicht (Monat 2: 10.000).
    close(computeBreakEvenMonth(rows, 10000), 2);
  });

  test('computeBreakEvenMonth: null, wenn nie erreicht (z. B. ohne Auszahlungsstrategie)', () => {
    const rows = [
      { month: 1, deposit: 1000, withdrawn: 0 },
      { month: 2, deposit: 1000, withdrawn: 0 },
    ];
    assert.strictEqual(computeBreakEvenMonth(rows, 0), null);
  });
});

describe('NextForrest (simulateNextForrest)', () => {
  test('Golden scenario: 10.000 € Start, 5%/Monat, 1000er-Aufrundung, Sparziel 20.000, 24 Monate', () => {
    const r = simulateNextForrest(baseNextForrest({
      nfDepositStrategies: [depositStrategy({
        kind: 'roundup',
        stopMode: 'threshold',
        thresholdBasis: 'capital',
        thresholdValue: 20000,
      })],
    }));
    close(r.finalWealth, 39300.00);
    close(r.activeCapital, 39000.00);
    close(r.totalInterest, 26550.00);
    close(r.cash, 300.00);
    close(r.totalDeposits, 12750.00);
    close(r.totalFees, 191.25);
    close(r.totalWithdrawn, 0);
  });

  test('growth (Gesamtrendite) rechnet bereits erhaltene Auszahlungen mit ein, nicht nur das verbleibende Endvermögen', () => {
    const r = simulateNextForrest(baseNextForrest({
      start: 10000, includeStartCapital: false, nfRoundupEnabled: false, nfDepositStrategies: [],
      nfWithdrawalStrategies: [withdrawalStrategy({ type: 'monthly', amount: 200 })],
    }));
    // r.totalWithdrawn > 0 in diesem Szenario (siehe andere Tests) — ohne die
    // Korrektur (nur finalWealth / totalPaid) läge growth spürbar niedriger,
    // weil das bereits ausgezahlte Geld sonst wie ein Verlust wirken würde.
    assert.ok(r.totalWithdrawn > 0, 'Testaufbau sollte Auszahlungen erzeugen');
    close(r.growth, ((r.finalWealth + r.totalWithdrawn) / r.totalPaid - 1) * 100);
    const growthWithoutFix = (r.finalWealth / r.totalPaid - 1) * 100;
    assert.ok(r.growth > growthWithoutFix, 'korrigierte Rendite muss höher sein als die alte (Auszahlungen ignorierende) Formel');
  });

  test('breakEvenMonth: 10.000€ Startkapital, 500€/Monat Auszahlung ab Monat 1 → Break-even in Monat 21', () => {
    const r = simulateNextForrest(baseNextForrest({
      start: 10000, includeStartCapital: false, nfRoundupEnabled: false, nfDepositStrategies: [],
      nfWithdrawalStrategies: [withdrawalStrategy({ type: 'monthly', amount: 500 })],
    }));
    // 500€ × 96,5% Netto = 482,50€/Monat; 10.000 / 482,50 ≈ 20,7 → Monat 21
    // ist der erste Monat, in dem die kumulierte Netto-Auszahlung die
    // 10.000€ Startkapital erstmals erreicht/übersteigt.
    close(r.breakEvenMonth, 21);
  });

  test('breakEvenMonth: null ohne Auszahlungsstrategie', () => {
    const r = simulateNextForrest(baseNextForrest({ nfWithdrawalStrategies: [] }));
    assert.strictEqual(r.breakEvenMonth, null);
  });

  test('Zeile 0: Startkapital-Gebühr = 1,5% des Startkapitals', () => {
    const r = simulateNextForrest(baseNextForrest());
    assert.strictEqual(r.rows[0].month, 0);
    close(r.rows[0].deposit, 10000);
    close(r.rows[0].fee, 150.00);
  });

  test('unchecked: keine Zeile 0, kein Fee auf Startkapital', () => {
    const r = simulateNextForrest(baseNextForrest({ includeStartCapital: false }));
    assert.strictEqual(r.rows[0].month, 1);
    close(r.rows[0].openingActive, 10000);
    close(sum(r.rows, 'fee'), r.totalFees); // alle Gebühren stammen aus regulären Einzahlungen
  });

  test('Summe aller "Einzahlung"-Spalten (inkl. Zeile 0) = totalDeposits', () => {
    const r = simulateNextForrest(baseNextForrest());
    close(sum(r.rows, 'deposit'), r.totalDeposits);
  });

  test('Summe aller "Gebühren"-Spalten (inkl. Zeile 0) = totalFees', () => {
    const r = simulateNextForrest(baseNextForrest());
    close(sum(r.rows, 'fee'), r.totalFees);
  });

  test('Sparziel: Einzahlungsstrategie stoppt, sobald aktives Kapital das Ziel erreicht', () => {
    const r = simulateNextForrest(baseNextForrest({
      nfDepositStrategies: [depositStrategy({
        period: 'monthly',
        amount: 500,
        stopMode: 'threshold',
        thresholdBasis: 'capital',
        thresholdValue: 20000,
      })],
    }));
    const monthlyRows = r.rows.filter(row => row.month >= 1);
    const afterGoal = monthlyRows.filter(row => row.openingActive >= 20000);
    assert.ok(afterGoal.length > 0, 'Sparziel sollte innerhalb von 24 Monaten erreicht werden');
    afterGoal.forEach(row => {
      close(row.deposit, 0, `Monat ${row.month}: sollte keine strategiebasierte Einzahlung mehr haben`);
    });
  });

  test('stopMode "none" bedeutet kein dauerhafter Stopp der Einzahlungsstrategie', () => {
    // Vereinzelt kann ein Monat zufällig exakt auf einem 1000er-Block landen
    // (deposit = 0, weil kein Aufrunden nötig ist) — das ist kein Stopp,
    // solange spätere Monate wieder Einzahlungen zeigen.
    const r = simulateNextForrest(baseNextForrest({
      nfDepositStrategies: [depositStrategy({ period: 'monthly', amount: 500, stopMode: 'none' })],
    }));
    const monthlyRows = r.rows.filter(row => row.month >= 1);
    monthlyRows.forEach(row => {
      close(row.deposit, 500, `Monat ${row.month}: konstante Einzahlung ohne Stopp-Bedingung`);
    });
  });

  test('Auszahlung: Gebühr wird vom Bruttobetrag abgezogen', () => {
    const r = simulateNextForrest(baseNextForrest({
      nfWithdrawalStrategies: [withdrawalStrategy({ type: 'monthly', amount: 100 })],
    }));
    const withdrawingRows = r.rows.filter(row => row.withdrawn > 0);
    assert.ok(withdrawingRows.length > 0, 'es sollte Auszahlungen geben');
    withdrawingRows.forEach(row => {
      close(row.withdrawn, 100 * (1 - 0.035));
    });
  });

  test('Mindestkapital für Auszahlung: keine Auszahlung unterhalb der Schwelle', () => {
    const r = simulateNextForrest(baseNextForrest({
      nfWithdrawalStrategies: [withdrawalStrategy({
        type: 'monthly',
        amount: 100,
        stopMode: 'threshold',
        thresholdBasis: 'capital',
        thresholdValue: 15000,
      })],
    }));
    const tooEarly = r.rows.filter(row => row.month >= 1 && row.openingActive < 15000);
    tooEarly.forEach(row => {
      close(row.withdrawn, 0, `Monat ${row.month}: aktives Kapital ${row.openingActive} < 15000, sollte keine Auszahlung haben`);
    });
  });

  test('Einzahlungsstrategie "Fester Betrag": Gebühr = 1,5% des festen Betrags', () => {
    const r = simulateNextForrest(baseNextForrest({
      nfDepositStrategies: [depositStrategy({ period: 'monthly', amount: 200 })],
    }));
    const monthlyRows = r.rows.filter(row => row.month >= 1);
    monthlyRows.forEach(row => {
      close(row.deposit, 200);
    });
  });

  test('Einzahlungsschwelle auf Monatsrendite: Stopp erst wenn die Rendite des Monats die Schwelle erreicht (dauerhaft)', () => {
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfDepositStrategies: [depositStrategy({
        period: 'monthly',
        amount: 500,
        stopMode: 'threshold',
        thresholdBasis: 'interest',
        thresholdValue: 550,
      })],
    }));
    const byMonth = m => r.rows.find(row => row.month === m);
    // Monat 1: Rendite 10.000 × 5 % = 500 € < 550 € → Einzahlung läuft noch.
    close(byMonth(1).deposit, 500);
    // Monat 2: aktives Kapital ist durch den 1000er-Sweep aus Monat 1 auf
    // 11.000 € gestiegen → Rendite 550 € erreicht die Schwelle → Stopp.
    close(byMonth(2).deposit, 0);
    // Der Stopp ist dauerhaft, obwohl die Schwelle capital-seitig nie erneut
    // geprüft wird.
    close(byMonth(24).deposit, 0);
  });

  test('Auszahlungsschwelle auf Monatsrendite: Auszahlung erst sobald die Rendite des Monats die Schwelle erreicht', () => {
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfDepositStrategies: [],
      nfWithdrawalStrategies: [withdrawalStrategy({
        type: 'monthly',
        amount: 50,
        stopMode: 'threshold',
        thresholdBasis: 'interest',
        thresholdValue: 550,
      })],
    }));
    const byMonth = m => r.rows.find(row => row.month === m);
    const netWithdrawal = 50 * (1 - 0.035);
    // Monate 1–2: Rendite bleibt bei 500 € (aktives Kapital noch 10.000 €,
    // kein Sweep) — unter der Schwelle von 550 € → keine Auszahlung, obwohl
    // das aktive Kapital selbst weit über jeder üblichen Kapitalschwelle liegt.
    close(byMonth(1).withdrawn, 0);
    close(byMonth(2).withdrawn, 0);
    // Ab Monat 3 hat der Sweep aus Monat 2 das aktive Kapital auf 11.000 €
    // gehoben → Rendite 550 € erreicht die Schwelle → Auszahlung läuft an
    // und bleibt danach jeden Monat aktiv (Rendite wächst weiter).
    close(byMonth(3).withdrawn, netWithdrawal);
    close(byMonth(5).withdrawn, netWithdrawal);
  });

  test('Auszahlungsstrategie "cashSurplus": zahlt genau den Rest aus, der sonst nicht in einen 1000er-Block passt', () => {
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfDepositStrategies: [depositStrategy({ period: 'monthly', amount: 200 })],
      nfWithdrawalStrategies: [withdrawalStrategy({ type: 'cashSurplus' })],
    }));
    // Aktives Kapital bleibt bei 10.000 € (kein Sweep, da der gesamte Rest
    // jeden Monat ausgezahlt wird) → Rendite und damit der Cash-Zufluss
    // (500 € Rendite + 200 € Einzahlung = 700 €) sind jeden Monat identisch.
    const netExpected = 700 * (1 - 0.035);
    [1, 2, 12, 24].forEach(m => {
      const row = r.rows.find(row => row.month === m);
      close(row.withdrawn, netExpected, `Monat ${m}: Auszahlung sollte dem Cash-Überschuss entsprechen`);
      close(row.cash, 0, `Monat ${m}: Cash sollte nach der Auszahlung leer sein`);
      close(row.reinvested, 0, `Monat ${m}: es sollte kein Sweep stattfinden, da nichts übrig bleibt`);
    });
  });

  test('Auszahlungsstrategie "cashSurplus": wird nach den Einzahlungen berechnet, nicht davor', () => {
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      // Rendite (500 €) + Einzahlung (500 €) ergeben in Monat 1 exakt einen
      // vollen 1000er-Block. Würde der Überschuss vor der Einzahlung
      // berechnet, bliebe fälschlich ein Rest von 500 € übrig.
      nfDepositStrategies: [depositStrategy({ period: 'monthly', amount: 500 })],
      nfWithdrawalStrategies: [withdrawalStrategy({ type: 'cashSurplus' })],
    }));
    const month1 = r.rows.find(row => row.month === 1);
    close(month1.withdrawn, 0, 'kein Rest übrig → keine Auszahlung');
    close(month1.reinvested, 1000, 'der volle Block sollte gesweept werden');
  });

  test('Mehrere gleichzeitige Einzahlungsstrategien summieren sich pro Monat', () => {
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfDepositStrategies: [
        depositStrategy({ id: 'a', period: 'monthly', amount: 500, startMonth: 1, stopMode: 'date', endMonth: 12 }),
        depositStrategy({ id: 'b', period: 'monthly', amount: 300, startMonth: 13, stopMode: 'none' }),
      ],
    }));
    close(r.rows.find(row => row.month === 6).deposit, 500);
    close(r.rows.find(row => row.month === 18).deposit, 300);
    close(r.rows.find(row => row.month === 12).deposit, 500);
    close(r.rows.find(row => row.month === 13).deposit, 300);
  });

  test('Überlappende gleichzeitige Einzahlungsstrategien summieren sich', () => {
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfDepositStrategies: [
        depositStrategy({ id: 'a', period: 'monthly', amount: 400, startMonth: 1 }),
        depositStrategy({ id: 'b', period: 'monthly', amount: 250, startMonth: 1 }),
      ],
    }));
    close(r.rows.find(row => row.month === 5).deposit, 650);
  });

  test('Einmaleinzahlung gemischt mit wiederkehrender Strategie: Gebühr auf die Summe des Monats', () => {
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfDepositStrategies: [
        depositStrategy({ id: 'a', period: 'monthly', amount: 500, startMonth: 1 }),
        depositStrategy({ id: 'b', period: 'once', amount: 5000, startMonth: 6 }),
      ],
    }));
    const month6 = r.rows.find(row => row.month === 6);
    close(month6.deposit, 5500);
    close(month6.fee, 5500 * 0.015);
    const month7 = r.rows.find(row => row.month === 7);
    close(month7.deposit, 500, 'Einmalzahlung wirkt nur in ihrem eigenen Monat');
  });

  test('stopMode "date" ignoriert eine gleichzeitig gesetzte Schwelle', () => {
    // Schwelle würde bereits in Monat 3 greifen (aktives Kapital 11.000,
    // wenn capital-basiert, oder Rendite 550 wenn interest-basiert) — mit
    // stopMode "date" bleibt das Enddatum (Monat 6) allein maßgeblich.
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfDepositStrategies: [depositStrategy({
        period: 'monthly',
        amount: 500,
        stopMode: 'date',
        endMonth: 6,
        thresholdBasis: 'interest',
        thresholdValue: 550,
      })],
    }));
    close(r.rows.find(row => row.month === 3).deposit, 500, 'Schwelle wird bei stopMode "date" ignoriert');
    close(r.rows.find(row => row.month === 6).deposit, 500, 'letzter Monat im Datumsfenster');
    close(r.rows.find(row => row.month === 7).deposit, 0, 'Enddatum überschritten');
  });

  test('stopMode "threshold" ignoriert ein gleichzeitig gesetztes Enddatum', () => {
    // Identische Strategie wie oben, aber stopMode "threshold": das
    // Enddatum (Monat 6) wird ignoriert, die Schwelle (Rendite ≥ 550, ab
    // Monat 2) ist allein maßgeblich.
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfDepositStrategies: [depositStrategy({
        period: 'monthly',
        amount: 500,
        stopMode: 'threshold',
        endMonth: 6,
        thresholdBasis: 'interest',
        thresholdValue: 550,
      })],
    }));
    close(r.rows.find(row => row.month === 1).deposit, 500, 'Rendite 500 < 550 → läuft noch');
    close(r.rows.find(row => row.month === 2).deposit, 0, 'Rendite erreicht 550 → Stopp, Enddatum wird ignoriert');
  });

  test('Einzahlungs-Schwellen-Stopp bleibt pro Strategie unabhängig: eine gestoppte Strategie hält andere nicht auf', () => {
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfDepositStrategies: [
        depositStrategy({
          id: 'stops-early', period: 'monthly', amount: 500,
          stopMode: 'threshold', thresholdBasis: 'interest', thresholdValue: 550,
        }),
        depositStrategy({ id: 'keeps-going', period: 'monthly', amount: 100, stopMode: 'none' }),
      ],
    }));
    // Monat 1: beide aktiv (500 + 100). Ab Monat 2 stoppt die erste dauerhaft,
    // die zweite läuft unverändert weiter.
    close(r.rows.find(row => row.month === 1).deposit, 600);
    close(r.rows.find(row => row.month === 2).deposit, 100);
    close(r.rows.find(row => row.month === 24).deposit, 100, 'dauerhafter Stopp bleibt bis zum Ende bestehen');
  });

  test('Auszahlungs-Schwelle ist nicht dauerhaft: Auszahlung kann pausieren und wieder einsetzen', () => {
    // Rendite auf Kapitalbasis: solange keine Einzahlung/Reinvestition
    // stattfindet, bleibt das aktive Kapital konstant, also auch die
    // Rendite — daher hier ein Enddatum + erneuter Start über zwei separate
    // Strategien, um "Pause dann wieder aktiv" auf der Zeitachse zu zeigen.
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfWithdrawalStrategies: [
        withdrawalStrategy({ id: 'early', type: 'monthly', amount: 50, startMonth: 1, stopMode: 'date', endMonth: 2 }),
        withdrawalStrategy({ id: 'late', type: 'monthly', amount: 50, startMonth: 10, stopMode: 'none' }),
      ],
    }));
    close(r.rows.find(row => row.month === 1).withdrawn, 50 * (1 - 0.035));
    close(r.rows.find(row => row.month === 5).withdrawn, 0, 'zwischen den beiden Fenstern keine Auszahlung');
    close(r.rows.find(row => row.month === 10).withdrawn, 50 * (1 - 0.035));
  });

  test('Gemischte Auszahlungstypen gleichzeitig: prozentual + cashSurplus im selben Monat', () => {
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfDepositStrategies: [depositStrategy({ period: 'monthly', amount: 300 })],
      nfWithdrawalStrategies: [
        withdrawalStrategy({ id: 'pct', type: 'percentage', amount: 10 }),
        withdrawalStrategy({ id: 'surplus', type: 'cashSurplus' }),
      ],
    }));
    const month1 = r.rows.find(row => row.month === 1);
    // Rendite Monat 1 = 500 €, 10% davon = 50 € brutto (prozentual, vor
    // Einzahlung). Danach: Cash = 500 - 50(brutto) + 300(Einzahlung) = 750,
    // Rest zum nächsten 1000er-Block ist 0 (750 < 1000, kein Sweep) →
    // cashSurplus zahlt die vollen 750 € brutto aus.
    const pctNet = 50 * (1 - 0.035);
    const surplusNet = 750 * (1 - 0.035);
    close(month1.withdrawn, pctNet + surplusNet);
  });

  test('Auszahlungstyp "once": zahlt genau einmal im angegebenen Monat aus', () => {
    // Hoher Startbetrag ohne Roundup/Einzahlungen: die monatliche Rendite
    // allein (2.500 €) übersteigt den einmaligen Auszahlungsbetrag (1.000 €)
    // in jedem Monat sicher, damit die Auszahlung nie am verfügbaren Cash
    // geclamped wird (Auszahlung läuft VOR dem Sweep dieses Monats).
    const r = simulateNextForrest(baseNextForrest({
      start: 50000,
      includeStartCapital: false,
      nfDepositStrategies: [],
      nfWithdrawalStrategies: [withdrawalStrategy({ type: 'once', amount: 1000, startMonth: 6 })],
    }));
    close(r.rows.find(row => row.month === 5).withdrawn, 0);
    close(r.rows.find(row => row.month === 6).withdrawn, 1000 * (1 - 0.035));
    close(r.rows.find(row => row.month === 7).withdrawn, 0);
  });

  test('Roundup gemeinsam mit einer festen Einzahlungsstrategie aktiv (zwei Einträge derselben Liste): beide tragen im selben Monat zum Cash-Pool bei', () => {
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfDepositStrategies: [
        depositStrategy({ id: 'fixed1', kind: 'fixed', period: 'monthly', amount: 200 }),
        depositStrategy({ id: 'round1', kind: 'roundup' }),
      ],
    }));
    const month1 = r.rows.find(row => row.month === 1);
    // Rendite 500 € + 200 € feste Einzahlung = 700 €, Roundup füllt auf den
    // nächsten 1000er-Block auf: +300 € → insgesamt 500 € "deposit"-Anteil
    // aus Strategie(200) + Roundup(300) = 500, voller Sweep von 1000.
    close(month1.deposit, 500);
    close(month1.reinvested, 1000);
  });

  test('Zwei gleichzeitige Roundup-Einträge: der zweite hat nichts mehr aufzurunden (kein doppeltes Aufrunden)', () => {
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfDepositStrategies: [
        depositStrategy({ id: 'round1', kind: 'roundup' }),
        depositStrategy({ id: 'round2', kind: 'roundup' }),
      ],
    }));
    const month1 = r.rows.find(row => row.month === 1);
    close(month1.deposit, 500, 'Rendite 500€ auf den vollen 1000er-Block aufgerundet, nur einmal');
    close(month1.reinvested, 1000);
  });

  describe('Auszahlung größer als verfügbares Cash: zieht zusätzliche 1000er-Blöcke aus dem aktiven Kapital', () => {
    test('Reicht das Cash nicht, werden genau so viele volle Blöcke nachgezogen, wie für die volle Auszahlung nötig sind', () => {
      const r = simulateNextForrest(baseNextForrest({
        start: 20000,
        includeStartCapital: false,
        nfRoundupEnabled: false,
        nfDepositStrategies: [],
        nfWithdrawalStrategies: [withdrawalStrategy({ type: 'once', amount: 10000, startMonth: 1 })],
      }));
      const month1 = r.rows.find(row => row.month === 1);
      // Cash vor der Auszahlung = nur die Rendite (1.000€, 5% von 20.000€).
      // Fehlbetrag 9.000€ → 9 volle 1000er-Blöcke werden aus dem aktiven
      // Kapital zurückgeholt, sodass die vollen 10.000€ brutto ausgezahlt
      // werden können.
      close(month1.withdrawn, 10000 * (1 - 0.035));
      close(month1.active, 20000 - 9000, 'aktives Kapital sinkt exakt um die nachgezogenen Blöcke');
      close(month1.cash, 0);
    });

    test('Nicht benötigter Rest eines nachgezogenen Blocks bleibt als Cash übrig und wird ganz normal weiter gesweept', () => {
      const r = simulateNextForrest(baseNextForrest({
        start: 20000,
        includeStartCapital: false,
        nfRoundupEnabled: false,
        nfDepositStrategies: [],
        nfWithdrawalStrategies: [withdrawalStrategy({ type: 'once', amount: 1500, startMonth: 1 })],
      }));
      const month1 = r.rows.find(row => row.month === 1);
      // Cash vor Auszahlung = 1.000€ Rendite, Fehlbetrag 500€ → ein voller
      // Block (1.000€) wird nachgezogen (nicht nur 500€, da nur ganze Blöcke
      // bewegt werden dürfen). Nach der Auszahlung (1.500€ brutto) bleiben
      // 500€ Rest im Cash, die aktuell noch keinen vollen Block ergeben.
      close(month1.withdrawn, 1500 * (1 - 0.035));
      close(month1.active, 19000);
      close(month1.cash, 500);
    });

    test('Reicht auch das aktive Kapital nicht aus, wird die Auszahlung auf das Maximum in vollen Blöcken gekappt', () => {
      const r = simulateNextForrest(baseNextForrest({
        start: 3000,
        includeStartCapital: false,
        nfRoundupEnabled: false,
        nfDepositStrategies: [],
        nfWithdrawalStrategies: [withdrawalStrategy({ type: 'once', amount: 10000, startMonth: 1 })],
      }));
      const month1 = r.rows.find(row => row.month === 1);
      // Rendite 150€ (5% von 3.000€) + maximal 3.000€ nachziehbares aktives
      // Kapital = 3.150€ verfügbar — mehr kann trotz gewünschter 10.000€
      // nicht ausgezahlt werden.
      close(month1.withdrawn, 3150 * (1 - 0.035));
      close(month1.active, 0);
      close(month1.cash, 0);
    });

    test('"Cash-Überschuss" bleibt unverändert: zieht keine zusätzlichen Blöcke aus dem aktiven Kapital', () => {
      const r = simulateNextForrest(baseNextForrest({
        start: 20000,
        includeStartCapital: false,
        nfRoundupEnabled: false,
        nfDepositStrategies: [],
        nfWithdrawalStrategies: [withdrawalStrategy({ type: 'cashSurplus' })],
      }));
      const month1 = r.rows.find(row => row.month === 1);
      // Rendite 1.000€ ist bereits ein voller Block → cashSurplus zahlt
      // nichts aus (kein Rest übrig), aktives Kapital bleibt unangetastet.
      close(month1.withdrawn, 0);
      close(month1.active, 21000);
    });

    test('Mehrere gleichzeitige Auszahlungsstrategien: der Fehlbetrag wird auf die Summe berechnet, nicht pro Strategie einzeln', () => {
      const r = simulateNextForrest(baseNextForrest({
        start: 20000,
        includeStartCapital: false,
        nfRoundupEnabled: false,
        nfDepositStrategies: [],
        nfWithdrawalStrategies: [
          withdrawalStrategy({ id: 'a', type: 'once', amount: 4000, startMonth: 1 }),
          withdrawalStrategy({ id: 'b', type: 'once', amount: 4000, startMonth: 1 }),
        ],
      }));
      const month1 = r.rows.find(row => row.month === 1);
      close(month1.withdrawn, 8000 * (1 - 0.035));
      close(month1.active, 20000 - 7000, 'Fehlbetrag 7.000€ (8.000 - 1.000 Rendite) → 7 Blöcke nachgezogen');
    });
  });

  describe('Auszahlungsstrategie stopMode "total": so lange auszahlen, bis eine NETTO-Gesamtsumme erreicht ist', () => {
    test('500 €/Monat (brutto) bis 3.000 € NETTO ausgezahlt sind: 6 volle Raten + eine gekappte Restrate', () => {
      const r = simulateNextForrest(baseNextForrest({
        start: 50000,
        includeStartCapital: false,
        nfRoundupEnabled: false,
        nfDepositStrategies: [],
        nfWithdrawalStrategies: [withdrawalStrategy({
          type: 'monthly', amount: 500, stopMode: 'total', thresholdValue: 3000,
        })],
      }));
      const netPerMonth = 500 * (1 - 0.035); // 482,50 €
      for (let m = 1; m <= 6; m++) {
        close(r.rows.find(row => row.month === m).withdrawn, netPerMonth, `Monat ${m}: volle Rate`);
      }
      // Nach 6 vollen Netto-Raten fehlen noch 3.000 - 6×482,50 = 105 € netto.
      close(r.rows.find(row => row.month === 7).withdrawn, 105, 'Monat 7: Restrate exakt in Höhe des fehlenden Netto-Betrags');
      for (let m = 8; m <= 12; m++) {
        close(r.rows.find(row => row.month === m).withdrawn, 0, `Monat ${m}: Zielbetrag erreicht, dauerhaft aus`);
      }
      const totalNet = r.rows.reduce((sum, row) => sum + row.withdrawn, 0);
      close(totalNet, 3000, 'kumulierte Netto-Auszahlung entspricht exakt dem Zielbetrag');
    });

    test('Zielbetrag ist kein glattes Vielfaches der Netto-Rate: letzte Rate wird gekappt, nicht die volle Rate ausgezahlt', () => {
      const r = simulateNextForrest(baseNextForrest({
        start: 50000,
        includeStartCapital: false,
        nfRoundupEnabled: false,
        nfDepositStrategies: [],
        nfWithdrawalStrategies: [withdrawalStrategy({
          type: 'monthly', amount: 500, stopMode: 'total', thresholdValue: 2800,
        })],
      }));
      const netPerMonth = 500 * (1 - 0.035); // 482,50 €
      for (let m = 1; m <= 5; m++) {
        close(r.rows.find(row => row.month === m).withdrawn, netPerMonth, `Monat ${m}: volle Rate`);
      }
      // Nach 5 vollen Raten (2.412,50 €) fehlen noch 387,50 € netto.
      close(r.rows.find(row => row.month === 6).withdrawn, 387.5, 'Monat 6: nur noch der fehlende Netto-Restbetrag');
      close(r.rows.find(row => row.month === 7).withdrawn, 0, 'Ziel bereits erreicht');
    });

    test('Zielbetrag bezieht sich auf den NETTO-Betrag (nach Gebühr) — eine einzelne Bruttozahlung in Zielhöhe reicht daher NICHT aus', () => {
      const r = simulateNextForrest(baseNextForrest({
        start: 50000,
        includeStartCapital: false,
        nfRoundupEnabled: false,
        nfDepositStrategies: [],
        nfWithdrawalStrategies: [withdrawalStrategy({
          type: 'monthly', amount: 1000, stopMode: 'total', thresholdValue: 1000,
        })],
      }));
      // Monat 1: 1.000 € brutto → 965 € netto, das Ziel (1.000 € netto) ist
      // damit noch NICHT erreicht — es fehlen noch 35 € netto.
      close(r.rows.find(row => row.month === 1).withdrawn, 965);
      close(r.rows.find(row => row.month === 2).withdrawn, 35, 'Restrate für die fehlenden 35€ netto');
      close(r.rows.find(row => row.month === 3).withdrawn, 0, 'Ziel jetzt erreicht');
    });

    test('Zielbetrag 0 bedeutet unbegrenzt (wie bei den anderen Stopp-Bedingungen)', () => {
      const r = simulateNextForrest(baseNextForrest({
        start: 50000,
        includeStartCapital: false,
        nfRoundupEnabled: false,
        nfDepositStrategies: [],
        nfWithdrawalStrategies: [withdrawalStrategy({
          type: 'monthly', amount: 500, stopMode: 'total', thresholdValue: 0,
        })],
      }));
      close(r.rows.find(row => row.month === 12).withdrawn, 500 * (1 - 0.035), 'läuft ohne Ziel unbegrenzt weiter');
    });

    test('"Cash-Überschuss" mit Zielbetrag: stoppt dauerhaft, sobald die kumulierte NETTO-Summe der ausgezahlten Reste erreicht ist', () => {
      const r = simulateNextForrest(baseNextForrest({
        start: 0,
        includeStartCapital: false,
        nfRoundupEnabled: false,
        nfDepositStrategies: [depositStrategy({ kind: 'fixed', period: 'monthly', amount: 700 })],
        nfWithdrawalStrategies: [withdrawalStrategy({
          type: 'cashSurplus', stopMode: 'total', thresholdValue: 300,
        })],
      }));
      // 700€ Einzahlung/Monat, kein Zins (Startkapital 0) → Cash-Überschuss
      // (Rest unter 1000er-Block) wäre ohne Ziel konstant 700€ brutto/Monat.
      // Mit Netto-Ziel 300€ wird die erste Auszahlung so gekappt, dass genau
      // 300€ NETTO ankommen (Brutto dafür: 300/0,965 ≈ 310,88€).
      close(r.rows.find(row => row.month === 1).withdrawn, 300);
      close(r.rows.find(row => row.month === 2).withdrawn, 0);
    });
  });
});

describe('runSimulation', () => {
  test('wählt simulate() für "classic" und simulateNextForrest() für "nextforrest"', () => {
    const classicResult = runSimulation(baseClassic());
    const nfResult = runSimulation(baseNextForrest());
    close(classicResult.finalWealth, simulate(baseClassic()).finalWealth);
    close(nfResult.finalWealth, simulateNextForrest(baseNextForrest()).finalWealth);
  });
});

describe('migrateScenarioValues: alte flache Felder → neues Array-Schema', () => {
  test('bereits im neuen Schema vorliegende Werte bleiben unverändert', () => {
    const values = baseNextForrest({
      nfDepositStrategies: [depositStrategy({ amount: 111 })],
      nfWithdrawalStrategies: [withdrawalStrategy({ amount: 22 })],
    });
    const migrated = migrateScenarioValues(values);
    assert.strictEqual(migrated.nfDepositStrategies[0].amount, 111);
    assert.strictEqual(migrated.nfWithdrawalStrategies[0].amount, 22);
  });

  test('fixed-Einzahlung + Sparziel + fixed-Auszahlung + Mindestkapital: identisches Simulationsergebnis vor/nach Migration', () => {
    const oldShape = {
      investmentType: 'nextforrest',
      start: 10000,
      includeStartCapital: true,
      duration: 24,
      durationUnit: 'months',
      nfRate: 'low',
      nfDepositStrategy: 'fixed',
      nfMonthlyDeposit: 500,
      nfMonthlyDepositPeriod: 'monthly',
      nfDepositGoal: 20000,
      nfDepositGoalThresholdBasis: 'capital',
      nfWithdrawalStrategy: 'fixed',
      nfWithdrawalAmount: 50,
      nfWithdrawalPeriod: 'monthly',
      nfWithdrawalMinCapital: 15000,
      nfWithdrawalThresholdBasis: 'capital',
    };
    // Referenzergebnis: von Hand über die neuen Bausteine nachgebaut (exakt
    // das migrierte Schema), um sicherzustellen, dass migrateScenarioValues
    // dieselben Werte erzeugt wie eine direkt im neuen Schema formulierte,
    // äquivalente Konfiguration.
    const expectedShape = baseNextForrest({
      start: 10000,
      includeStartCapital: true,
      nfDepositStrategies: [depositStrategy({
        id: 'nfd-migrated-1', period: 'monthly', amount: 500, startMonth: 1,
        stopMode: 'threshold', thresholdBasis: 'capital', thresholdValue: 20000,
      })],
      nfWithdrawalStrategies: [withdrawalStrategy({
        id: 'nfw-migrated-1', type: 'monthly', amount: 50, startMonth: 1,
        stopMode: 'threshold', thresholdBasis: 'capital', thresholdValue: 15000,
      })],
    });

    const migrated = migrateScenarioValues(oldShape);
    assert.deepStrictEqual(migrated.nfDepositStrategies, expectedShape.nfDepositStrategies);
    assert.deepStrictEqual(migrated.nfWithdrawalStrategies, expectedShape.nfWithdrawalStrategies);
    assert.strictEqual(migrated.nfRoundupEnabled, undefined, 'das alte separate Flag gibt es nicht mehr');
    assert.strictEqual(migrated.nfDepositStrategy, undefined, 'alte Felder werden entfernt');

    const before = simulateNextForrest(migrated);
    const after = simulateNextForrest(expectedShape);
    close(before.finalWealth, after.finalWealth);
    close(before.totalDeposits, after.totalDeposits);
    close(before.totalWithdrawn, after.totalWithdrawn);
  });

  test('roundup-Strategie mit Sparziel migriert verlustfrei zu einem einzelnen Roundup-Eintrag mit Schwelle', () => {
    const oldShape = {
      investmentType: 'nextforrest',
      start: 10000,
      includeStartCapital: true,
      duration: 6,
      durationUnit: 'months',
      nfRate: 'low',
      nfDepositStrategy: 'roundup',
      nfMonthlyDeposit: 500, // wird bei kind 'roundup' ignoriert, wie schon vorher
      nfDepositGoal: 20000,
      nfDepositGoalThresholdBasis: 'capital',
      nfWithdrawalStrategy: 'fixed',
      nfWithdrawalAmount: 0,
      nfWithdrawalMinCapital: 0,
    };
    const migrated = migrateScenarioValues(oldShape);
    assert.strictEqual(migrated.nfDepositStrategies.length, 1);
    assert.strictEqual(migrated.nfDepositStrategies[0].kind, 'roundup');
    assert.strictEqual(migrated.nfDepositStrategies[0].stopMode, 'threshold');
    assert.strictEqual(migrated.nfDepositStrategies[0].thresholdBasis, 'capital');
    assert.strictEqual(migrated.nfDepositStrategies[0].thresholdValue, 20000);
    assert.strictEqual(migrated.nfRoundupEnabled, undefined);
  });

  test('cashSurplus-Auszahlung ohne Betrag/Schwelle migriert trotzdem zu einer aktiven Strategie', () => {
    const oldShape = {
      investmentType: 'nextforrest',
      start: 10000,
      includeStartCapital: false,
      duration: 3,
      durationUnit: 'months',
      nfRate: 'low',
      nfDepositStrategy: 'fixed',
      nfMonthlyDeposit: 500,
      nfWithdrawalStrategy: 'cashSurplus',
      nfWithdrawalAmount: 0,
      nfWithdrawalMinCapital: 0,
    };
    const migrated = migrateScenarioValues(oldShape);
    assert.strictEqual(migrated.nfWithdrawalStrategies.length, 1);
    assert.strictEqual(migrated.nfWithdrawalStrategies[0].type, 'cashSurplus');
  });

  test('yearly-Kadenz wird auf Monat 12 verankert (entspricht der alten monthIndex % 12 === 0 Logik)', () => {
    const oldShape = {
      investmentType: 'nextforrest',
      start: 0,
      includeStartCapital: false,
      duration: 24,
      durationUnit: 'months',
      nfRate: 'low',
      nfDepositStrategy: 'fixed',
      nfMonthlyDeposit: 1000,
      nfMonthlyDepositPeriod: 'yearly',
    };
    const migrated = migrateScenarioValues(oldShape);
    const r = simulateNextForrest(migrated);
    close(r.rows.find(row => row.month === 11).deposit, 0);
    close(r.rows.find(row => row.month === 12).deposit, 1000);
    close(r.rows.find(row => row.month === 13).deposit, 0);
    close(r.rows.find(row => row.month === 24).deposit, 1000);
  });
});

describe('Team-Struktur / Rangsystem (simulateNextForrest.team)', () => {
  function baseTeam(overrides) {
    return baseNextForrest({
      start: 15000,
      includeStartCapital: false,
      duration: 1,
      nfDepositStrategies: [],
      nfTeamMembers: [],
      ...overrides
    });
  }

  test('Ohne Teammitglieder bleibt team null und das Ergebnis unverändert', () => {
    const r = simulateNextForrest(baseTeam());
    assert.strictEqual(r.team, null);
  });

  test('Tippgeber-Bonus: 50 € pro 1000er-Block, einmalig, nur für Ebene-1-Empfehlungen, unabhängig vom Rang', () => {
    const r = simulateNextForrest(baseTeam({
      duration: 6,
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 3000, monthlyDeposit: 0, joinMonth: 1, children: [
          { name: 'Ebene2', startCapital: 5000, monthlyDeposit: 0, joinMonth: 1, children: [] }
        ] }
      ]
    }));
    const byMonth = m => r.team.rows.find(row => row.month === m);
    // Kein Monat 0 mehr — alle Bonuszahlungen laufen ab Monat 1. Ebene 1:
    // 3.000 € Startkapital = 3 Blöcke → 3 × 50 € = 150 €, im tatsächlichen
    // Beitrittsmonat 1. Ebene 2 zählt hier nicht mit, da sie nicht direkt
    // vom Szenario-Inhaber geworben wurde: ihre 5 Blöcke (250 €) gehen an
    // Ebene 1, nicht an mich.
    assert.strictEqual(byMonth(0), undefined);
    assert.strictEqual(byMonth(1).rank, 'Forrest Member');
    close(byMonth(1).tippgeberBonus, 150);
    close(byMonth(2).tippgeberBonus, 0);
    // 200 € statt 150 €, seit Ebene 2 unter Ebene 1 hängt: die 250 €
    // Tippgeber-Bonus, die Ebene 1 für Ebene 2 bekommt, füllen zusammen mit
    // ihren eigenen Zinsen (150 €/Monat) bis Monat 5 einen vollen 1000er-
    // Block. Dieser Sweep bei Ebene 1 zahlt mir weitere 50 €.
    close(r.team.totalTippgeberBonus, 200);
  });

  test('Tippgeber-Bonus wird im tatsächlichen Beitrittsmonat der Empfehlung gutgeschrieben', () => {
    const r = simulateNextForrest(baseTeam({
      duration: 6,
      nfTeamMembers: [
        { name: 'Spaeteinsteiger', startCapital: 2000, monthlyDeposit: 0, joinMonth: 4 }
      ]
    }));
    const byMonth = m => r.team.rows.find(row => row.month === m);
    close(byMonth(1).tippgeberBonus, 0);
    close(byMonth(3).tippgeberBonus, 0);
    close(byMonth(4).tippgeberBonus, 100); // 2 Blöcke × 50 €
  });

  test('Tippgeber-Bonus zählt JEDEN reinvestierten Block — auch aus Zinsen, nicht nur aus Einzahlungen', () => {
    // 100.000 € Startkapital = 100 Blöcke (5.000 €). Die erste Monatsrendite
    // (5 % von 100.000 € = 5.000 €) wird ebenfalls vollständig reinvestiert
    // (5 weitere Blöcke) und zählt zusätzlich: 5.000 € + 250 € = 5.250 € in
    // Monat 1. Danach läuft der Bonus auf die weiter anfallenden Zinsen
    // dauerhaft weiter (250 €/Monat), solange das Kapital wächst.
    const r = simulateNextForrest(baseTeam({
      duration: 3,
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 100000, monthlyDeposit: 0, joinMonth: 1 }
      ]
    }));
    const byMonth = m => r.team.rows.find(row => row.month === m);
    close(byMonth(1).tippgeberBonus, 5250);
    close(byMonth(2).tippgeberBonus, 250);
    close(byMonth(3).tippgeberBonus, 250);
  });

  test('"Als Einzahlung berücksichtigen" pro Mitglied: unchecked verhindert nur den Bonus auf den ursprünglichen Einzahlungsblock, nicht auf spätere Zins-Reinvestitionen', () => {
    const r = simulateNextForrest(baseTeam({
      duration: 2,
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 50000, monthlyDeposit: 0, joinMonth: 1, includeStartCapital: false }
      ]
    }));
    const byMonth = m => r.team.rows.find(row => row.month === m);
    // Kein Bonus auf die ursprünglichen 50.000 € selbst (kein Einzahlungs-
    // ereignis), aber die erste Monatsrendite (5 % von 50.000 € = 2.500 €)
    // wird trotzdem reinvestiert (2 Blöcke) und zahlt normal.
    close(byMonth(1).tippgeberBonus, 100);
    close(byMonth(1).teamVolume, 50000);
  });

  test('"Als Einzahlung berücksichtigen" blockiert nur den Bonus auf das (bereits ausgezahlte) Startkapital — laufende Einzahlungen UND Zins-Reinvestitionen lösen weiterhin normal Tippgeber-Bonus aus', () => {
    const r = simulateNextForrest(baseTeam({
      duration: 3,
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 50000, monthlyDeposit: 1000, joinMonth: 1, includeStartCapital: false }
      ]
    }));
    const byMonth = m => r.team.rows.find(row => row.month === m);
    close(byMonth(1).tippgeberBonus, 150);
    close(byMonth(2).tippgeberBonus, 200);
    close(byMonth(3).tippgeberBonus, 200);
  });

  test('Forrest Bronze (10K eigen + 100K Team): 1 % auf Ebene 1, kein Eigen-Bonus, kein E2/E3', () => {
    // Referenzbeispiel aus der Spezifikation: 500.000 € auf Ebene 1 bei 1 % → 5.000 € Bonus.
    const r = simulateNextForrest(baseTeam({
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 500000, monthlyDeposit: 0, joinMonth: 1 }
      ]
    }));
    const row = r.team.rows.find(row => row.month === 1);
    assert.strictEqual(row.rank, 'Forrest Bronze');
    close(row.e1Bonus, 5000);
    close(row.ownBonus, 0);
    close(row.e2Bonus, 0);
    close(row.e3Bonus, 0);
  });

  test('Forrest Silver (20K eigen + 200K Team): zusätzlich 1 % auf Ebene 2, weiterhin kein Eigen-Bonus', () => {
    const r = simulateNextForrest(baseTeam({
      start: 20000,
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 150000, monthlyDeposit: 0, joinMonth: 1, children: [
          { name: 'Ebene2', startCapital: 60000, monthlyDeposit: 0, joinMonth: 1, children: [] }
        ] }
      ]
    }));
    const row = r.team.rows.find(row => row.month === 1);
    assert.strictEqual(row.rank, 'Forrest Silver');
    close(row.teamVolume, 210000);
    close(row.e1Bonus, 1500);
    close(row.e2Bonus, 600);
    close(row.ownBonus, 0);
  });

  test('Forrest Gold (30K eigen + 300K Team): 1 % Eigen-Bonus zusätzlich zu E1+E2, aber noch kein E3', () => {
    const r = simulateNextForrest(baseTeam({
      start: 30000,
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 150000, monthlyDeposit: 0, joinMonth: 1, children: [
          { name: 'Ebene2', startCapital: 100000, monthlyDeposit: 0, joinMonth: 1, children: [
            { name: 'Ebene3', startCapital: 60000, monthlyDeposit: 0, joinMonth: 1, children: [] }
          ] }
        ] }
      ]
    }));
    const row = r.team.rows.find(row => row.month === 1);
    assert.strictEqual(row.rank, 'Forrest Gold');
    close(row.ownBonus, 300); // 1 % von 30.000 €
    close(row.e1Bonus, 1500);
    close(row.e2Bonus, 1000);
    close(row.e3Bonus, 0); // Ebene 3 zahlt bei Gold noch nichts
  });

  test('Forrest Platinum (60K eigen + 600K Team): Ebene 3 kommt dazu, alle Sätze bei 1 %', () => {
    const r = simulateNextForrest(baseTeam({
      start: 60000,
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 200000, monthlyDeposit: 0, joinMonth: 1, children: [
          { name: 'Ebene2', startCapital: 200000, monthlyDeposit: 0, joinMonth: 1, children: [
            { name: 'Ebene3', startCapital: 200000, monthlyDeposit: 0, joinMonth: 1, children: [] }
          ] }
        ] }
      ]
    }));
    const row = r.team.rows.find(row => row.month === 1);
    assert.strictEqual(row.rank, 'Forrest Platinum');
    close(row.ownBonus, 600);
    close(row.e1Bonus, 2000);
    close(row.e2Bonus, 2000);
    close(row.e3Bonus, 2000);
  });

  test('Forrest Diamond (100K eigen + 1M Team): Eigen-Bonus steigt auf 2 %, Ebenen bleiben bei 1 %', () => {
    const r = simulateNextForrest(baseTeam({
      start: 100000,
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 400000, monthlyDeposit: 0, joinMonth: 1, children: [
          { name: 'Ebene2', startCapital: 400000, monthlyDeposit: 0, joinMonth: 1, children: [
            { name: 'Ebene3', startCapital: 200000, monthlyDeposit: 0, joinMonth: 1, children: [] }
          ] }
        ] }
      ]
    }));
    const row = r.team.rows.find(row => row.month === 1);
    assert.strictEqual(row.rank, 'Forrest Diamond');
    close(row.ownBonus, 2000); // 2 % von 100.000 €
    close(row.e1Bonus, 4000);
    close(row.e2Bonus, 4000);
    close(row.e3Bonus, 2000);
  });

  test('Ohne erreichte Schwelle bleibt der Rang "Forrest Member" ohne Rangboni, Tippgeber-Boni fallen trotzdem an', () => {
    const r = simulateNextForrest(baseTeam({
      duration: 6,
      start: 1000,
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 2000, monthlyDeposit: 0, joinMonth: 1 }
      ]
    }));
    r.team.rows.forEach(row => {
      assert.strictEqual(row.rank, 'Forrest Member');
      close(row.ownBonus, 0);
      close(row.e1Bonus, 0);
    });
    close(r.team.totalTippgeberBonus, 100); // 2 Blöcke × 50 €, unabhängig vom Rang
  });

  test('Rang ist dauerhaft und ersetzt niedrigere Ränge (nicht kumulativ)', () => {
    const r = simulateNextForrest(baseTeam({
      start: 30000,
      duration: 3,
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 150000, monthlyDeposit: 0, joinMonth: 1, children: [
          { name: 'Ebene2', startCapital: 100000, monthlyDeposit: 0, joinMonth: 1, children: [
            { name: 'Ebene3', startCapital: 60000, monthlyDeposit: 0, joinMonth: 1, children: [] }
          ] }
        ] }
      ]
    }));
    // Einmal Gold erreicht, bleibt der Rang für den Rest der Laufzeit
    // mindestens Gold (rankIndex sinkt nie).
    let lastIndex = -1;
    r.team.rows.forEach(row => {
      assert.ok(row.rankIndex >= lastIndex, 'Rang darf nie sinken');
      lastIndex = row.rankIndex;
    });
    assert.ok(r.team.rankIndex >= 3, 'sollte mindestens Gold (Index 3) erreicht haben');
  });

  test('Boni landen tatsächlich im eigenen Cash-Konto: finalWealth steigt exakt um die Bonussumme', () => {
    const values = baseTeam({
      start: 30000,
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 150000, monthlyDeposit: 0, joinMonth: 1, children: [
          { name: 'Ebene2', startCapital: 100000, monthlyDeposit: 0, joinMonth: 1, children: [] }
        ] }
      ]
    });
    const withTeam = simulateNextForrest(values);
    const withoutTeam = simulateNextForrest({ ...values, nfTeamMembers: [] });
    close(withTeam.finalWealth - withoutTeam.finalWealth, withTeam.team.totalBonus);
  });

  test('Prozentuale Auszahlung basiert standardmäßig auf Rendite + Bonus', () => {
    const values = baseTeam({
      start: 30000,
      nfWithdrawalStrategies: [withdrawalStrategy({ type: 'percentage', amount: 10 })],
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 150000, monthlyDeposit: 0, joinMonth: 1, children: [
          { name: 'Ebene2', startCapital: 100000, monthlyDeposit: 0, joinMonth: 1, children: [] }
        ] }
      ]
    });
    const r = simulateNextForrest(values);

    const interestMonth1 = r.rows.find(row => row.month === 1).interest;
    const bonusMonth1 = r.team.rows.find(row => row.month === 1).totalBonus;
    assert.ok(bonusMonth1 > 0, 'Testaufbau sollte einen Bonus > 0 erzeugen');

    close(
      r.rows.find(row => row.month === 1).withdrawn,
      (interestMonth1 + bonusMonth1) * 0.10 * (1 - 0.035)
    );
  });

  test('Jede Monatszeile führt eine members-Liste mit der Momentaufnahme jedes aktiven Mitglieds', () => {
    const r = simulateNextForrest(baseTeam({
      duration: 2,
      nfTeamMembers: [
        { name: 'Ebene1', startCapital: 3000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Spaeteinsteiger', startCapital: 1000, monthlyDeposit: 0, joinMonth: 2 }
      ]
    }));
    const month1 = r.team.rows.find(row => row.month === 1);
    const month2 = r.team.rows.find(row => row.month === 2);
    assert.strictEqual(month1.members.length, 1);
    assert.strictEqual(month1.members[0].name, 'Ebene1');
    close(month1.members[0].row.active, 3000);
    close(month1.members[0].tippgeberBonus, 150); // 3 Blöcke × 50 €
    assert.strictEqual(month2.members.length, 2);
    assert.strictEqual(month2.members[1].name, 'Spaeteinsteiger');
    close(month2.members[1].row.active, 1000);
  });
});

describe('Team-Mitglieder: eigene Szenario-Eigenschaften (simulateTeamMember)', () => {
  function baseMain(overrides) {
    return baseNextForrest({
      duration: 3,
      nfRate: 'low',
      nfDepositStrategies: [],
      ...overrides
    });
  }

  test('Ohne eigene Werte erbt ein Mitglied weiterhin Rendite und Einzahlungsstrategie vom Hauptszenario', () => {
    const v = baseMain({ nfRate: 'high' });
    const sim = simulateTeamMember(v, {
      startCapital: 10000, monthlyDeposit: 0, joinMonth: 1, includeStartCapital: false
    });
    const row1 = sim.result.rows.find(r => r.month === 1);
    close(row1.interest, 10000 * NF_RATES.high);
  });

  test('Eigene Rendite überschreibt die des Hauptszenarios', () => {
    const v = baseMain({ nfRate: 'low' });
    const sim = simulateTeamMember(v, {
      nfRate: 'high', startCapital: 10000, monthlyDeposit: 0, joinMonth: 1, includeStartCapital: false
    });
    const row1 = sim.result.rows.find(r => r.month === 1);
    close(row1.interest, 10000 * NF_RATES.high);
  });

  test('Eigene Einzahlungsschwelle stoppt die Einzahlung des Mitglieds dauerhaft, unabhängig vom Hauptszenario', () => {
    const v = baseMain({ nfDepositGoal: 0 });
    const sim = simulateTeamMember(v, {
      startCapital: 0, monthlyDeposit: 1000, joinMonth: 1, includeStartCapital: false,
      nfDepositStrategy: 'fixed', nfDepositGoal: 2000, nfDepositGoalThresholdBasis: 'capital'
    });
    const lastRow = sim.result.rows[sim.result.rows.length - 1];
    assert.ok(lastRow.active <= 2000 + 1e-6, `aktives Kapital ${lastRow.active} sollte die Schwelle nicht überschreiten`);
  });

  test('Eigene Auszahlung wirkt sich nur auf dieses Mitglied aus', () => {
    const v = baseMain();
    const sim = simulateTeamMember(v, {
      startCapital: 10000, monthlyDeposit: 0, joinMonth: 1, includeStartCapital: false,
      nfWithdrawalStrategy: 'fixed', nfWithdrawalAmount: 100, nfWithdrawalPeriod: 'monthly',
      nfWithdrawalMinCapital: 0, nfWithdrawalThresholdBasis: 'capital'
    });
    assert.ok(sim.result.totalWithdrawn > 0, 'sollte Auszahlungen erhalten haben');
  });

  test('Mitglied mit eigenem nfDepositStrategies-Array: mehrere Strategien summieren sich wie beim Hauptszenario', () => {
    const v = baseMain();
    const sim = simulateTeamMember(v, {
      startCapital: 0, joinMonth: 1, includeStartCapital: false,
      nfDepositStrategies: [
        depositStrategy({ id: 'a', kind: 'fixed', period: 'monthly', amount: 500, startMonth: 1 }),
        depositStrategy({ id: 'b', kind: 'fixed', period: 'once', amount: 2000, startMonth: 2 })
      ]
    });
    const row2 = sim.result.rows.find(r => r.month === 2);
    close(row2.deposit, 2500, 'Monat 2: 500 (laufend) + 2.000 (einmalig) sollten sich summieren');
  });

  test('Mitglied mit eigenem nfWithdrawalStrategies-Array: mehrere Strategien mit eigenem Start/Ende', () => {
    const v = baseMain();
    const sim = simulateTeamMember(v, {
      startCapital: 50000, joinMonth: 1, includeStartCapital: false,
      nfWithdrawalStrategies: [
        withdrawalStrategy({ id: 'a', type: 'monthly', amount: 100, startMonth: 1, stopMode: 'date', endMonth: 1 }),
        withdrawalStrategy({ id: 'b', type: 'once', amount: 500, startMonth: 3 })
      ]
    });
    close(sim.result.rows.find(r => r.month === 1).withdrawn, 100 * (1 - 0.035));
    close(sim.result.rows.find(r => r.month === 2).withdrawn, 0);
    close(sim.result.rows.find(r => r.month === 3).withdrawn, 500 * (1 - 0.035));
  });

  test('Array-Felder haben Vorrang vor den alten flachen Feldern, falls beide vorhanden sind', () => {
    const v = baseMain();
    const sim = simulateTeamMember(v, {
      startCapital: 0, joinMonth: 1, includeStartCapital: false,
      // Alte flache Felder wären 1000/Monat — sollten hier ignoriert werden.
      nfDepositStrategy: 'fixed', monthlyDeposit: 1000,
      nfDepositStrategies: [depositStrategy({ kind: 'fixed', period: 'monthly', amount: 300 })]
    });
    close(sim.result.rows.find(r => r.month === 1).deposit, 300);
  });
});

describe('migrateScenarioValues: migriert auch verschachtelte Team-Mitglieder', () => {
  test('Mitglied mit alten flachen Feldern wird beim Laden ins Array-Schema überführt, Simulationsergebnis bleibt gleich', () => {
    const oldMember = {
      id: 'tm1', name: 'Alt', level: 1, startCapital: 0, joinMonth: 1, includeStartCapital: false,
      nfDepositStrategy: 'fixed', monthlyDeposit: 400, nfMonthlyDepositPeriod: 'monthly',
      nfDepositGoal: 0, nfDepositGoalThresholdBasis: 'interest',
      nfWithdrawalStrategy: 'fixed', nfWithdrawalAmount: 0, nfWithdrawalPeriod: 'monthly',
      nfWithdrawalMinCapital: 0, nfWithdrawalThresholdBasis: 'interest'
    };
    const values = baseNextForrest({ nfTeamMembers: [oldMember] });
    const migrated = migrateScenarioValues(values);
    const migratedMember = migrated.nfTeamMembers[0];

    assert.ok(Array.isArray(migratedMember.nfDepositStrategies));
    assert.strictEqual(migratedMember.nfDepositStrategies[0].amount, 400);
    assert.strictEqual(migratedMember.nfDepositStrategy, undefined, 'alte Felder werden entfernt');
    assert.strictEqual(migratedMember.monthlyDeposit, undefined);

    const before = simulateTeamMember(values, oldMember);
    const after = simulateTeamMember(migrated, migratedMember);
    close(before.result.finalWealth, after.result.finalWealth);
  });
});

describe('Migration: flache Team-Liste → Baum', () => {
  test('Ebene 2 hängt unter dem zuletzt gesehenen Ebene-1-Eintrag', () => {
    const { members, migrated } = migrateTeamMembersToTree([
      { id: 'a', name: 'A', level: 1, startCapital: 1000, joinMonth: 1 },
      { id: 'a1', name: 'A1', level: 2, startCapital: 2000, joinMonth: 2 },
      { id: 'b', name: 'B', level: 1, startCapital: 3000, joinMonth: 1 },
      { id: 'b1', name: 'B1', level: 2, startCapital: 4000, joinMonth: 3 }
    ]);
    assert.strictEqual(migrated, true);
    assert.deepStrictEqual(members.map(m => m.name), ['A', 'B']);
    assert.deepStrictEqual(members[0].children.map(m => m.name), ['A1']);
    assert.deepStrictEqual(members[1].children.map(m => m.name), ['B1']);
  });

  test('Ebene 3 hängt unter dem zuletzt gesehenen Ebene-2-Eintrag', () => {
    const { members } = migrateTeamMembersToTree([
      { id: 'a', name: 'A', level: 1, startCapital: 1000, joinMonth: 1 },
      { id: 'a1', name: 'A1', level: 2, startCapital: 2000, joinMonth: 1 },
      { id: 'a1a', name: 'A1a', level: 3, startCapital: 3000, joinMonth: 1 }
    ]);
    assert.strictEqual(members[0].children[0].children[0].name, 'A1a');
  });

  test('Ein verwaister Ebene-2-Eintrag ohne vorherige Ebene 1 landet an der Wurzel', () => {
    const { members } = migrateTeamMembersToTree([
      { id: 'x', name: 'X', level: 2, startCapital: 1000, joinMonth: 1 }
    ]);
    assert.deepStrictEqual(members.map(m => m.name), ['X']);
    assert.strictEqual(members[0].level, undefined, 'level wird entfernt');
  });

  test('Eine reine Ebene-1-Liste gilt nicht als migriert', () => {
    const { migrated } = migrateTeamMembersToTree([
      { id: 'a', name: 'A', level: 1, startCapital: 1000, joinMonth: 1 },
      { id: 'b', name: 'B', level: 1, startCapital: 2000, joinMonth: 1 }
    ]);
    assert.strictEqual(migrated, false);
  });

  test('Die Beitrittsmonat-Regel gilt nach der Migration', () => {
    const { members } = migrateTeamMembersToTree([
      { id: 'a', name: 'A', level: 1, startCapital: 1000, joinMonth: 6 },
      { id: 'a1', name: 'A1', level: 2, startCapital: 2000, joinMonth: 2 }
    ]);
    assert.strictEqual(members[0].children[0].joinMonth, 6);
  });

  test('Ein bereits migrierter Baum bleibt unverändert', () => {
    const tree = [{ id: 'a', name: 'A', startCapital: 1000, joinMonth: 1, children: [] }];
    const { members, migrated } = migrateTeamMembersToTree(tree);
    assert.strictEqual(migrated, false);
    assert.deepStrictEqual(members.map(m => m.name), ['A']);
  });
});

describe('Baum-Hilfsfunktionen (walkTeam, clampTeamJoinMonths)', () => {
  function node(name, joinMonth, children) {
    return { id: name, name, joinMonth, startCapital: 1000, children: children || [] };
  }

  test('walkTeam läuft in Anzeigereihenfolge und zählt die Tiefe ab 1', () => {
    const tree = [
      node('A', 1, [node('A1', 2, [node('A1a', 3)]), node('A2', 2)]),
      node('B', 1)
    ];
    const seen = [];
    walkTeam(tree, (m, depth, parent) => {
      seen.push(`${m.name}:${depth}:${parent ? parent.name : '-'}`);
    });
    assert.deepStrictEqual(seen, [
      'A:1:-', 'A1:2:A', 'A1a:3:A1', 'A2:2:A', 'B:1:-'
    ]);
  });

  test('clampTeamJoinMonths zieht Kinder auf den Beitrittsmonat des Werbenden', () => {
    const tree = [node('A', 5, [node('A1', 2, [node('A1a', 1)])])];
    clampTeamJoinMonths(tree);
    assert.strictEqual(tree[0].joinMonth, 5);
    assert.strictEqual(tree[0].children[0].joinMonth, 5);
    assert.strictEqual(tree[0].children[0].children[0].joinMonth, 5);
  });

  test('clampTeamJoinMonths lässt spätere Beitritte unangetastet', () => {
    const tree = [node('A', 3, [node('A1', 7)])];
    clampTeamJoinMonths(tree);
    assert.strictEqual(tree[0].children[0].joinMonth, 7);
  });

  test('clampTeamJoinMonths erzwingt Monat 1 als Untergrenze', () => {
    const tree = [node('A', 0, [node('A1', -4)])];
    clampTeamJoinMonths(tree);
    assert.strictEqual(tree[0].joinMonth, 1);
    assert.strictEqual(tree[0].children[0].joinMonth, 1);
  });
});

describe('Rekursive Sub-Simulationen: jedes Mitglied verdient an seiner eigenen Downline', () => {
  function baseRec(overrides) {
    return {
      investmentType: 'nextforrest',
      start: 15000,
      includeStartCapital: false,
      currency: 'EUR',
      duration: 6,
      durationUnit: 'months',
      nfRate: 'low',
      nfDepositStrategies: [],
      nfWithdrawalStrategies: [],
      nfTeamMembers: [],
      ...overrides
    };
  }

  test('Ein Mitglied bekommt Tippgeber-Bonus für seine eigenen Geworbenen', () => {
    const v = baseRec({
      nfTeamMembers: [{
        id: 'a', name: 'A', startCapital: 2000, joinMonth: 1,
        includeStartCapital: true, children: [
          { id: 'b', name: 'B', startCapital: 3000, joinMonth: 1, includeStartCapital: true, children: [] }
        ]
      }]
    });
    const sim = simulateTeamMember(v, v.nfTeamMembers[0]);
    // B investiert 3.000 € = 3 Blöcke → A bekommt 3 × 50 € = 150 €
    assert.ok(sim.result.team, 'A muss ein eigenes team-Ergebnis haben');
    close(sim.result.team.totalTippgeberBonus, 150);
  });

  test('Der Beitrittsmonat eines Enkels wird auf die Zeitachse des Kindes umgerechnet', () => {
    const v = baseRec({
      duration: 12,
      nfTeamMembers: [{
        id: 'a', name: 'A', startCapital: 1000, joinMonth: 3,
        includeStartCapital: true, children: [
          { id: 'b', name: 'B', startCapital: 2000, joinMonth: 9, includeStartCapital: true, children: [] }
        ]
      }]
    });
    const sim = simulateTeamMember(v, v.nfTeamMembers[0]);
    // B tritt im Kalendermonat 9 bei, A im Monat 3 → lokal Monat 7.
    const row = sim.result.team.rows.find(r => r.month === 7);
    close(row.tippgeberBonus, 100); // 2 Blöcke × 50 €
    const vorher = sim.result.team.rows.find(r => r.month === 6);
    close(vorher.tippgeberBonus, 0);
  });

  test('Die Zeitachse stimmt auch über drei Ebenen, wenn niemand in Monat 1 beitritt', () => {
    const v = baseRec({
      duration: 18,
      nfTeamMembers: [{
        id: 'a', name: 'A', startCapital: 1000, joinMonth: 5, includeStartCapital: true, children: [
          { id: 'b', name: 'B', startCapital: 1000, joinMonth: 10, includeStartCapital: true, children: [
            // 20.000 € = 20 Blöcke → 1.000 € Tippgeber-Bonus an B, in einem
            // Schlag groß genug für einen vollen Block-Sweep bei B.
            { id: 'c', name: 'C', startCapital: 20000, joinMonth: 13, includeStartCapital: true, children: [] }
          ] }
        ]
      }]
    });
    const simA = simulateTeamMember(v, v.nfTeamMembers[0]);
    // B ist lokal zu A Monat 6 (Kalendermonat 10 minus A's 5, plus 1).
    // C ist lokal zu B Monat 4 (Kalendermonat 13 minus A's Versatz 5 ergibt
    // erst A-lokal Monat 9, davon B's bereits A-lokalen Beitrittsmonat 6
    // abgezogen ergibt Monat 4) — NICHT Monat 8, wie die fehlerhafte
    // einstufige Formel ergäbe, wenn sie C's noch unverändert kalendarischen
    // Monat direkt gegen B's schon lokalen Monat rechnet.
    //
    // Beobachtbar ist das nur über A: der Block-Sweep bei B (ausgelöst durch
    // C's Bonus) landet korrekt bei A-lokal Monat 9 (B-lokal Monat 4) und
    // erscheint ab der Folgezeile (openingActive) bei A-lokal Monat 10 als
    // Ebene-1-Kapital 2.000 € — fehlerhaft erst vier Monate später bei
    // A-lokal Monat 14.
    //
    // Geprüft wird jetzt e1Active statt teamVolume: seit die Ebenen aus dem
    // Baum kommen, zählt teamVolume auch C mit (2.000 € + 21.000 € =
    // 23.000 €). e1Active ist genau die Größe, die teamVolume hier früher
    // meinte — B's aktives Kapital — und bleibt damit derselbe Wächter
    // gegen einen Zeitachsen-Versatz.
    const row10 = simA.result.team.rows.find(r => r.month === 10);
    close(row10.e1Active, 2000);
    // C liegt aus A's Sicht auf Ebene 2 und ist zu diesem Zeitpunkt einen
    // Monat alt: 20.000 € plus der bereits reinvestierte erste Zinsblock.
    // Säße C zeitlich falsch, stünde hier noch 0.
    close(row10.e2Active, 21000);
  });

  test('Die Boni eines Mitglieds erhöhen sein aktives Kapital und damit mein Team-Volumen', () => {
    const ohneEnkel = simulateNextForrest(baseRec({
      duration: 10,
      nfTeamMembers: [{ id: 'a', name: 'A', startCapital: 2000, joinMonth: 1, includeStartCapital: true, children: [] }]
    }));
    const mitEnkel = simulateNextForrest(baseRec({
      duration: 10,
      nfTeamMembers: [{
        id: 'a', name: 'A', startCapital: 2000, joinMonth: 1, includeStartCapital: true,
        children: [{ id: 'b', name: 'B', startCapital: 3000, joinMonth: 1, includeStartCapital: true, children: [] }]
      }]
    }));
    const letzteOhne = ohneEnkel.team.rows[ohneEnkel.team.rows.length - 1];
    const letzteMit = mitEnkel.team.rows[mitEnkel.team.rows.length - 1];
    // A's own 100€/Monat Zinsen allein reichen in 10 Monaten noch nicht für
    // einen neuen 1000er-Block; A's Tippgeber-Bonus aus B (150 €) reicht.
    // Das ist an A's eigenem Kapital ablesbar, also an Ebene 1.
    close(letzteOhne.e1Active, 2000);
    close(letzteMit.e1Active, 3000);
    // Und es schlägt aufs Team-Volumen durch. Seit die Ebenen aus dem Baum
    // kommen, zählt es B mit: 3.000 € (A) + 4.000 € (B, das seinen eigenen
    // Zinsblock in Monat 7 gesweept hat) statt früher nur A's 3.000 €.
    close(letzteOhne.teamVolume, 2000);
    close(letzteMit.teamVolume, 7000);
  });

  test('Ab Tiefe 20 wird nicht weiter simuliert', () => {
    let tiefste = { id: 'n20', name: 'n20', startCapital: 1000, joinMonth: 1, includeStartCapital: true, children: [] };
    let wurzel = tiefste;
    for (let i = 19; i >= 1; i--) {
      wurzel = { id: 'n' + i, name: 'n' + i, startCapital: 1000, joinMonth: 1, includeStartCapital: true, children: [wurzel] };
    }
    const v = baseRec({ duration: 3, nfTeamMembers: [wurzel] });
    assert.strictEqual(simulateTeamMember(v, wurzel, MAX_TEAM_DEPTH + 1), null);
    assert.ok(simulateTeamMember(v, wurzel, 1), 'Tiefe 1 muss simuliert werden');
  });

  test('Ein Mitglied ohne Kinder hat weiterhin team === null', () => {
    const v = baseRec({
      nfTeamMembers: [{ id: 'a', name: 'A', startCapital: 2000, joinMonth: 1, includeStartCapital: true, children: [] }]
    });
    const sim = simulateTeamMember(v, v.nfTeamMembers[0]);
    assert.strictEqual(sim.result.team, null);
  });
});

describe('Ebenen-Aggregation aus dem Baum', () => {
  function baseLv(overrides) {
    return {
      investmentType: 'nextforrest', start: 15000, includeStartCapital: false,
      currency: 'EUR', duration: 3, durationUnit: 'months', nfRate: 'low',
      nfDepositStrategies: [], nfWithdrawalStrategies: [], nfTeamMembers: [],
      ...overrides
    };
  }
  const leaf = (id, cap) => ({ id, name: id, startCapital: cap, joinMonth: 1, includeStartCapital: true, children: [] });

  test('e1/e2/e3Active kommen aus der Baumtiefe, nicht aus einem Feld', () => {
    const r = simulateNextForrest(baseLv({
      nfTeamMembers: [{
        ...leaf('a', 1000),
        children: [{ ...leaf('b', 2000), children: [{ ...leaf('c', 3000), children: [leaf('d', 4000)] }] }]
      }]
    }));
    const row = r.team.rows.find(x => x.month === 2);
    close(row.e1Active, 1000, 'Ebene 1 = a');
    close(row.e2Active, 2000, 'Ebene 2 = b');
    close(row.e3Active, 3000, 'Ebene 3 = c');
    close(row.deepActive, 4000, 'Ebene 4+ = d');
    close(row.teamVolume, 10000, 'Team-Volumen über alle Ebenen');
  });

  test('Tippgeber-Bonus zahlt nur für die eigenen Direkten', () => {
    const r = simulateNextForrest(baseLv({
      nfTeamMembers: [{ ...leaf('a', 1000), children: [leaf('b', 5000)] }]
    }));
    // Nur a (1 Block) zählt für mich; b (5 Blöcke) zahlt an a, nicht an mich.
    close(r.team.rows.find(x => x.month === 1).tippgeberBonus, 50);
  });

  test('Jede Mitgliedszeile trägt den eigenen Rang des Mitglieds', () => {
    const r = simulateNextForrest(baseLv({
      nfTeamMembers: [{ ...leaf('a', 1000), children: [leaf('b', 2000)] }]
    }));
    const row = r.team.rows.find(x => x.month === 2);
    const a = row.members.find(m => m.id === 'a');
    assert.strictEqual(typeof a.ownRankIndex, 'number');
    assert.strictEqual(a.level, 1);
    const b = row.members.find(m => m.id === 'b');
    assert.strictEqual(b.level, 2);
  });

  test('joinMonth bleibt auch für tiefere Ebenen ein Kalendermonat', () => {
    // Jede Sub-Simulation rechnet in ihrer eigenen Zeitachse: B tritt aus
    // A's Sicht in Monat 3 bei (Kalender 5 minus A's 3, plus 1), C aus B's
    // Sicht in Monat 5. Ungerechnet würde die Monatsansicht für B und C zu
    // frühe Beitritte melden — deshalb wird beim Hochreichen jede Ebene
    // wieder auf Kalendermonate zurückgerechnet.
    const r = simulateNextForrest(baseLv({
      duration: 12,
      nfTeamMembers: [{
        ...leaf('a', 1000), joinMonth: 3, children: [{
          ...leaf('b', 2000), joinMonth: 5, children: [
            { ...leaf('c', 3000), joinMonth: 9 }
          ]
        }]
      }]
    }));
    const row = r.team.rows.find(x => x.month === 10);
    const bei = id => row.members.find(m => m.id === id).joinMonth;
    assert.strictEqual(bei('a'), 3, 'A: Ebene 1, schon immer kalendarisch');
    assert.strictEqual(bei('b'), 5, 'B: 3 in A\'s Achse → 5 im Kalender');
    assert.strictEqual(bei('c'), 9, 'C: 5 in B\'s Achse → 7 in A\'s → 9 im Kalender');
  });
});

// ---------------------------------------------------------------------------
// Die zentralen Zusicherungen des Baum-Umbaus. Bis hierher standen sie nur als
// Prosa im Entwurf bzw. als Kommentar im Code — ab jetzt sind sie erzwungen.
// ---------------------------------------------------------------------------
describe('Abgleich: Mitgliedszeilen, Ebenen-Zwischensummen und Team-Volumen', () => {
  function baseAbgleich(overrides) {
    return {
      investmentType: 'nextforrest', start: 30000, includeStartCapital: false,
      currency: 'EUR', duration: 24, durationUnit: 'months', nfRate: 'low',
      nfDepositStrategies: [], nfWithdrawalStrategies: [], nfTeamMembers: [],
      ...overrides
    };
  }
  const n = (id, cap, joinMonth, children) => ({
    id, name: id, startCapital: cap, joinMonth,
    includeStartCapital: true, children: children || []
  });

  // Fünf Ebenen tief, ungleich verzweigt, gestaffelte Beitrittsmonate, zwei
  // Wurzeln. Genau die Form, bei der ein Fehler im Zeitachsen-Rebasing oder
  // in der Ebenen-Verschiebung auffallen würde.
  const baum = () => [
    n('A', 20000, 1, [
      n('B', 15000, 2, [
        n('D', 9000, 4, [
          n('G', 5000, 6, [n('J', 3000, 9)]),
          n('H', 4000, 7),
        ]),
        n('E', 7000, 5),
      ]),
      n('C', 12000, 3),
    ]),
    n('F', 11000, 8, [n('I', 6000, 10)]),
  ];

  test('Ebenen-Zwischensummen und Team-Volumen gehen in JEDEM Monat auf', () => {
    const r = simulateNextForrest(baseAbgleich({ nfTeamMembers: baum() }));
    assert.ok(r.team.rows.length >= 24, 'Es sollen alle Monate geprüft werden');

    for (const row of r.team.rows) {
      const proEbene = (lvl) => row.members
        .filter(m => m.level === lvl)
        .reduce((acc, m) => acc + (m.activeBase || 0), 0);
      const abEbene4 = row.members
        .filter(m => m.level >= 4)
        .reduce((acc, m) => acc + (m.activeBase || 0), 0);

      close(proEbene(1), row.e1Active, `Monat ${row.month}: Ebene 1`);
      close(proEbene(2), row.e2Active, `Monat ${row.month}: Ebene 2`);
      close(proEbene(3), row.e3Active, `Monat ${row.month}: Ebene 3`);
      close(abEbene4, row.deepActive, `Monat ${row.month}: Ebene 4+`);
      close(
        row.e1Active + row.e2Active + row.e3Active + row.deepActive,
        row.teamVolume,
        `Monat ${row.month}: Ebenen summieren sich zum Team-Volumen`
      );
    }
  });

  // Vertrag aus dem Entwurf: `tippgeberBonus` einer Mitgliedszeile ist, was
  // dieses Mitglied SEINEM Werbenden eingebracht hat. Nur auf Ebene 1 bin das
  // ich. Die Spalte summiert sich deshalb bewusst NICHT auf den Monatswert —
  // wer sie über alle Ebenen addiert, zählt fremdes Geld mit.
  test('tippgeberBonus summiert sich nur über Ebene 1 auf den Monatswert', () => {
    const r = simulateNextForrest(baseAbgleich({ nfTeamMembers: baum() }));
    const summe = (row, filter) => row.members
      .filter(filter)
      .reduce((acc, m) => acc + (m.tippgeberBonus || 0), 0);

    let hatTiefereBoni = false;
    for (const row of r.team.rows) {
      close(
        summe(row, m => m.level === 1),
        row.tippgeberBonus,
        `Monat ${row.month}: Ebene 1 ergibt meinen Tippgeber-Bonus`
      );
      if (summe(row, () => true) > row.tippgeberBonus + EPS) hatTiefereBoni = true;
    }

    assert.ok(
      hatTiefereBoni,
      'Auf diesem Baum muss es Monate geben, in denen tiefere Ebenen eigene ' +
      'Tippgeber-Boni erzeugen — sonst prüft der Test den Vertrag gar nicht'
    );
  });

  test('Tiefe 20 wird noch simuliert, Tiefe 21 nicht mehr', () => {
    const kette = (laenge) => {
      let knoten = n('n' + laenge, 1000, 1);
      for (let i = laenge - 1; i >= 1; i--) knoten = n('n' + i, 1000, 1, [knoten]);
      return [knoten];
    };

    const bei20 = simulateNextForrest(baseAbgleich({ duration: 3, nfTeamMembers: kette(20) }));
    const zeile20 = bei20.team.rows.find(x => x.month === 1);
    assert.strictEqual(zeile20.members.length, 20, 'Eine 20er-Kette ergibt 20 Mitglieder');
    assert.strictEqual(
      Math.max(...zeile20.members.map(m => m.level)), 20,
      'Die tiefste Ebene ist 20 — eine Regression von > auf >= bei MAX_TEAM_DEPTH würde sie abschneiden'
    );

    const bei21 = simulateNextForrest(baseAbgleich({ duration: 3, nfTeamMembers: kette(21) }));
    const zeile21 = bei21.team.rows.find(x => x.month === 1);
    assert.strictEqual(zeile21.members.length, 20, 'Eine 21er-Kette bleibt bei 20 Mitgliedern');
  });
});

describe('Zusammenrechnen mit dem eigenen Investment (mergedTeamMembers, buildCombinedRows, combinedScenarioTotals)', () => {
  const blatt = (id, cap, extra) => ({
    id, name: id, startCapital: cap, joinMonth: 1,
    includeStartCapital: true, children: [], ...extra
  });

  function werte(overrides) {
    return {
      investmentType: 'nextforrest', start: 20000, includeStartCapital: false,
      currency: 'EUR', duration: 12, durationUnit: 'months', nfRate: 'low',
      nfDepositStrategies: [], nfWithdrawalStrategies: [],
      nfTeamMembers: [
        { ...blatt('a', 5000), children: [
          { ...blatt('b', 4000), children: [blatt('c', 3000, { mergeWithOwn: true })] }
        ] },
        blatt('d', 6000, { mergeWithOwn: true }),
      ],
      ...overrides
    };
  }

  // Das Häkchen "Mit meinem Investment zusammenrechnen" steht in der
  // Eingabemaske JEDES Mitglieds, nicht nur bei den eigenen Direkten. Solange
  // nur die Wurzelliste durchsucht wurde, war es ab Ebene 2 wirkungslos.
  test('Ein Mitglied auf Ebene 3 mit mergeWithOwn wird zusammengerechnet', () => {
    const v = werte();
    const r = simulateNextForrest(v);

    assert.deepStrictEqual(
      mergedTeamMembers(v, r).map(m => m.id), ['c', 'd'],
      'c hängt auf Ebene 3 und muss trotzdem gefunden werden'
    );

    const kombiniert = buildCombinedRows(v, r);
    const letzte = kombiniert[kombiniert.length - 1];
    assert.deepStrictEqual(letzte.members.map(m => m.id), ['c', 'd']);
    assert.strictEqual(letzte.members.find(m => m.id === 'c').level, 3);
  });

  test('Ohne angehaktes Mitglied bleibt alles beim Alten (null als No-Op-Signal)', () => {
    const v = werte({ nfTeamMembers: [blatt('a', 5000)] });
    const r = simulateNextForrest(v);
    assert.deepStrictEqual(mergedTeamMembers(v, r), []);
    assert.strictEqual(buildCombinedRows(v, r), null);
    assert.strictEqual(combinedScenarioTotals(r, null, [], v), null);
  });

  test('Klassische Szenarien ohne result.team liefern sofort []', () => {
    const v = baseClassic();
    assert.deepStrictEqual(mergedTeamMembers(v, simulate(v)), []);
  });

  test('Die kombinierte Zeile ist feldweise die Summe aus eigener Zeile und Mitgliedern', () => {
    const v = werte();
    const r = simulateNextForrest(v);
    const kombiniert = buildCombinedRows(v, r);

    const FELDER = ['openingActive', 'deposit', 'withdrawn', 'interest', 'reinvested', 'cash', 'fee', 'active', 'total'];
    for (const { month, own, members, combined } of kombiniert) {
      for (const feld of FELDER) {
        const erwartet = (own[feld] || 0) + members.reduce((acc, m) => acc + (m.row[feld] || 0), 0);
        close(combined[feld], erwartet, `Monat ${month}, Feld ${feld}`);
      }
    }
  });

  test('Die kombinierten Gesamtsummen gehen auf', () => {
    const v = werte();
    const r = simulateNextForrest(v);
    const kombiniert = buildCombinedRows(v, r);
    const merged = mergedTeamMembers(v, r);
    const summen = combinedScenarioTotals(r, kombiniert, merged, v);
    const letzte = kombiniert[kombiniert.length - 1].combined;

    close(summen.finalWealth, letzte.total, 'Endvermögen ist die letzte kombinierte Zeile');
    close(summen.activeCapital, letzte.active);
    close(summen.cash, letzte.cash);
    close(summen.finalWealth, summen.activeCapital + summen.cash);

    // Zinsen und Gebühren sind die eigenen plus die der zusammengerechneten
    // Mitglieder — nachgerechnet direkt aus den Monatszeilen.
    const ausZeilen = (feld) => kombiniert.reduce(
      (acc, { members }) => acc + members.reduce((s, m) => s + (m.row[feld] || 0), 0), 0
    );
    close(summen.totalInterest, r.totalInterest + ausZeilen('interest'), 'Zinsen');
    close(summen.totalFees, r.totalFees + ausZeilen('fee'), 'Gebühren');
    close(summen.totalDeposits, r.totalDeposits + ausZeilen('deposit'), 'Einzahlungen');

    // Und sie liegen über den reinen Eigenwerten — sonst würde der Test auch
    // dann grün, wenn das Zusammenrechnen gar nicht greift.
    assert.ok(summen.finalWealth > r.finalWealth, 'Zusammenrechnen erhöht das Endvermögen');
  });
});

describe('Migrationshinweis und beschädigte gespeicherte Daten', () => {
  test('nfTeamTreeMigrated überlebt das zweite Laden', () => {
    const alt = {
      investmentType: 'nextforrest', start: 10000, duration: 12, durationUnit: 'months',
      nfTeamMembers: [
        { id: 'a', name: 'A', level: 1, startCapital: 1000, joinMonth: 1 },
        { id: 'b', name: 'B', level: 2, startCapital: 1000, joinMonth: 1 },
      ],
    };

    const ersterLauf = migrateScenarioValues({ ...alt });
    assert.strictEqual(ersterLauf.nfTeamTreeMigrated, true, 'Erstes Laden setzt das Flag');

    // Zweites Laden: das Szenario ist bereits ein Baum, tree.migrated also
    // false. Das Flag darf davon nicht zurückgesetzt werden, sonst
    // verschwände der Hinweis, ohne dass der Nutzer die Struktur angefasst hat.
    const zweiterLauf = migrateScenarioValues({ ...ersterLauf });
    assert.strictEqual(zweiterLauf.nfTeamTreeMigrated, true, 'Zweites Laden behält das Flag');

    // Gelöscht wird es ausschließlich durch eine Handlung des Nutzers
    // (markTeamStructureTouched() in index.html setzt es auf false).
    const nachBearbeitung = migrateScenarioValues({ ...zweiterLauf, nfTeamTreeMigrated: false });
    assert.strictEqual(nachBearbeitung.nfTeamTreeMigrated, false, 'Einmal angefasst bleibt es aus');
  });

  test('Ein Szenario ohne Migration bekommt kein Flag', () => {
    const v = migrateScenarioValues({
      investmentType: 'nextforrest', start: 10000, duration: 12, durationUnit: 'months',
      nfTeamMembers: [{ id: 'a', name: 'A', startCapital: 1000, joinMonth: 1, children: [] }],
    });
    assert.ok(!v.nfTeamTreeMigrated);
  });

  test('Ein null-Eintrag in der gespeicherten Mitgliederliste wirft nicht', () => {
    // Vor der Baum-Umstellung überlebte dieser Fall, weil jeder Eintrag über
    // `{...raw}` kopiert wurde. Ein Wurf hier reißt beim Laden die ganze Seite
    // mit (loadState() läuft im Bootstrap), inklusive Zurücksetzen-Knopf.
    let v;
    assert.doesNotThrow(() => {
      v = migrateScenarioValues({
        investmentType: 'nextforrest', start: 10000, duration: 12, durationUnit: 'months',
        nfTeamMembers: [null, { id: 'a', name: 'A', level: 1, startCapital: 1000, joinMonth: 1 }],
      });
    });
    assert.deepStrictEqual(v.nfTeamMembers.map(m => m.id), ['a'], 'Der Schrott-Eintrag fällt weg');
    assert.doesNotThrow(() => simulateNextForrest(v), 'und das Ergebnis rechnet weiter');
  });

  test('Ein null-Eintrag in einem bereits migrierten Baum wirft ebenfalls nicht', () => {
    let v;
    assert.doesNotThrow(() => {
      v = migrateScenarioValues({
        investmentType: 'nextforrest', start: 10000, duration: 12, durationUnit: 'months',
        nfTeamMembers: [null, { id: 'a', name: 'A', startCapital: 1000, joinMonth: 1, children: [] }],
      });
    });
    assert.deepStrictEqual(v.nfTeamMembers.map(m => m.id), ['a']);
  });

  test('walkTeam überspringt leere Einträge', () => {
    const gesehen = [];
    walkTeam([null, { id: 'a', children: [null, { id: 'b', children: [] }] }], (m) => gesehen.push(m.id));
    assert.deepStrictEqual(gesehen, ['a', 'b']);
  });
});
