# agentcraft

An autonomous Claude agent that lives in a Minecraft world. You supervise as an invisible spectator and give it instructions in chat ("get a stack of oak planks", "make yourself an iron pickaxe", "build me a house"). It plans, uses real game data, acts through a set of reliable primitives, writes its own code for anything new, asks you when it's stuck, and remembers what it learns. It also keeps itself alive: it fights or flees from mobs, eats, and shelters at night.

Built on [Mineflayer](https://github.com/PrismarineJS/mineflayer) (a Node.js Minecraft client) and the Anthropic TypeScript SDK, using Claude Sonnet 5.5 by default.

## Quickstart

You need Node 20+, Java 21 (`brew install openjdk@21`), and Minecraft Java Edition **1.21.11** if you want to watch in-game.

```bash
npm install

# 1. Download and configure a local Minecraft server (asks you to accept the Minecraft EULA)
npm run server:setup

# 2. Start it (leave this terminal open; it's the server console). Then, once:
npm run server
#    op YourMinecraftName                 <- lets you use commands in game
#    gamemode spectator YourMinecraftName <- you'll always join as an invisible spectator

# 3. In a second terminal, start the agent
npm start
```

For credentials, the SDK uses `ANTHROPIC_API_KEY` if it's set, or else an Anthropic CLI login (`ant auth login`). To use a key, copy `.env.example` to `.env` and fill it in.

Then open Minecraft 1.21.11 (in Prism Launcher, create an instance for that version) and go to **Multiplayer → Direct Connection → `localhost`**. Run `/spectate Claude` to watch from the bot's eyes, or `/spectate` with no target to fly freely.

## Supervising

- **Give instructions** in game chat or by typing in the agent's terminal. Set `SUPERVISORS=YourMinecraftName` so only you can.
- **`stop`** halts it immediately, without waiting for Claude.
- **Mid-task messages** reach Claude between steps (e.g. `use birch instead`).
- **Questions:** when it asks one, it appears in chat and the terminal; just reply. If you don't answer within `ASK_TIMEOUT_MINUTES`, it carries on with its best judgment and says what it assumed.
- **Standing orders** ("never cut the trees near the house") are saved in its memory and shown to it at the start of every task.
- **Its plan of action** comes to you as private messages in game (gray italics, apart from normal chat): the full plan when it starts a task, then short updates as steps finish or get blocked, with a note when its thinking changes:

  ```
  Claude whispers to you: [plan] Make an iron pickaxe
  Claude whispers to you: [plan] 1[>] Get logs  2[ ] Wooden pickaxe  3[ ] Stone pickaxe  4[ ] Mine iron  5[ ] Smelt + craft
  Claude whispers to you: [plan] done: Get logs | now: Wooden pickaxe
  Claude whispers to you: [plan] blocked: Mine iron | No iron within 64 blocks; exploring east
  Claude whispers to you: [plan] Finished: Make an iron pickaxe
  ```

  Its detailed reasoning (`💭` lines) stays in the terminal. Turn the chat updates off with `PLAN_IN_CHAT=off`.

Terminal commands: `/stop`, `/ask often|stuck|rarely` (change the ask mode live), `/plan`, `/skills`, `/memory`, `/usage` (tokens and cost), `/reset` (forget the conversation; memory and skills are kept), `/quit`.

For token usage and estimated cost across every session, run `npm run usage`, or open the [dashboard](#dashboard).

**Restarting keeps the conversation.** It's saved to `data/conversation.json` after every step and resumed when the agent starts, so you can stop it (Ctrl+C) and start it again, including after a code update, without losing context. If there's nothing to resume, the agent instead gets a condensed log of its previous session with its next message. `/reset` clears the conversation and the saved copy; `RESUME_SESSION=off` always starts fresh.

### What you see in the terminal

```
📩 <console> make yourself an iron pickaxe
🔧 lookup {"name":"iron_pickaxe","count":1}
  ✓ Plan for 1 iron_pickaxe: still need 3 raw_iron (mine iron_ore, needs stone_pickaxe or better); 1 oak_log ...
🔧 gather {"block":"oak_log","count":6}
  ✓ {"mined":6,"wanted":6,"change":"+6 oak_log"} (23.6s)
🔧 craft {"item":"wooden_pickaxe"}
  ✓ {"steps":["crafted 8 oak_planks","crafted 4 stick","crafted 1 wooden_pickaxe"],"setup":["placed a crafting_table at 415 64 423"]}
...
💬 I crafted an iron pickaxe; it's in my inventory. The furnace is at 413 62 418.
Σ 14542 in (14374 cached) · 109 out · ≈$0.004 (session ≈$0.09)
```

`📋` lines are the current plan, `📜` lines are scripts it writes (shown in full), `┊` lines are their output, `❓` lines are questions, and `◆` lines are survival reflexes and game events. Every session is also saved to `logs/session-*.jsonl`.

## Multiple agents

Run several agents in the same world, from one terminal:

```bash
npm run agents -- Claude:red Bob:red Eve     # name[:team]; leave the team off to work alone
npm run agents                               # or list them in agents.json (see agents.example.json)
```

`agents.json` can also set a per-agent `model`, `effort`, and `askMode`.

| | Same team | Alone |
|---|---|---|
| Memory (places, chest contents, notes, standing orders) | Shared (`data/teams/<team>/`) | Its own (`data/agents/<name>/`) |
| Saved skills | Shared: a skill one saves, the others can use right away | Its own: it figures everything out itself |
| Conversation and logs | Its own (`data/agents/<name>/`, `logs/<name>/`) | Its own |
| Talking to the others | `message_teammate` to split up work | Doesn't coordinate; knows the others exist and leaves their things alone |

**Addressing them:**
- In game chat: `Bob, get wood` (or `Bob: ...` / `@Bob ...`) goes to Bob only; `@red build a wall` goes to team red; `all, ...` or a message with no name goes to every agent. Each agent is told who the message was addressed to, so teammates given the same job agree on who does what.
- `/msg Bob ...` goes to Bob only.
- In the launcher terminal: `@Bob ...`, `@red ...`, `@all ...`, or no `@` for everyone. That includes commands like `@Bob /usage`. `/quit` stops them all.

Agents never take each other's chat or private messages as instructions, even without `SUPERVISORS` set. Teammate messages that need an answer wake the recipient; FYIs wait for its next turn, and a cap keeps two agents from talking each other into an expensive loop. Each agent runs in its own process, so one agent's pathfinding never slows another, and shared memory and skill files are locked during writes so teammates never lose each other's updates.

Each agent costs about the same as one agent alone; `npm run usage` and the [dashboard](#dashboard) break usage down per agent.

## Dashboard

A local web page for watching your agents and talking to them. In its own terminal:

```bash
npm run dashboard        # then open http://127.0.0.1:4321
```

It works with `npm start` and `npm run agents`, whether it starts before or after them, and also shows agents that aren't running, from their past transcripts.

- **Home:** what you've spent, all time and today, with token totals, and a card per agent: running or not, team, model, cost (all time, today, this session), requests, the plan step it's on, health and food, and when it last did something.
- **Agent view** (click a card): its status, costs, and plan at the top. On the left, the conversation: your messages, its replies, messages to and from teammates, and its questions, highlighted while it waits for your answer. Messages you send there reach it as if you'd typed them in its terminal, so commands like `/plan` and `/usage` work too, and **Stop** halts it right away. On the right, a live feed of its thinking, plan updates, tool calls (click one for the input and result), scripts with their output, reflexes and other game events, and errors, with filters. The feed and chat follow new activity unless you've scrolled up.

Each running agent writes its live status to `runtime/agents/<name>.json` every two seconds and reads dashboard messages from `runtime/agents/<name>.inbox.jsonl`; costs and history come from the transcripts in `logs/`. The dashboard only listens on 127.0.0.1 and only accepts requests from its own page, so nothing else can see it or talk to your agents through it. Costs are estimates, as with `npm run usage`.

## Ask modes

`ASK_MODE` in `.env`, or `/ask` live:

| Mode | Behavior |
|---|---|
| `often` | Asks about any detail that matters before starting, before anything destructive or long, and whenever an approach fails |
| `stuck` (default) | Proceeds with sensible defaults and says what it assumed; asks after two different approaches fail, or before something destructive or very long |
| `rarely` | Works things out alone and asks only when truly blocked |

## Architecture

```
brain/      Claude: plans, decides, asks, learns                  (seconds)
              tools ─┐                    ┌─ scripts Claude writes (sandboxed JS)
                     ▼                    ▼
api.ts      one table of every capability (the single implementation)
skills/     built-in skills + skills Claude saved
body/       motor primitives, navigator, body controller           (every 50 ms)
world/      perception, game knowledge, memory
survival/   reflexes (code) and survival alerts to the brain
```

### Primitives

| Layer | What's there |
|---|---|
| **Motor** (`body/motor.ts`) | `goTo` (a position, a column, within reach of a block, an entity, away from something, a saved place), `dig` (with pickup), `place`, `useBlock` (right-click a block, optionally holding an item: doors, levers, hoes, seeds, bone meal, buckets), `useItem` (click or hold: bow, shield, throwables), `equip`, `toss`, `eat`, `attack`, `fight`, `interact` (right-click a mob: shear, milk, breed, trade), `mount`, raw key `controls`, `craft`, `smelt`, `container`, `sleep`, `collectDrops` |
| **Perception** (`world/perception.ts`) | `status`, `inventory`, `blockAt` (with state: crop age, door open, facing), `findBlocks`, `findEntities` (by kind, with ids), `scanSurface` / `scanLayer` (text maps for terrain and building), `canReach` (plan a route without moving) |
| **Knowledge** (`world/knowledge.ts`) | `recipes`, `howToObtain` (craft / smelt / mine with which tool / mob drop, from minecraft-data), `materials` (from the current inventory: the steps in order and the raw materials still needed), `info` |
| **Memory** (`world/memory.ts`, `data/memory.json`) | Named places, chest contents (recorded whenever a chest is opened), notes and lessons, standing orders |
| **Skills** (`skills/`) | Built in: `gather` (also accepts items: "cobblestone" mines stone), recursive `craft` (makes intermediates, sets up a crafting table or furnace), `smelt`, `buildShelter`, `explore`, `hunt`. Plus skills Claude saved in `data/skills/` |
| **Decision-making** (`brain/`) | `update_plan`, `ask_supervisor`, `report`, `lookup`, `remember` / `recall`, `run_code`, `save_skill` / `run_skill` / `list_skills` |

### How it stays robust

- **One owner of the body** (`body/body.ts`). Actions take a lease. Reflexes outrank tasks and interrupt them cleanly, and releasing a lease always leaves the bot stopped, so one action can't sabotage the next.
- **A navigator that doesn't give up early** (`body/navigation.ts`). It follows partial routes and replans from wherever they end. It fails only on a real "no route" or 15 seconds without progress, and says where it got to.
- **Structured outcomes.** Every action reports what changed, or fails with a code (`UNREACHABLE`, `STUCK`, `MISSING_ITEMS`, `MISSING_TOOL`, `BLOCKED`, `NOT_FOUND`, `TIMEOUT`) and a message Claude can act on.
- **Facts from data, not memory.** Recipes, tool tiers, and drops come from minecraft-data, so plans start out right.
- **Composition instead of a fixed menu.** For anything the tools don't cover, Claude writes JavaScript against the same API (a 300-call building script runs in about 90 seconds). Scripts that work can be saved as skills that persist and can call each other.

### The sandbox

Scripts run in a separate Node process started with Node's permission model: no file access beyond the worker script itself, no child processes, no worker threads. Inside, the code runs in a `vm` context with no Node globals (`process`, `require`, `fetch`), and `eval` / `new Function` are disabled. Only plain strings cross the boundary, so there's no object to escape through. The only capability is `api`, whose calls the parent executes on the bot. Actions that move the bot run one at a time. Scripts have a time limit (`MAX_SCRIPT_SECONDS`) and stop instantly on `stop` or when a reflex takes over. Network access isn't blocked at the process level, but scripts have no way to reach it.

## Survival

**Reflexes** run in plain code every half second, with no API calls:

- **Fight** hostile mobs within 10 blocks, and anything that hits it from up to 24 blocks away.
- **Run** from creepers (within 12 blocks) and wardens, when health is low, when unarmed, or when several mobs close in. If running fails, it fights instead.
- **Eat** when hunger reaches 14/20.
- **Put on** better armor from its inventory.
- **Stay afloat** in water.
- **Never break out** of a shelter.

**Survival turns** wake Claude for needs that take planning: shortly before sunset, at night in the open, in the morning after sheltering, when hungry with no food, after a death, and when idle while missing a weapon, food, or shelter blocks. They cost tokens, so `SURVIVAL_AUTONOMY=off` keeps only the reflexes.

## Configuration

Set these in `.env` (see `.env.example`):

| Variable | Default | |
|---|---|---|
| `AGENT_MODEL` | `claude-sonnet-5-5` | Claude model (`claude-opus-5-5` for harder reasoning at about twice the price) |
| `AGENT_EFFORT` | `medium` | `low` / `medium` / `high` / `xhigh` / `max`. Higher thinks harder per step, but is slower and costs more |
| `ASK_MODE` | `stuck` | `often` / `stuck` / `rarely` |
| `ASK_TIMEOUT_MINUTES` | `5` | How long a question waits for your answer |
| `SUPERVISORS` | (anyone) | Comma-separated names whose chat counts as instructions |
| `PLAN_IN_CHAT` | `on` | Send you its plan and plan changes as private messages in game |
| `RESUME_SESSION` | `on` | Resume the saved conversation on restart |
| `SURVIVAL_AUTONOMY` | `on` | `off` keeps reflexes but stops survival needs from waking Claude |
| `MAX_SCRIPT_SECONDS` | `300` | Longest a script may run |
| `MC_HOST`, `MC_PORT`, `MC_VERSION` | `127.0.0.1`, `25565`, `1.21.11` | Server to join |
| `BOT_USERNAME`, `MC_AUTH` | `Claude`, `offline` | Use `MC_AUTH=microsoft` to join online-mode servers with the bot's own account |
| `DATA_DIR`, `LOG_DIR` | `data`, `logs` | Memory and saved skills; session transcripts |
| `RUNTIME_DIR` | `runtime` | Where running agents publish their status for the dashboard and read messages from it |
| `DASHBOARD_PORT` | `4321` | Port for `npm run dashboard` (on 127.0.0.1 only) |

## Extending

- **A new primitive or built-in skill:** add a method in `src/api.ts` (it becomes available to scripts immediately). If Claude should call it directly, add a tool in `src/brain/tools.ts`. Throw `ActionError(code, message)` for expected failures.
- **Let Claude grow its own abilities:** it saves working scripts with `save_skill`. Saved skills are plain files in `data/skills/` that you can read or edit.

## Notes

- The local server runs in **offline mode** so the bot doesn't need its own Minecraft account. That also means anyone who can reach it could join under any name, so it only listens on `127.0.0.1`.
- Spawn protection is off so the bot can dig near spawn.
- To start over with a fresh world, stop the server and delete `server/world`. To make the bot forget everything, delete `data/`.
- In testing on Sonnet 5.5, "make yourself an iron pickaxe" from an empty inventory took about 3 minutes and $0.04, and a 5×5 cobblestone house about 4 minutes and $0.05. Long tasks cost more; check `/usage`.
