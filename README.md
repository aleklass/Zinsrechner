# Zinseszinsrechner mit Szenarien

Ein vollständig lokaler Zinseszinsrechner als einzelne HTML-Datei. Mit dem Rechner lassen sich verschiedene Rendite- und Einzahlungsszenarien simulieren und über die gesamte Laufzeit vergleichen.

## Funktionen

- Berechnung des Gesamtvermögens über Monate oder Jahre
- Frei wählbares Startkapital und Währung
- Monatlicher oder jährlicher Zinssatz beziehungsweise Rendite
- Regelmäßige monatliche oder jährliche Einzahlungen
- Einzahlung am Monatsanfang oder Monatsende
- Monatliche, vierteljährliche oder jährliche Zinsgutschrift
- Zwei Reinvestitionsmodi:
  - Alle verfügbaren Zinsen sofort reinvestieren
  - Nur volle 1.000er-Beträge reinvestieren
- Vergleich von bis zu sechs Startkapital-Szenarien
- Grafische Darstellung der Kapitalentwicklung
- Monatliche Detailtabelle mit Kapital, Einzahlungen, Zinsen und Reserven
- Automatische Speicherung der zuletzt verwendeten Eingaben im Browser
- Zurücksetzen auf die Standardwerte
- Responsive Darstellung für Desktop und mobile Geräte

## Verwendung

1. Die Datei `Zinseszinsrechner mit Szenarien.html` herunterladen.
2. Die Datei per Doppelklick in einem modernen Webbrowser öffnen.
3. Startkapital, Zinssatz, Laufzeit und weitere Parameter eingeben.
4. Für den Szenariovergleich mehrere Startkapitalwerte durch Kommas getrennt eintragen.
5. Die Ergebnisse werden automatisch aktualisiert oder können über **Berechnen** neu berechnet werden.

Es ist kein Webserver, keine Installation und keine Internetverbindung erforderlich.

## Berechnungsmodell

Der Rechner simuliert die Entwicklung des Kapitals monatlich. Abhängig von den Einstellungen werden Zinsen monatlich, vierteljährlich oder jährlich gutgeschrieben. Einzahlungen werden zunächst in einer separaten Einzahlungsreserve gesammelt.

Im Modus **Alle Zinsen sofort reinvestieren** werden verfügbare Zinsreserven direkt dem aktiv verzinsten Kapital hinzugefügt. Im Modus **Nur volle 1.000 reinvestieren** werden Zins- und Einzahlungsreserven kombiniert; nur vollständige 1.000er-Blöcke werden reinvestiert.

Bei einem jährlich angegebenen Zinssatz wird für die monatliche Simulation ein entsprechender monatlicher Zinssatz abgeleitet.

## Datenschutz

Die Anwendung läuft vollständig lokal im Browser. Es werden keine Daten an einen Server übertragen. Die Eingaben werden optional über `localStorage` im verwendeten Browser gespeichert.

## Technologie

- HTML5
- CSS3
- Vanilla JavaScript
- HTML Canvas für die Diagramme
- Keine externen Bibliotheken oder Abhängigkeiten

## Hinweis

Der Rechner dient ausschließlich als mathematische Rechenhilfe. Die Ergebnisse basieren auf angenommenen Renditen und stellen keine Finanzberatung oder Prognose zukünftiger Erträge dar.
