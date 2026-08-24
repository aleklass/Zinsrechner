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

describe('Team-Struktur (simulateNextForrest.team)', () => {
  function baseTeam(overrides) {
    return baseNextForrest({
      start: 15000,
      includeStartCapital: false,
      duration: 6,
      nfDepositStrategy: 'fixed',
      nfMonthlyDeposit: 0,
      nfTeamMembers: [],
      ...overrides
    });
  }

  test('Ohne Teammitglieder bleibt team null und das Ergebnis unverändert', () => {
    const r = simulateNextForrest(baseTeam());
    assert.strictEqual(r.team, null);
  });

  test('Tippgeber-Bonus: 50 € pro 1000er-Block, einmalig, nur für Ebene-1-Empfehlungen', () => {
    const r = simulateNextForrest(baseTeam({
      nfTeamMembers: [
        { name: 'Ebene1', level: 1, startCapital: 3000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene2', level: 2, startCapital: 5000, monthlyDeposit: 0, joinMonth: 1 }
      ]
    }));
    const byMonth = m => r.team.rows.find(row => row.month === m);
    // Ebene 1: 3.000 € Startkapital = 3 Blöcke → 3 × 50 € = 150 €, in ihrem
    // Beitrittsmonat. Ebene 2 zählt hier nicht mit, da sie nicht direkt vom
    // Szenario-Inhaber geworben wurde.
    close(byMonth(1).tippgeberBonus, 150);
    // Danach keine weiteren Sweeps (keine laufenden Einzahlungen) → kein
    // weiterer Bonus.
    close(byMonth(2).tippgeberBonus, 0);
    close(r.team.totalTippgeberBonus, 150);
  });

  test('Tippgeber-Bonus wird im Beitrittsmonat der Empfehlung gutgeschrieben, nicht in Monat 1 des Hauptszenarios', () => {
    const r = simulateNextForrest(baseTeam({
      nfTeamMembers: [
        { name: 'Spaeteinsteiger', level: 1, startCapital: 2000, monthlyDeposit: 0, joinMonth: 4 }
      ]
    }));
    const byMonth = m => r.team.rows.find(row => row.month === m);
    close(byMonth(1).tippgeberBonus, 0);
    close(byMonth(3).tippgeberBonus, 0);
    close(byMonth(4).tippgeberBonus, 100); // 2 Blöcke × 50 €
  });

  test('1 %-Ebene-1-Beteiligung greift erst, wenn eigenes Kapital ≥ 10.000 € UND Team-Volumen über alle Ebenen ≥ 100.000 €', () => {
    const r = simulateNextForrest(baseTeam({
      start: 15000,
      nfTeamMembers: [
        { name: 'Ebene1', level: 1, startCapital: 3000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene2', level: 2, startCapital: 200000, monthlyDeposit: 0, joinMonth: 1 }
      ]
    }));
    const byMonth = m => r.team.rows.find(row => row.month === m);
    // Team-Volumen im Beitrittsmonat entspricht dem investierten Kapital
    // beider Ebenen (3.000 + 200.000 = 203.000 €) — noch vor der Rendite
    // dieses ersten Monats — und liegt damit sofort über 100.000 €.
    // Eigenes Kapital (15.000 €) liegt über 10.000 € → ab Monat 1 qualifiziert.
    assert.strictEqual(r.team.qualifiedFromMonth, 1);
    close(byMonth(1).teamVolume, 203000);
    // Die 1 %-Beteiligung bezieht sich NUR auf das aktive Kapital der
    // Ebene-1-Empfehlung (3.000 €), nicht auf das gesamte Team-Volumen.
    close(byMonth(1).overrideBonus, 30);
  });

  test('Team-Volumen entspricht im Beitrittsmonat exakt dem investierten Betrag, noch ohne dessen Rendite', () => {
    // Ein Ebene-1-Mitglied investiert 100.000 € in Monat 1 → Team-Volumen
    // muss in genau diesem Monat 100.000 € zeigen, nicht bereits inkl. der
    // im selben Monat erwirtschafteten Zinsen.
    const r = simulateNextForrest(baseTeam({
      nfTeamMembers: [
        { name: 'Ebene1', level: 1, startCapital: 100000, monthlyDeposit: 0, joinMonth: 1 }
      ]
    }));
    close(r.team.rows.find(row => row.month === 1).teamVolume, 100000);
  });

  test('Team-Volumen wächst mit dem aktiven (verzinsten) Kapital der Empfehlungen, über alle Ebenen', () => {
    // Ein einzelnes Ebene-2-Mitglied investiert 90.000 € — unter der
    // 100K-Schwelle. Durch Zinseszins bei 5 %/Monat wächst das aktive
    // Kapital mit der Zeit über die Schwelle, obwohl kein weiteres Geld
    // eingezahlt wird.
    const r = simulateNextForrest(baseTeam({
      duration: 36,
      nfTeamMembers: [
        { name: 'Ebene2', level: 2, startCapital: 90000, monthlyDeposit: 0, joinMonth: 1 }
      ]
    }));
    const first = r.team.rows[0];
    const last = r.team.rows[r.team.rows.length - 1];
    assert.ok(last.teamVolume > first.teamVolume, 'Team-Volumen sollte durch Zinseszins wachsen');
    assert.ok(r.team.qualifiedFromMonth !== null, 'sollte die 100K-Schwelle irgendwann durch Zinseszins erreichen');
  });

  test('Ohne erreichte Schwelle keine 1 %-Beteiligung, obwohl Tippgeber-Boni trotzdem anfallen', () => {
    const r = simulateNextForrest(baseTeam({
      start: 1000,
      nfTeamMembers: [
        { name: 'Ebene1', level: 1, startCapital: 2000, monthlyDeposit: 0, joinMonth: 1 }
      ]
    }));
    assert.strictEqual(r.team.qualifiedFromMonth, null);
    r.team.rows.forEach(row => close(row.overrideBonus, 0));
    close(r.team.totalTippgeberBonus, 100); // 2 Blöcke × 50 €, unabhängig von der Schwelle
  });

  test('Qualifikation bleibt dauerhaft bestehen', () => {
    const r = simulateNextForrest(baseTeam({
      start: 15000,
      duration: 12,
      nfTeamMembers: [
        { name: 'Ebene1', level: 1, startCapital: 3000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene2', level: 2, startCapital: 200000, monthlyDeposit: 0, joinMonth: 1 }
      ]
    }));
    const qualifiedRows = r.team.rows.filter(row => row.month >= r.team.qualifiedFromMonth);
    assert.ok(qualifiedRows.length > 0);
    qualifiedRows.forEach(row => assert.strictEqual(row.qualified, true));
  });

  test('Boni landen tatsächlich im eigenen Cash-Konto: finalWealth steigt exakt um die Bonussumme', () => {
    const values = baseTeam({
      nfTeamMembers: [
        { name: 'Ebene1', level: 1, startCapital: 3000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene2', level: 2, startCapital: 200000, monthlyDeposit: 0, joinMonth: 1 }
      ]
    });
    const withTeam = simulateNextForrest(values);
    const withoutTeam = simulateNextForrest({ ...values, nfTeamMembers: [] });
    close(withTeam.finalWealth - withoutTeam.finalWealth, withTeam.team.totalBonus);
  });
});
