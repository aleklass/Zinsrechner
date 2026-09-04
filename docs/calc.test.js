const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { simulate, simulateNextForrest, runSimulation, simulateTeamMember, NF_RATES } = require('./calc.js');

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

describe('Team-Struktur / Rangsystem (simulateNextForrest.team)', () => {
  function baseTeam(overrides) {
    return baseNextForrest({
      start: 15000,
      includeStartCapital: false,
      duration: 1,
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

  test('Tippgeber-Bonus: 50 € pro 1000er-Block, einmalig, nur für Ebene-1-Empfehlungen, unabhängig vom Rang', () => {
    const r = simulateNextForrest(baseTeam({
      duration: 6,
      nfTeamMembers: [
        { name: 'Ebene1', level: 1, startCapital: 3000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene2', level: 2, startCapital: 5000, monthlyDeposit: 0, joinMonth: 1 }
      ]
    }));
    const byMonth = m => r.team.rows.find(row => row.month === m);
    // Kein Monat 0 mehr — alle Bonuszahlungen laufen ab Monat 1. Ebene 1:
    // 3.000 € Startkapital = 3 Blöcke → 3 × 50 € = 150 €, im tatsächlichen
    // Beitrittsmonat 1. Ebene 2 zählt hier nicht mit, da sie nicht direkt
    // vom Szenario-Inhaber geworben wurde.
    assert.strictEqual(byMonth(0), undefined);
    assert.strictEqual(byMonth(1).rank, 'Forrest Member');
    close(byMonth(1).tippgeberBonus, 150);
    close(byMonth(2).tippgeberBonus, 0);
    close(r.team.totalTippgeberBonus, 150);
  });

  test('Tippgeber-Bonus wird im tatsächlichen Beitrittsmonat der Empfehlung gutgeschrieben', () => {
    const r = simulateNextForrest(baseTeam({
      duration: 6,
      nfTeamMembers: [
        { name: 'Spaeteinsteiger', level: 1, startCapital: 2000, monthlyDeposit: 0, joinMonth: 4 }
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
        { name: 'Ebene1', level: 1, startCapital: 100000, monthlyDeposit: 0, joinMonth: 1 }
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
        { name: 'Ebene1', level: 1, startCapital: 50000, monthlyDeposit: 0, joinMonth: 1, includeStartCapital: false }
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
        { name: 'Ebene1', level: 1, startCapital: 50000, monthlyDeposit: 1000, joinMonth: 1, includeStartCapital: false }
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
        { name: 'Ebene1', level: 1, startCapital: 500000, monthlyDeposit: 0, joinMonth: 1 }
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
        { name: 'Ebene1', level: 1, startCapital: 150000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene2', level: 2, startCapital: 60000, monthlyDeposit: 0, joinMonth: 1 }
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
        { name: 'Ebene1', level: 1, startCapital: 150000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene2', level: 2, startCapital: 100000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene3', level: 3, startCapital: 60000, monthlyDeposit: 0, joinMonth: 1 }
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
        { name: 'Ebene1', level: 1, startCapital: 200000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene2', level: 2, startCapital: 200000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene3', level: 3, startCapital: 200000, monthlyDeposit: 0, joinMonth: 1 }
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
        { name: 'Ebene1', level: 1, startCapital: 400000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene2', level: 2, startCapital: 400000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene3', level: 3, startCapital: 200000, monthlyDeposit: 0, joinMonth: 1 }
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
        { name: 'Ebene1', level: 1, startCapital: 2000, monthlyDeposit: 0, joinMonth: 1 }
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
        { name: 'Ebene1', level: 1, startCapital: 150000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene2', level: 2, startCapital: 100000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene3', level: 3, startCapital: 60000, monthlyDeposit: 0, joinMonth: 1 }
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
        { name: 'Ebene1', level: 1, startCapital: 150000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Ebene2', level: 2, startCapital: 100000, monthlyDeposit: 0, joinMonth: 1 }
      ]
    });
    const withTeam = simulateNextForrest(values);
    const withoutTeam = simulateNextForrest({ ...values, nfTeamMembers: [] });
    close(withTeam.finalWealth - withoutTeam.finalWealth, withTeam.team.totalBonus);
  });

  test('Jede Monatszeile führt eine members-Liste mit der Momentaufnahme jedes aktiven Mitglieds', () => {
    const r = simulateNextForrest(baseTeam({
      duration: 2,
      nfTeamMembers: [
        { name: 'Ebene1', level: 1, startCapital: 3000, monthlyDeposit: 0, joinMonth: 1 },
        { name: 'Spaeteinsteiger', level: 1, startCapital: 1000, monthlyDeposit: 0, joinMonth: 2 }
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
      nfDepositStrategy: 'fixed',
      nfMonthlyDeposit: 0,
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
      nfDepositGoal: 2000, nfDepositGoalThresholdBasis: 'capital'
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
});
