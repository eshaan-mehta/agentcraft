# agentcraft

Autonomous Claude agents that live in a Minecraft world. You give them goals in plain language ("get a stack of oak planks", "make yourself an iron pickaxe", "build me a house") and they work out the rest: they plan, act, check their results, adapt when something fails, and ask you when they're stuck. They also look after themselves, so they survive the night on their own. You supervise as an invisible spectator, and can run one agent or a whole team.

## What it does

- **Understands open-ended goals.** Agents plan with real game data (recipes, tool tiers, drops) instead of guessing, then carry out the plan with reliable built-in actions.
- **Learns new abilities.** For anything the built-in actions don't cover, an agent writes its own code, runs it in a sandbox, and saves what works as a skill it can reuse later.
- **Remembers.** Places, chest contents, lessons learned, and your standing orders persist across sessions, and so does the conversation itself.
- **Asks when it should.** You choose how often: before anything ambiguous, only when stuck, or rarely.
- **Survives on its own.** Reflexes fight or flee from mobs, eat, and wear armor in real time; the agent itself plans for nightfall, hunger, and shelter.
- **Works in teams.** Run several agents at once. Teammates share knowledge and skills and split up jobs; agents on their own figure everything out independently.
- **Shows its work.** A local dashboard shows what each agent is thinking and doing and what it's spending, and lets you chat with it.

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

The agent uses `ANTHROPIC_API_KEY` from `.env` if set, otherwise your Anthropic CLI login. In Minecraft, join `localhost` and run `/spectate Claude` to watch through its eyes.

## Using it

- **Talk to it** in game chat, in its terminal, or from the dashboard. Say `stop` to halt it at once. It sends you its plan as private messages in game, and questions show up in chat; just reply.
- **Run a team:** `npm run agents -- Claude:red Bob:red Eve` starts Claude and Bob as team "red" and Eve on her own. Address one with `Bob, get wood`, a team with `@red build a wall`, or everyone with no name.
- **Watch and chat:** `npm run dashboard`, then open http://127.0.0.1:4321 for total spend, a live card per agent, and a per-agent view with chat and a feed of its thinking, plans, and actions.
- **Check spend:** `/usage` in an agent's terminal, or `npm run usage` for all sessions.

All settings live in `.env`. `.env.example` explains each one, including the model, how often agents ask, who counts as a supervisor, and whether survival needs wake the agent.

## Good to know

- Typical tasks cost cents. On Sonnet 5.5, an iron pickaxe from an empty inventory took about 3 minutes and $0.04, and a small stone house about 4 minutes and $0.05.
- The local server runs in offline mode so agents don't need Minecraft accounts, and it only listens on `127.0.0.1` for that reason.
- Agent-written code runs in a separate process with no file access and no Node APIs; its only capability is controlling the bot.
- To reset, delete `server/world` for a fresh world, or `data/` to make agents forget everything.
