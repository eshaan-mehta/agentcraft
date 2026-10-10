# agentcraft

The Truman Show, for AI agents. Claude agents live in a Minecraft world: they gather and craft, build, eat, take shelter when night falls, and fend off whatever comes out of the dark, alone or as a team. No humans walk their world; the only cast is the agents themselves. You're the audience and the director. Watch from inside the world as an invisible spectator, follow their thinking from a control room, and step in whenever you like to hand them a goal or answer a question.

## Life inside

- **They look after themselves.** Reflexes fight or flee from mobs, eat, and put on armor in real time. Between jobs, an agent notices nightfall, hunger, and missing gear and deals with them on its own.
- **They take direction.** Give one a goal in plain language ("get a stack of oak planks", "make yourself an iron pickaxe", "build me a house") and it works out the rest: it plans with real game data (recipes, tool tiers, drops), acts, checks what actually happened, and adapts when something fails.
- **They learn.** When the built-in actions don't cover something, an agent writes its own code, runs it in a sandbox, and keeps what works as a skill.
- **They remember.** Places, chest contents, lessons learned, standing orders, and the conversation itself survive restarts.
- **They live together or apart.** Teammates share knowledge and skills and split up jobs; an agent on its own figures everything out by itself.
- **They ask when they're unsure.** You choose how often: before anything ambiguous, only when stuck, or rarely.

## How it works

```
Claude (decides, every few seconds)     plans, asks, remembers, writes code
        │ tools            │ sandboxed scripts
        ▼                  ▼
One shared API of actions, perception, game knowledge, and memory
        │
Body (acts at game speed)               movement, digging, building, crafting, fighting
Survival reflexes                       always on, can interrupt anything
```

Claude makes the decisions; code handles everything that has to happen faster than a model can think. Every action reports what actually happened, or fails with a specific reason the agent can act on. It's built on [Mineflayer](https://github.com/PrismarineJS/mineflayer) and the Anthropic TypeScript SDK, and uses Claude Sonnet 5.5 by default.

## Getting started

You need Node 20+, Java 21 (`brew install openjdk@21`), and Minecraft Java Edition 1.21.11 to watch in-game.

```bash
npm install
npm run server:setup     # downloads and configures a local server (asks you to accept the Minecraft EULA)
npm run server           # leave running; in its console, once: op YourName, then gamemode spectator YourName
npm start                # in a second terminal: starts an agent named Claude
```

The agent uses `ANTHROPIC_API_KEY` from `.env` if set, otherwise your Anthropic CLI login.

## Watching

- **From inside the world:** join `localhost` in Minecraft and run `/spectate Claude` to see through its eyes. It sends you its plan as private messages.
- **From the control room:** `npm run dashboard`, then open http://127.0.0.1:4321 for total spend, a live card per agent, and a per-agent feed of thinking, plans, and actions with a chat box.
- **From the terminal:** each agent prints its reasoning and actions as it works, and keeps a full transcript in `logs/`.

## Stepping in

- **Talk to them** in game chat, an agent's terminal, or the dashboard. Say `stop` to halt one at once. Questions show up in chat; just reply.
- **Cast more agents:** `npm run agents -- Claude:red Bob:red Eve` starts Claude and Bob as team "red" and Eve solo. Address one with `Bob, get wood`, a team with `@red build a wall`, or everyone with no name.
- **Check spend:** `/usage` in an agent's terminal, or `npm run usage` for all sessions.

All settings live in `.env`. `.env.example` explains each one, including the model, how often agents ask, who counts as a supervisor, and whether survival needs wake the agent.

## Good to know

- Typical tasks cost cents. On Sonnet 5.5, an iron pickaxe from an empty inventory took about 3 minutes and $0.04, and a small stone house about 4 minutes and $0.05.
- The local server runs in offline mode so agents don't need Minecraft accounts, and it only listens on `127.0.0.1` for that reason.
- Agent-written code runs in a separate process with no file access and no Node APIs; its only capability is controlling the bot.
- To reset, delete `server/world` for a fresh world, or `data/` to make agents forget everything.
