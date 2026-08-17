# opencode-goal

Persistentes Ziel-Tracking für [OpenCode](https://opencode.ai): ein `/goal`
Slash-Command plus ein Plugin, das das aktive Ziel über Idle-Phasen hinweg
automatisch weiterverfolgt, statt dass der Agent einfach aufhört.

Beide Teile sind **global** installiert (gelten für jedes Projekt), aber der
Zielzustand selbst bleibt **pro Projekt** getrennt (`<projekt>/.opencode/goal-state.json`).

## Inhalt

```
opencode-goal/
├── plugin/goal-enforcer.ts   # OpenCode-Plugin: hört auf session.idle
├── command/goal.md           # /goal Slash-Command (Prompt-Template)
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

- **`/goal`** (ohne Argumente): zeigt das aktuelle Ziel + Status, oder
  fragt nach einem neuen Ziel, falls keins existiert.
- **`/goal <Text>`**: setzt ein neues Ziel, Agent beginnt sofort zu arbeiten.
- **`/goal pause`**: pausiert automatische Fortsetzungen.
- **`/goal resume`**: aktiviert das pausierte Ziel wieder.
- **`/goal clear`**: entfernt das Ziel vollständig.

Solange der Status `active` ist, schickt das Plugin bei jeder Idle-Phase der
Session eine Fortsetzungsnachricht, die den Agenten auffordert, weiter am
Ziel zu arbeiten oder es selbst als `"status": "done"` zu markieren, sobald
es wirklich erledigt ist.

## Konfiguration

| Env-Var | Default | Zweck |
|---|---|---|
| `GOAL_ENFORCER_MAX_NUDGES` | `8` | Max. Anzahl automatischer Fortsetzungen pro Session für dasselbe (unveränderte) Ziel, bevor das Plugin zur Vermeidung von Endlosschleifen von selbst aufhört. |

## Funktionsweise (kurz)

- Zustand: eine einzelne JSON-Datei `<projekt>/.opencode/goal-state.json`
  mit `{ "goal": string, "status": "active"|"paused"|"done", "started": string }`.
- Der Slash-Command (`command/goal.md`) ist ein reines Prompt-Template —
  er weist den Agenten an, diese Datei selbst über seine eigenen
  Read/Write/Bash-Tools zu lesen/schreiben, je nach `$ARGUMENTS`.
- Das Plugin (`plugin/goal-enforcer.ts`) hört auf das `session.idle`-Event,
  liest dieselbe Datei und ruft bei `status: "active"`
  `client.session.prompt(...)` auf, um eine Fortsetzungsnachricht in
  dieselbe Session zu schicken.
- Ein In-Memory-Zähler pro Session verhindert endlose Nudges, sobald
  `GOAL_ENFORCER_MAX_NUDGES` für ein unverändertes Ziel erreicht ist.
