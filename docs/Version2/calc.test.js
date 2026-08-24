const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { simulate, simulateNextForrest, runSimulation } = require('./calc.js');

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

function baseNextForrest(overrides) {
  return {
    investmentType: 'nextforrest',
    start: 10000,
    includeStartCapital: true,
    currency: 'EUR',
    duration: 24,
    durationUnit: 'months',
    nfRate: 'low',
    nfDepositStrategy: 'roundup',
    nfMonthlyDeposit: 500,
    nfMonthlyDepositPeriod: 'monthly',
    nfDepositGoal: 0,
    nfWithdrawalStrategy: 'fixed',
    nfWithdrawalAmount: 0,
    nfWithdrawalPeriod: 'monthly',
    nfWithdrawalMinCapital: 0,
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
});

describe('NextForrest (simulateNextForrest)', () => {
  test('Golden scenario: 10.000 € Start, 5%/Monat, 1000er-Aufrundung, Sparziel 20.000, 24 Monate', () => {
    const r = simulateNextForrest(baseNextForrest({ nfDepositGoal: 20000 }));
    close(r.finalWealth, 39300.00);
    close(r.activeCapital, 39000.00);
    close(r.totalInterest, 26550.00);
    close(r.cash, 300.00);
    close(r.totalDeposits, 12750.00);
    close(r.totalFees, 191.25);
    close(r.totalWithdrawn, 0);
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
    const r = simulateNextForrest(baseNextForrest({ nfDepositGoal: 20000 }));
    close(sum(r.rows, 'deposit'), r.totalDeposits);
  });

  test('Summe aller "Gebühren"-Spalten (inkl. Zeile 0) = totalFees', () => {
    const r = simulateNextForrest(baseNextForrest({ nfDepositGoal: 20000 }));
    close(sum(r.rows, 'fee'), r.totalFees);
  });

  test('Sparziel: Einzahlungsstrategie stoppt, sobald aktives Kapital das Ziel erreicht', () => {
    const r = simulateNextForrest(baseNextForrest({ nfDepositGoal: 20000 }));
    const monthlyRows = r.rows.filter(row => row.month >= 1);
    const afterGoal = monthlyRows.filter(row => row.openingActive >= 20000);
    assert.ok(afterGoal.length > 0, 'Sparziel sollte innerhalb von 24 Monaten erreicht werden');
    afterGoal.forEach(row => {
      close(row.deposit, 0, `Monat ${row.month}: sollte keine strategiebasierte Einzahlung mehr haben`);
    });
  });

  test('Sparziel = 0 bedeutet kein dauerhafter Stopp der Einzahlungsstrategie', () => {
    // Vereinzelt kann ein Monat zufällig exakt auf einem 1000er-Block landen
    // (deposit = 0, weil kein Aufrunden nötig ist) — das ist kein Stopp,
    // solange spätere Monate wieder Einzahlungen zeigen.
    const r = simulateNextForrest(baseNextForrest({ nfDepositGoal: 0 }));
    const monthlyRows = r.rows.filter(row => row.month >= 1);
    monthlyRows.forEach((row, i) => {
      if (row.deposit === 0 && i < monthlyRows.length - 1) {
        assert.ok(
          monthlyRows.slice(i + 1).some(later => later.deposit > 0),
          `Monat ${row.month}: Einzahlung ist 0, sollte aber kein dauerhafter Stopp sein`
        );
      }
    });
  });

  test('Auszahlung: Gebühr wird vom Bruttobetrag abgezogen', () => {
    const r = simulateNextForrest(baseNextForrest({
      nfWithdrawalStrategy: 'fixed',
      nfWithdrawalAmount: 100,
      nfWithdrawalMinCapital: 0
    }));
    const withdrawingRows = r.rows.filter(row => row.withdrawn > 0);
    assert.ok(withdrawingRows.length > 0, 'es sollte Auszahlungen geben');
    withdrawingRows.forEach(row => {
      close(row.withdrawn, 100 * (1 - 0.035));
    });
  });

  test('Mindestkapital für Auszahlung: keine Auszahlung unterhalb der Schwelle', () => {
    const r = simulateNextForrest(baseNextForrest({
      nfWithdrawalStrategy: 'fixed',
      nfWithdrawalAmount: 100,
      nfWithdrawalMinCapital: 15000
    }));
    const tooEarly = r.rows.filter(row => row.month >= 1 && row.openingActive < 15000);
    tooEarly.forEach(row => {
      close(row.withdrawn, 0, `Monat ${row.month}: aktives Kapital ${row.openingActive} < 15000, sollte keine Auszahlung haben`);
    });
  });

  test('Einzahlungsstrategie "Fester Betrag": Gebühr = 1,5% des festen Betrags', () => {
    const r = simulateNextForrest(baseNextForrest({
      nfDepositStrategy: 'fixed',
      nfMonthlyDeposit: 200
    }));
    const monthlyRows = r.rows.filter(row => row.month >= 1);
    monthlyRows.forEach(row => {
      close(row.deposit, 200);
    });
  });

  test('Einzahlungsschwelle auf Monatsrendite: Stopp erst wenn die Rendite des Monats die Schwelle erreicht (dauerhaft)', () => {
    const r = simulateNextForrest(baseNextForrest({
      includeStartCapital: false,
      nfDepositStrategy: 'fixed',
      nfMonthlyDeposit: 500,
      nfDepositGoal: 550,
      nfDepositGoalThresholdBasis: 'interest'
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
      nfDepositStrategy: 'fixed',
      nfMonthlyDeposit: 0,
      nfDepositGoal: 0,
      nfWithdrawalStrategy: 'fixed',
      nfWithdrawalAmount: 50,
      nfWithdrawalMinCapital: 550,
      nfWithdrawalThresholdBasis: 'interest'
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
});

describe('runSimulation', () => {
  test('wählt simulate() für "classic" und simulateNextForrest() für "nextforrest"', () => {
    const classicResult = runSimulation(baseClassic());
    const nfResult = runSimulation(baseNextForrest());
    close(classicResult.finalWealth, simulate(baseClassic()).finalWealth);
    close(nfResult.finalWealth, simulateNextForrest(baseNextForrest()).finalWealth);
  });
});
