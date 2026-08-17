# opencode-goal

Persistentes Ziel-Tracking für [OpenCode](https://opencode.ai): ein `/goal`
Slash-Command plus ein Plugin, das das aktive Ziel über Idle-Phasen hinweg
automatisch weiterverfolgt, statt dass der Agent einfach aufhört.

Beide Teile sind **global** installiert (gelten für jedes Projekt). Der
Zielzustand selbst ist **pro Session** getrennt: jede Session in einem
Projekt bekommt ihre eigene Datei unter
`<projekt>/.opencode/goal/<sessionID>.json`. Zwei parallele Sessions im
selben Projekt können damit zwei völlig unabhängige Ziele verfolgen, ohne
sich gegenseitig zu beeinflussen.

## Inhalt

```
opencode-goal/
├── plugin/goal-enforcer.ts   # OpenCode-Plugin: `goal`-Tool + session.idle-Hook
├── command/goal.md           # /goal Slash-Command (ruft nur das `goal`-Tool auf)
├── install.sh                # Installer für macOS/Linux
└── install.ps1                # Installer für Windows (PowerShell)
```

Nur native `@opencode-ai/plugin`-APIs + Node-Builtins (`fs`, `path`). Keine
weiteren Abhängigkeiten.

## Installation auf einem neuen Gerät

1. Repo klonen (privat, daher SSH oder ein Personal Access Token nötig):

   ```sh
   git clone <REPO-URL> ~/opencode-goal
   cd ~/opencode-goal
   ```

2. Installer ausführen:

   **macOS / Linux:**
   ```sh
   bash install.sh
   ```

   **Windows (PowerShell):**
   ```powershell
   .\install.ps1
   ```

   Das legt Symlinks an:
   - `~/.config/opencode/plugin/goal-enforcer.ts` → `<repo>/plugin/goal-enforcer.ts`
   - `~/.config/opencode/command/goal.md` → `<repo>/command/goal.md`

   Auf Windows benötigt das Anlegen von Symlinks entweder den
   **Entwicklermodus** (Einstellungen → Datenschutz & Sicherheit → Für
   Entwickler) oder eine **administrative PowerShell**. Falls das
   fehlschlägt, fällt der Installer automatisch auf eine normale Kopie
   zurück (oder erzwinge das direkt mit `.\install.ps1 -Copy` /
   `bash install.sh --copy`).

3. OpenCode neu starten (bzw. eine neue Session öffnen), damit das Plugin
   geladen wird.

Das war's — `/goal` ist jetzt in jedem Projekt auf diesem Gerät verfügbar.

## Update

Bei **Symlink-Installation** (Default) reicht auf jedem Gerät:

```sh
git pull
```

— die global verlinkten Dateien zeigen direkt auf den Repo-Checkout, ein
Neustart von OpenCode genügt.

Bei **Copy-Installation** (`-Copy` / `--copy`) muss nach jedem `git pull`
der Installer erneut ausgeführt werden.

## Deinstallation

```sh
rm ~/.config/opencode/plugin/goal-enforcer.ts
rm ~/.config/opencode/command/goal.md
```

(unter Windows: `Remove-Item` auf die entsprechenden Pfade unter
`$env:USERPROFILE\.config\opencode\...`)

## Verwendung

```
/goal Refactor das Auth-Modul und schreibe Tests dafür
```

- **`/goal`** (ohne Argumente): zeigt das aktuelle Ziel *dieser Session* +
  Status, oder fragt nach einem neuen Ziel, falls keins existiert.
- **`/goal <Text>`**: setzt ein neues Ziel für *diese Session*, Agent
  beginnt sofort zu arbeiten.
- **`/goal pause`**: pausiert automatische Fortsetzungen für diese Session.
- **`/goal resume`**: aktiviert das pausierte Ziel dieser Session wieder.
- **`/goal clear`**: entfernt das Ziel dieser Session vollständig.

Jede Session hat ihr **eigenes** Ziel — `/goal` in Session A wirkt sich
nicht auf Session B im selben Projekt aus, selbst wenn beide gleichzeitig
laufen. Solange der Status einer Session `active` ist, schickt das Plugin
bei jeder Idle-Phase *dieser* Session eine Fortsetzungsnachricht, die den
Agenten auffordert, weiter am Ziel zu arbeiten oder es selbst per
`goal`-Tool (`{ "action": "complete" }`) als erledigt zu markieren.

## Konfiguration

| Env-Var | Default | Zweck |
|---|---|---|
| `GOAL_ENFORCER_MAX_NUDGES` | `8` | Max. Anzahl automatischer Fortsetzungen pro Session für dasselbe (unveränderte) Ziel, bevor das Plugin zur Vermeidung von Endlosschleifen von selbst aufhört. |

## Funktionsweise (kurz)

- Zustand: eine JSON-Datei **pro Session** unter
  `<projekt>/.opencode/goal/<sessionID>.json` mit
  `{ "goal": string, "status": "active"|"paused"|"done", "started": string }`.
- Das Plugin registriert ein Tool namens **`goal`** mit den Aktionen `set`,
  `show`, `pause`, `resume`, `clear`, `complete`. Nur dieses Tool liest/
  schreibt die Zustandsdatei — es kennt über `context.sessionID` und
  `context.directory` immer automatisch die richtige, zur aufrufenden
  Session gehörende Datei.
- Der Slash-Command (`command/goal.md`) ist ein reines Prompt-Template: er
  übersetzt `$ARGUMENTS` in die passende `goal`-Tool-Aktion und ruft das
  Tool auf — er liest/schreibt selbst keine Dateien.
- Der `event`-Hook im Plugin hört auf `session.idle`, liest die
  Zustandsdatei *der jeweils idle gewordenen Session* und ruft bei
  `status: "active"` `client.session.prompt(...)` auf, um eine
  Fortsetzungsnachricht in genau diese Session zu schicken.
- Ein In-Memory-Zähler pro Session verhindert endlose Nudges, sobald
  `GOAL_ENFORCER_MAX_NUDGES` für ein unverändertes Ziel erreicht ist.

## Migration von der alten Version (Ziel pro Projekt)

Frühere Versionen dieses Repos speicherten ein einziges Ziel pro Projekt in
`.opencode/goal-state.json` und lasen/schrieben es direkt per Read/Write-Tool.
Das wird nicht mehr gelesen — vorhandene `.opencode/goal-state.json`-Dateien
kannst du gefahrlos löschen, sie haben keine Wirkung mehr. Setze Ziele
danach einfach neu mit `/goal <Text>`; sie landen automatisch in der neuen,
session-spezifischen Struktur unter `.opencode/goal/<sessionID>.json`.
